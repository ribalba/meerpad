"""Files on disk: where uploads live and how they are served.

Stored under ``upload_dir/<first two chars>/<uuid>`` so no single directory
grows unbounded. The original name only ever lives in the database. A HEIC
photo is stored as WebP instead (app/images.py).
"""

import hashlib
import logging
import mimetypes
import uuid
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session as DBSession

from . import images
from .config import get_settings
from .models import File

settings = get_settings()
log = logging.getLogger(__name__)

# Served inline (the browser shows them). Everything else downloads.
INLINE_TYPES = ("image/", "video/", "audio/", "application/pdf", "text/plain")


def path_for(stored_name: str) -> Path:
    return settings.upload_dir / stored_name[:2] / stored_name


def store_chunks(chunks: Iterable[bytes], max_bytes: int | None = None) -> tuple[str, int, str]:
    """Write chunks to a new stored file. Returns (stored_name, size, sha256).
    Raises 413 (and leaves nothing behind) past ``max_bytes``."""
    limit = max_bytes or settings.max_upload_bytes
    stored_name = uuid.uuid4().hex
    path = path_for(stored_name)
    path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    try:
        with open(path, "wb") as fh:
            for chunk in chunks:
                size += len(chunk)
                if size > limit:
                    raise HTTPException(status_code=413, detail=f"File is larger than {limit // (1024 * 1024)} MB")
                digest.update(chunk)
                fh.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return stored_name, size, digest.hexdigest()


def clean_filename(name: str | None, content_type: str | None = None) -> str:
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1].strip().strip(".") or "file"
    name = "".join(ch for ch in name if ch >= " " and ch not in '<>:"|?*')[:200] or "file"
    if "." not in name and content_type:
        ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) or ""
        name += ext
    return name


def guess_type(filename: str, given: str | None) -> str:
    given = (given or "").split(";")[0].strip().lower()
    if given and given != "application/octet-stream":
        return given
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"


def create_file(
    db: DBSession,
    owner_id: str,
    chunks: Iterable[bytes],
    filename: str | None,
    content_type: str | None,
    page_id: str | None = None,
    source_url: str | None = None,
    max_bytes: int | None = None,
) -> File:
    name = clean_filename(filename, content_type)
    stored_name, size, sha = store_chunks(chunks, max_bytes)
    ctype = guess_type(name, content_type)
    try:
        webp = webp_of_heic(stored_name)
    except Exception as exc:  # noqa: BLE001 - a HEIC that does not decode is kept as it came
        log.warning("%s stays HEIC: %s", name, exc)
        webp = None
    if webp is not None:
        path_for(stored_name).unlink(missing_ok=True)
        stored_name, size, sha = webp
        name, ctype = images.webp_name(name), "image/webp"
    row = File(
        id=str(uuid.uuid4()),
        owner_id=owner_id,
        page_id=page_id,
        filename=name,
        stored_name=stored_name,
        content_type=ctype,
        size=size,
        sha256=sha,
        source_url=source_url,
    )
    db.add(row)
    db.flush()
    return row


def webp_of_heic(stored_name: str) -> tuple[str, int, str] | None:
    """A WebP of a stored file that is HEIC, as a new stored file:
    (stored_name, size, sha256). None when the file is not HEIC; raises
    images.ConvertError when it is but does not decode."""
    src = path_for(stored_name)
    with open(src, "rb") as fh:
        if not images.is_heic(fh.read(images.SNIFF_BYTES)):
            return None
    new_name = uuid.uuid4().hex
    dest = path_for(new_name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    try:
        images.heic_to_webp(src, dest)
        with open(dest, "rb") as fh:
            while chunk := fh.read(1024 * 1024):
                digest.update(chunk)
        size = dest.stat().st_size
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return new_name, size, digest.hexdigest()


def webp_copy(db: DBSession, f: File) -> File:
    """A WebP of a stored HEIC file (one from before uploads were converted),
    as a new file of the same owner and page. The HEIC stays: undo and the
    page's history still point at it, and it goes with its page like any
    other file of the page."""
    if not path_for(f.stored_name).exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    try:
        webp = webp_of_heic(f.stored_name)
    except images.ConvertError as exc:
        log.warning("file %s does not convert: %s", f.id, exc)
        raise HTTPException(status_code=422, detail="This HEIC image could not be read, so it was not converted")
    if webp is None:
        raise HTTPException(status_code=422, detail="Only HEIC images can be converted to WebP")
    stored_name, size, sha = webp
    row = File(
        id=str(uuid.uuid4()),
        owner_id=f.owner_id,
        page_id=f.page_id,
        filename=images.webp_name(f.filename),
        stored_name=stored_name,
        content_type="image/webp",
        size=size,
        sha256=sha,
        source_url=f.source_url,
    )
    db.add(row)
    db.flush()
    return row


def file_url(f: File) -> str:
    return f"/api/files/{f.id}/{quote(f.filename)}"


def file_out(f: File) -> dict:
    return {"id": f.id, "filename": f.filename, "content_type": f.content_type, "size": f.size, "url": file_url(f)}


def file_response(f: File, download: bool = False) -> FileResponse:
    """Serve a stored file. Anything that is not plainly media downloads rather than
    renders, and everything is sandboxed: an uploaded SVG or HTML file must never
    run script on the app's origin."""
    path = path_for(f.stored_name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    ctype = f.content_type or "application/octet-stream"
    inline = not download and ctype.startswith(INLINE_TYPES)
    headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400"}
    if ctype != "application/pdf":
        # Chrome refuses to run its PDF viewer in a sandboxed document.
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'"
    return FileResponse(
        path,
        media_type=ctype,
        filename=f.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers=headers,
    )
