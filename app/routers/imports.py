"""Notion import over HTTP: upload an export, import it in the background, poll it.

``POST /api/import/notion`` streams the upload straight into IMPORT_DIR. A
workspace export with every attachment can run to gigabytes, so it is never
buffered in memory or in the request spool (which also has no size cap): the
multipart body is parsed as it arrives and the cap applies while it streams.
The request then records an ``Import`` row and hands the file to a background
thread running app/notion_import.py. The app's import dialog and
tools/notion_import.py poll ``GET /api/import/{id}`` for progress.

A running import writes its progress into ``stats`` every few seconds, which
doubles as a heartbeat. An import left queued or running by a process that is
gone (a restart or redeploy mid-import) is failed at startup by
``resume_pending``, and one whose heartbeat stopped for any other reason is
failed when it is read, so nothing stays "running" forever.
"""

import logging
import re
import threading
import uuid
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote_to_bytes

from fastapi import APIRouter, HTTPException, Request
from python_multipart.exceptions import FormParserError
from python_multipart.multipart import MultipartParser, parse_options_header
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..database import DB, SessionLocal
from ..models import Import, Page, User, Workspace, utcnow
from ..notion_import import ImportFailed, import_notion
from ..security import SessionOrTokenUser, new_id
from ..serialize import iso
from ..services import PageTree
from ..storage import clean_filename

router = APIRouter(prefix="/api/import", tags=["import"])
settings = get_settings()
log = logging.getLogger("uvicorn.error")

HEARTBEAT_SECONDS = 5
STALE_AFTER = timedelta(seconds=90)
MAX_FIELD_BYTES = 4096
MAX_FIELDS = 20
INTERRUPTED = "Interrupted by a server restart; please import again"

# Held while checking "no other import running" and inserting the new one, so
# two uploads finishing at the same moment cannot both start.
_start_lock = threading.Lock()


def import_out(imp: Import) -> dict:
    stats = {k: v for k, v in (imp.stats or {}).items() if k != "heartbeat"}
    return {
        "id": imp.id,
        "status": imp.status,
        "stats": stats,
        "error": imp.error,
        "source_name": imp.source_name,
        "parent_page_id": imp.parent_page_id,
        "workspace_id": imp.workspace_id,
        "created_at": iso(imp.created_at),
        "finished_at": iso(imp.finished_at),
    }


def _stale(imp: Import, now: datetime) -> bool:
    if imp.status not in ("queued", "running"):
        return False
    beat = (imp.stats or {}).get("heartbeat")
    try:
        last = datetime.fromisoformat(beat) if beat else imp.created_at
    except (TypeError, ValueError):
        last = imp.created_at
    return last is None or now - last > STALE_AFTER


def _fail(imp: Import, message: str) -> None:
    imp.status = "error"
    imp.error = message
    imp.finished_at = utcnow()
    imp.stats = {k: v for k, v in (imp.stats or {}).items() if k != "heartbeat"}


def _expire_if_stale(db: DBSession, imp: Import) -> None:
    if _stale(imp, utcnow()):
        _fail(imp, INTERRUPTED)
        db.commit()


def resume_pending() -> None:
    """At startup: whatever a previous process left queued or running died with
    it (the import thread lives in the server process)."""
    with SessionLocal() as db:
        for imp in db.scalars(select(Import).where(Import.status.in_(("queued", "running")))).all():
            _fail(imp, INTERRUPTED)
        db.commit()


# --- Receiving the upload -------------------------------------------------------------


class _Upload:
    """python-multipart callbacks: the ``file`` part goes to disk as it arrives,
    small text fields (``workspace_id``, ``parent_page_id``) are kept."""

    def __init__(self, limit: int):
        self.limit = limit
        self.fields: dict[str, str] = {}
        self.filename: str | None = None
        self.size = 0
        self.pending: list[bytes] = []
        self.error: HTTPException | None = None
        self._hname = b""
        self._hvalue = b""
        self._headers: dict[str, bytes] = {}
        self._name = ""
        self._is_file = False
        self._buf = bytearray()

    def callbacks(self) -> dict:
        return {
            "on_part_begin": self.on_part_begin,
            "on_header_field": self.on_header_field,
            "on_header_value": self.on_header_value,
            "on_header_end": self.on_header_end,
            "on_headers_finished": self.on_headers_finished,
            "on_part_data": self.on_part_data,
            "on_part_end": self.on_part_end,
        }

    def on_part_begin(self) -> None:
        self._headers, self._name, self._is_file, self._buf = {}, "", False, bytearray()

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self._hname += data[start:end]

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self._hvalue += data[start:end]

    def on_header_end(self) -> None:
        self._headers[self._hname.decode("latin-1").lower()] = self._hvalue
        self._hname, self._hvalue = b"", b""

    def on_headers_finished(self) -> None:
        raw = self._headers.get("content-disposition", b"")
        _, opts = parse_options_header(raw)
        self._name = opts.get(b"name", b"").decode("utf-8", "replace")
        filename = opts.get(b"filename")
        if filename is None:
            # RFC 5987 (filename*=UTF-8''Export%20x.zip), which the parser skips.
            m = re.search(rb"filename\*\s*=\s*[^']*'[^']*'([^;\s]+)", raw)
            if m:
                filename = unquote_to_bytes(m.group(1))
        if self._name == "file" and filename is not None and self.filename is None:
            self._is_file = True
            self.filename = filename.decode("utf-8", "replace")

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if self.error is not None:
            return
        if self._is_file:
            self.size += end - start
            if self.size > self.limit:
                limit_mb = self.limit // (1024 * 1024)
                self.error = HTTPException(status_code=413, detail=f"The export is larger than {limit_mb} MB")
                return
            self.pending.append(bytes(data[start:end]))
        elif self._name:
            self._buf += data[start:end]
            if len(self._buf) > MAX_FIELD_BYTES:
                self.error = HTTPException(status_code=400, detail=f"Form field {self._name!r} is too long")

    def on_part_end(self) -> None:
        if not self._is_file and self._name:
            self.fields[self._name] = self._buf.decode("utf-8", "replace").strip()
            # Each field is capped in size above; this caps how many there are.
            if len(self.fields) > MAX_FIELDS and self.error is None:
                self.error = HTTPException(status_code=400, detail="Too many form fields")
        self._is_file = False


async def _receive(request: Request, dest: Path) -> _Upload:
    ctype, params = parse_options_header(request.headers.get("content-type", ""))
    boundary = params.get(b"boundary")
    if ctype != b"multipart/form-data" or not boundary:
        raise HTTPException(status_code=400, detail="Send the export as multipart/form-data with a 'file' field")
    up = _Upload(settings.max_import_bytes)
    parser = MultipartParser(boundary, up.callbacks())
    fh = await run_in_threadpool(open, dest, "wb")
    try:
        async for chunk in request.stream():
            try:
                parser.write(chunk)
            except FormParserError as exc:
                raise HTTPException(status_code=400, detail="Malformed upload") from exc
            if up.error is not None:
                raise up.error
            if up.pending:
                data = b"".join(up.pending)
                up.pending.clear()
                await run_in_threadpool(fh.write, data)
        try:
            parser.finalize()
        except FormParserError as exc:
            raise HTTPException(status_code=400, detail="Malformed upload") from exc
    finally:
        await run_in_threadpool(fh.close)
    if up.filename is None or up.size == 0:
        raise HTTPException(status_code=400, detail="No export uploaded (multipart field 'file')")
    return up


# --- Starting the job ---------------------------------------------------------------


def _busy(db: DBSession, user_id: str) -> bool:
    now = utcnow()
    live = db.scalars(
        select(Import).where(Import.owner_id == user_id, Import.status.in_(("queued", "running")))
    ).all()
    return any(not _stale(imp, now) for imp in live)


def _check_idle(user_id: str) -> None:
    with SessionLocal() as db:
        if _busy(db, user_id):
            raise HTTPException(status_code=409, detail="An import is already running")


def resolve_workspace(db: DBSession, user: User, value: str | None) -> Workspace:
    """A workspace of the user by id, or by name (case-insensitive): the CLI
    lets people type ``--workspace Farm``."""
    value = (value or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="workspace_id is required")
    ws = db.get(Workspace, value) if len(value) <= 36 else None
    if ws is not None and ws.owner_id == user.id and not ws.deleted:
        return ws
    matches = [
        w for w in db.scalars(
            select(Workspace).where(Workspace.owner_id == user.id, Workspace.deleted.is_(False))
        ).all()
        if w.name.strip().casefold() == value.casefold()
    ]
    if len(matches) > 1:
        raise HTTPException(status_code=409, detail=f"Several workspaces are called {value!r}; pass its id")
    if not matches:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return matches[0]


def _target_page(db: DBSession, ws: Workspace, user: User, page_id: str | None) -> Page:
    page = db.get(Page, page_id or ws.root_page_id or "")
    if page is None or page.owner_id != user.id or page.workspace_id != ws.id:
        raise HTTPException(status_code=404, detail="Parent page not found in that workspace")
    if PageTree(db, ws.id).is_trashed(page.id):
        raise HTTPException(status_code=404, detail="Parent page is in the trash")
    if page.kind == "database":
        raise HTTPException(status_code=400, detail="Pages cannot be imported into a database")
    return page


def _start(user_id: str, fields: dict[str, str], query: dict[str, str], filename: str, path: Path) -> dict:
    def arg(*names: str) -> str | None:
        for name in names:
            if fields.get(name):
                return fields[name]
            if query.get(name):
                return query[name]
        return None

    with SessionLocal() as db:
        user = db.get(User, user_id)
        ws = resolve_workspace(db, user, arg("workspace_id", "workspace"))
        parent = _target_page(db, ws, user, arg("parent_page_id", "parent"))
        with _start_lock:
            if _busy(db, user_id):
                raise HTTPException(status_code=409, detail="An import is already running")
            imp = Import(
                id=new_id(), owner_id=user_id, workspace_id=ws.id, parent_page_id=parent.id,
                source_name=clean_filename(filename)[:500], status="queued",
                stats={"phase": "queued", "heartbeat": utcnow().isoformat()},
            )
            db.add(imp)
            db.commit()
            out = import_out(imp)
    threading.Thread(target=_run, args=(out["id"], path), name=f"notion-import-{out['id'][:8]}", daemon=True).start()
    return out


def _save(import_id: str, **values) -> None:
    with SessionLocal() as db:
        imp = db.get(Import, import_id)
        if imp is None:
            return
        for k, v in values.items():
            setattr(imp, k, v)
        db.commit()


def _run(import_id: str, path: Path) -> None:
    """The background job. The import commits its own batches; this thread only
    keeps the Import row current."""
    try:
        with SessionLocal() as db:
            imp = db.get(Import, import_id)
            if imp is None:
                return
            imp.status = "running"
            imp.stats = {"phase": "starting", "heartbeat": utcnow().isoformat()}
            db.commit()
            user_id, ws_id, parent_id = imp.owner_id, imp.workspace_id, imp.parent_page_id
    except Exception:
        log.exception("notion import %s: could not start", import_id)
        path.unlink(missing_ok=True)
        return

    # One writer for the row: the importer reports into `latest`, and the beat
    # thread copies it into the database every few seconds (never more often,
    # however fast pages go by).
    latest: list[dict] = [{"phase": "starting"}]
    stop = threading.Event()

    def beat() -> None:
        while not stop.wait(HEARTBEAT_SECONDS):
            try:
                _save(import_id, stats={**latest[0], "heartbeat": utcnow().isoformat()})
            except Exception:
                log.exception("notion import %s: progress update failed", import_id)

    def progress(p: dict) -> None:
        latest[0] = dict(p)

    beater = threading.Thread(target=beat, name=f"notion-import-beat-{import_id[:8]}", daemon=True)
    beater.start()
    status, error = "done", None
    try:
        stats = import_notion(user_id, ws_id, parent_id, path, progress)
    except ImportFailed as exc:
        status, error, stats = "error", str(exc), {k: v for k, v in latest[0].items() if k != "phase"}
    except Exception as exc:
        log.exception("notion import %s failed", import_id)
        status, error = "error", f"The import failed ({exc.__class__.__name__}: {exc})"[:2000]
        stats = {k: v for k, v in latest[0].items() if k != "phase"}
    finally:
        stop.set()
        beater.join()
        path.unlink(missing_ok=True)
    try:
        _save(import_id, status=status, error=error, stats=stats, finished_at=utcnow())
    except Exception:
        log.exception("notion import %s: could not record the result", import_id)


# --- Routes ---------------------------------------------------------------------------


# The body is parsed by hand (streamed to disk), so FastAPI cannot describe it.
UPLOAD_BODY = {
    "requestBody": {
        "required": True,
        "content": {"multipart/form-data": {"schema": {
            "type": "object",
            "required": ["file", "workspace_id"],
            "properties": {
                "file": {"type": "string", "format": "binary", "description": "Notion's export zip"},
                "workspace_id": {"type": "string", "description": "A workspace id, or its name"},
                "parent_page_id": {"type": "string", "description": "Default: the workspace's root page"},
            },
        }}},
    },
}


@router.post("/notion", openapi_extra=UPLOAD_BODY)
async def upload_notion(request: Request, user: SessionOrTokenUser, db: DB) -> dict:
    """Upload a Notion export zip (multipart ``file``) and import it under
    ``parent_page_id`` (default: the workspace's root page). ``workspace_id``
    may be an id or a workspace name. Both may also come as query parameters."""
    user_id = user.id
    # The auth lookup opened a transaction; end it so the pooled connection is
    # not held idle for the minutes a big upload takes.
    await run_in_threadpool(db.rollback)

    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > settings.max_import_bytes + 1024 * 1024:
        raise HTTPException(status_code=413, detail="The export is too large")
    # Refuse before a byte is stored, not after gigabytes arrive.
    await run_in_threadpool(_check_idle, user_id)

    settings.import_dir.mkdir(parents=True, exist_ok=True)
    dest = settings.import_dir / f"upload-{uuid.uuid4().hex}.zip"
    try:
        up = await _receive(request, dest)
        if not await run_in_threadpool(zipfile.is_zipfile, dest):
            raise HTTPException(status_code=400, detail="That is not a zip file (Notion: Export, Markdown & CSV)")
        return await run_in_threadpool(_start, user_id, up.fields, dict(request.query_params), up.filename, dest)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise


@router.get("")
def list_imports(db: DB, user: SessionOrTokenUser) -> list[dict]:
    rows = db.scalars(
        select(Import).where(Import.owner_id == user.id).order_by(Import.created_at.desc()).limit(20)
    ).all()
    for imp in rows:
        _expire_if_stale(db, imp)
    return [import_out(imp) for imp in rows]


@router.get("/{import_id}")
def get_import(import_id: str, db: DB, user: SessionOrTokenUser) -> dict:
    imp = db.get(Import, import_id)
    if imp is None or imp.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Import not found")
    _expire_if_stale(db, imp)
    return import_out(imp)
