"""Files: uploads (drag and drop, paste), downloads, fetching a pasted URL, and
turning a HEIC photo into a WebP one.

Files are not part of offline sync: a block refers to one by id
(``props.file_id``) and the browser fetches it on demand, which the service
worker then caches for offline reading.
"""

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session as DBSession

from ..config import get_settings
from ..database import DB
from ..fetcher import FetchError, download, head, kind_of
from ..models import File as FileRow
from ..models import Page
from ..schemas import FetchUrlRequest, FileOut, ProbeOut
from ..security import CurrentUser, OptionalUser
from ..services import get_owned_page, resolve_share
from ..storage import create_file, file_out, file_response, webp_copy

router = APIRouter(prefix="/api/files", tags=["files"])
settings = get_settings()


def _page_for_upload(db: DBSession, page_id: str | None, user) -> str | None:
    """The page a new file belongs to. A page the server has not seen yet is
    fine: files are dropped into brand-new pages whose create is still in the
    sync queue. Only someone else's page is refused. (The share and site checks
    also compare the file's owner with the page's, so naming a page id that
    later turns up in another account grants nothing.)"""
    if not page_id:
        return None
    if len(page_id) > 36:
        raise HTTPException(status_code=422, detail="Invalid page id")
    page = db.get(Page, page_id)
    if page is None:
        return page_id
    return get_owned_page(db, page_id, user).id


@router.post("", response_model=FileOut)
def upload(
    file: Annotated[UploadFile, File()],
    db: DB,
    user: CurrentUser,
    page_id: Annotated[str | None, Form()] = None,
):
    pid = _page_for_upload(db, page_id, user)

    def chunks():
        while chunk := file.file.read(1024 * 1024):
            yield chunk

    row = create_file(db, user.id, chunks(), file.filename, file.content_type, page_id=pid)
    db.commit()
    return file_out(row)


@router.get("/probe", response_model=ProbeOut)
def probe(url: Annotated[str, Query(max_length=4000)], user: CurrentUser):
    """What a pasted link points at, so the editor can offer to download it."""
    try:
        h = head(url)
    except FetchError as exc:
        return ProbeOut(ok=False, url=url, kind=kind_of(None, url), detail=str(exc))
    return ProbeOut(
        ok=h.status < 400,
        url=h.url,
        kind=kind_of(h.content_type, h.url),
        content_type=h.content_type,
        filename=h.filename,
        size=h.size,
        detail=None if h.status < 400 else f"The server answered {h.status}",
    )


@router.post("/fetch", response_model=FileOut)
def fetch(payload: FetchUrlRequest, db: DB, user: CurrentUser):
    """Download a URL into the account's files (the "download and add" choice
    offered when a link to an image or PDF is pasted)."""
    pid = _page_for_upload(db, payload.page_id, user)
    try:
        final, ctype, name, chunks = download(payload.url, settings.max_upload_bytes)
    except FetchError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    try:
        row = create_file(db, user.id, chunks, name, ctype, page_id=pid, source_url=final)
    except FetchError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - a connection dropped mid-body
        raise HTTPException(status_code=422, detail=f"Download failed ({type(exc).__name__})")
    db.commit()
    return file_out(row)


@router.post("/{file_id}/webp", response_model=FileOut)
def convert_to_webp(file_id: str, db: DB, user: CurrentUser):
    """A WebP copy of a HEIC file, for a block that holds one from before
    uploads were converted (app/images.py). The block is then pointed at the
    copy by the client, through sync, like any other edit."""
    f = db.get(FileRow, file_id)
    if f is None or f.owner_id != user.id:
        raise HTTPException(status_code=404, detail="File not found")
    row = webp_copy(db, f)
    db.commit()
    return file_out(row)


def _readable(db: DBSession, f: FileRow, user, share: str | None) -> bool:
    if user is not None and f.owner_id == user.id:
        return True
    if share:
        grant = resolve_share(db, share)
        return f.owner_id == grant.page.owner_id and f.page_id is not None and grant.covers(f.page_id)
    return False


@router.get("/{file_id}")
@router.get("/{file_id}/{filename}")
def get_file(
    file_id: str,
    db: DB,
    user: OptionalUser,
    filename: str | None = None,
    share: Annotated[str | None, Query(max_length=64)] = None,
    download: bool = False,
):
    f = db.get(FileRow, file_id)
    if f is None or not _readable(db, f, user, share):
        raise HTTPException(status_code=404, detail="File not found")
    return file_response(f, download=download)
