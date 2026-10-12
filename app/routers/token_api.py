"""The token API: pages as JSON and Markdown, for scripts and agents.

The app reads and writes through offline sync, a protocol made for a client
that mirrors everything. A script wants one request per step instead: list the
workspaces and the page tree, search, read a page as Markdown, create a page
from Markdown, append Markdown to a page. Every route here takes the session
cookie or the account's API token, as ``?token=`` or as ``Authorization:
Bearer <token>`` (app/security.py).

Writes go through the sync engine (app/syncing.py) as mutations made on the
server, so they get revisions, per-field clocks and page history like any edit
from the app, and every device picks them up on its next pull. Page history
names them "API", and so does the "last edited by" of a page created here
(as in the app, adding blocks does not change it). The writes of one request
commit together or not at all.
"""

import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session as DBSession

from ..config import get_settings
from ..database import DB, lock_writes
from ..mdblocks import BlockNode, page_to_markdown, parse_markdown, whole_link
from ..models import Block, Page, User, Workspace, utcnow
from ..schemas import ApiPageAppend, ApiPageCreate, SyncMutation
from ..security import SessionOrTokenUser
from ..serialize import iso
from ..services import get_owned_page
from ..syncing import Refused, Scope, apply, norm
from .imports import resolve_workspace

router = APIRouter(prefix="/api", tags=["token api"])
settings = get_settings()

# Recorded as the editor of every write made here.
ACTOR = "API"
# Blocks one request may write, the size of one sync push, and how deep they
# may nest. Every block is a mutation applied under the server-wide write lock.
MAX_BLOCKS = 2000
MAX_DEPTH = 40
MAX_SEARCH_WORDS = 8

# Search reads the text a person wrote, never JSON keys, ids or flags. A
# page's own words are its title and a database row's values (strings and
# numbers, at any depth). A block's are its text, and for some types values in
# its props (DESIGN §2).
PAGE_MATCHES = text(r"""
SELECT p.id FROM pages p
WHERE p.owner_id = :owner AND (
  p.title ILIKE :pat ESCAPE '\'
  OR (SELECT string_agg(v #>> '{}', E'\n') FROM jsonb_path_query(p.props, 'strict $.**') AS v
      WHERE jsonb_typeof(v) IN ('string', 'number')) ILIKE :pat ESCAPE '\'
)
""")
BLOCK_MATCHES = text(r"""
SELECT DISTINCT b.page_id FROM blocks b JOIN pages p ON p.id = b.page_id
WHERE p.owner_id = :owner AND NOT b.deleted AND (
  b.text ILIKE :pat ESCAPE '\'
  OR CASE b.type
    WHEN 'table' THEN (SELECT string_agg(c #>> '{}', E'\n') FROM jsonb_path_query(b.props, 'lax $.rows[*][*]') AS c)
    WHEN 'file' THEN b.props ->> 'name'
    WHEN 'bookmark' THEN concat_ws(E'\n', b.props ->> 'title', b.props ->> 'description', b.props ->> 'url')
  END ILIKE :pat ESCAPE '\'
)
""")


def page_url(page_id: str) -> str:
    return f"{settings.base_url.rstrip('/')}/p/{page_id}"


# --- The page tree -------------------------------------------------------------------


class PageIndex:
    """Every page of the account, from one query, with the tree around it.

    A page is *gone* when it is in the trash, under a page in the trash, or in a
    deleted workspace. Listings and search leave those out. Reading one by id
    still works and says ``trashed``."""

    def __init__(self, db: DBSession, user: User):
        self.workspaces = {
            w.id: w for w in db.scalars(
                select(Workspace).where(Workspace.owner_id == user.id, Workspace.deleted.is_(False))
            )
        }
        rows = db.execute(
            select(Page.id, Page.parent_id, Page.workspace_id, Page.kind, Page.title, Page.icon,
                   Page.position, Page.deleted, Page.options, Page.created_at, Page.updated_at)
            .where(Page.owner_id == user.id)
        ).all()
        self.rows = {r.id: r for r in rows}
        # Emptied from the trash: tombstones that only exist for sync.
        self.purged = {r.id for r in rows if (r.options or {}).get("purged")}
        self.children: dict[str, list] = {}
        for r in rows:
            if r.parent_id:
                self.children.setdefault(r.parent_id, []).append(r)
        for kids in self.children.values():
            kids.sort(key=lambda r: (r.position, norm(r.created_at), r.id))
        # A page's last edit is its own or its newest block's, whichever is later.
        self.edited = {r.id: r.updated_at for r in rows}
        for page_id, at in db.execute(
            select(Block.page_id, func.max(Block.updated_at))
            .join(Page, Page.id == Block.page_id)
            .where(Page.owner_id == user.id)
            .group_by(Block.page_id)
        ).all():
            if at is not None and (self.edited.get(page_id) is None or at > self.edited[page_id]):
                self.edited[page_id] = at
        self._gone: dict[str, bool] = {}

    def ancestors(self, page_id: str) -> list:
        """The pages above ``page_id``, the workspace's root page first."""
        out, seen = [], {page_id}
        row = self.rows.get(page_id)
        cur = self.rows.get(row.parent_id) if row is not None and row.parent_id else None
        while cur is not None and cur.id not in seen:
            out.append(cur)
            seen.add(cur.id)
            cur = self.rows.get(cur.parent_id) if cur.parent_id else None
        return out[::-1]

    def gone(self, page_id: str) -> bool:
        if page_id not in self._gone:
            r = self.rows.get(page_id)
            self._gone[page_id] = (
                r is None or r.deleted or r.workspace_id not in self.workspaces
                or any(a.deleted for a in self.ancestors(page_id))
            )
        return self._gone[page_id]

    def walk(self, root_id: str, max_depth: int | None = None, rows: bool = False) -> list:
        """``root_id`` and the live pages below it, in sidebar order (depth
        first, siblings by position), at most ``max_depth`` levels down. A
        database's rows only with ``rows``, as the sidebar does not show them."""
        out, stack, seen = [], [(root_id, 0)], set()
        while stack:
            pid, depth = stack.pop()
            r = self.rows.get(pid)
            if r is None or r.deleted or pid in seen:
                continue
            seen.add(pid)
            out.append(r)
            if (max_depth is not None and depth >= max_depth) or (r.kind == "database" and not rows):
                continue
            stack.extend((c.id, depth + 1) for c in reversed(self.children.get(pid, [])))
        return out

    def summary(self, r) -> dict:
        above = self.ancestors(r.id)
        parent = above[-1] if above else None
        ws = self.workspaces.get(r.workspace_id)
        return {
            "id": r.id,
            "title": r.title or "",
            "icon": r.icon,
            "kind": r.kind,
            "workspace_id": r.workspace_id,
            "workspace": ws.name if ws else None,
            "parent_id": r.parent_id,
            "path": " / ".join(a.title or "Untitled" for a in above),
            "depth": len(above),
            "is_row": parent is not None and parent.kind == "database",
            "created_at": iso(r.created_at),
            "edited_at": iso(self.edited.get(r.id)),
            "url": page_url(r.id),
        }


def _owned_page(db: DBSession, user: User, page_id: str) -> Page:
    """The account's page, or 404. A page emptied from the trash is gone."""
    if "\x00" in page_id:
        raise HTTPException(status_code=404, detail="Page not found")
    page = get_owned_page(db, page_id, user)
    if (page.options or {}).get("purged"):
        raise HTTPException(status_code=404, detail="Page not found")
    return page


def _live_page(db: DBSession, user: User, page_id: str, what: str = "page") -> Page:
    """The account's page, or 404. 409 when it is in the trash."""
    page = _owned_page(db, user, page_id)
    if PageIndex(db, user).gone(page.id):
        raise HTTPException(status_code=409, detail=f"The {what} is in the trash")
    return page


def page_out(db: DBSession, user: User, page: Page) -> dict:
    """A page for the API: where it is, what is below it, and its Markdown."""
    idx = PageIndex(db, user)
    return {
        **idx.summary(idx.rows[page.id]),
        "trashed": idx.gone(page.id),
        "last_edited_by": page.last_edited_by,
        "ancestors": [{"id": a.id, "title": a.title or "", "kind": a.kind} for a in idx.ancestors(page.id)],
        "children": [
            {"id": c.id, "title": c.title or "", "icon": c.icon, "kind": c.kind}
            for c in idx.children.get(page.id, []) if not c.deleted
        ],
        "markdown": page_to_markdown(db, page),
    }


# --- Reading -------------------------------------------------------------------------


@router.get("/workspaces")
def list_workspaces(db: DB, user: SessionOrTokenUser) -> list[dict]:
    rows = db.scalars(
        select(Workspace).where(Workspace.owner_id == user.id, Workspace.deleted.is_(False))
        .order_by(Workspace.position, Workspace.created_at, Workspace.id)
    ).all()
    return [{"id": w.id, "name": w.name, "icon": w.icon, "root_page_id": w.root_page_id} for w in rows]


@router.get("/pages")
def list_pages(
    db: DB,
    user: SessionOrTokenUser,
    workspace: Annotated[str | None, Query(max_length=200)] = None,
    parent: Annotated[str | None, Query(max_length=36)] = None,
    depth: Annotated[int | None, Query(ge=1)] = None,
    rows: bool = False,
) -> list[dict]:
    """The page tree, flat, in sidebar order: every workspace's (or one
    workspace's) root page and the pages below it, or only what is below
    ``parent``. ``depth`` counts levels below where the listing starts."""
    _no_nul(workspace)
    idx = PageIndex(db, user)
    if parent:
        if parent not in idx.rows or parent in idx.purged:
            raise HTTPException(status_code=404, detail="Page not found")
        if idx.gone(parent):
            raise HTTPException(status_code=409, detail="The page is in the trash")
        pages = idx.walk(parent, depth, rows)[1:]
    else:
        if workspace:
            spaces = [resolve_workspace(db, user, workspace)]
        else:
            spaces = sorted(idx.workspaces.values(), key=lambda w: (w.position, w.created_at, w.id))
        pages = [p for ws in spaces if ws.root_page_id for p in idx.walk(ws.root_page_id, depth, rows)]
    return [idx.summary(p) for p in pages]


def _no_nul(*values: str | None) -> None:
    """PostgreSQL text cannot hold NUL, and a query with one fails."""
    if any(v and "\x00" in v for v in values):
        raise HTTPException(status_code=422, detail="Text cannot contain NUL characters")


def _like(word: str) -> str:
    return "%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _snippets(db: DBSession, page_ids: list[str], words: list[str]) -> dict[str, str]:
    """For each page, a piece of the first block that mentions one of the words."""
    if not page_ids:
        return {}
    needles = [w.lower() for w in words]
    out: dict[str, str] = {}
    for page_id, body in db.execute(
        select(Block.page_id, Block.text)
        .where(Block.page_id.in_(page_ids), Block.deleted.is_(False))
        .order_by(Block.page_id, Block.position)
    ).all():
        if page_id in out or not body:
            continue
        low = body.lower()
        hits = [low.find(n) for n in needles if n in low]
        if not hits:
            continue
        start, end = max(0, min(hits) - 80), min(len(body), min(hits) + 160)
        piece = " ".join(body[start:end].split())
        out[page_id] = ("…" if start else "") + piece + ("…" if end < len(body) else "")
    return out


@router.get("/search")
def search(
    db: DB,
    user: SessionOrTokenUser,
    q: Annotated[str, Query(min_length=1, max_length=500)],
    workspace: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[dict]:
    """Pages that contain every word of ``q`` (case-insensitive, anywhere in a
    word), in the title, in any block, in a table cell, in a file or bookmark
    name or in a database row's values. Title matches first, then the latest
    edited."""
    _no_nul(q, workspace)
    words = q.split()[:MAX_SEARCH_WORDS]
    if not words:
        raise HTTPException(status_code=422, detail="Nothing to search for")
    idx = PageIndex(db, user)
    ws_id = resolve_workspace(db, user, workspace).id if workspace else None

    found: set[str] | None = None
    for word in words:
        params = {"owner": user.id, "pat": _like(word)}
        ids = set(db.scalars(PAGE_MATCHES, params)) | set(db.scalars(BLOCK_MATCHES, params))
        found = ids if found is None else found & ids
        if not found:
            return []

    hits = [
        idx.rows[i] for i in found
        if i in idx.rows and not idx.gone(i) and (ws_id is None or idx.rows[i].workspace_id == ws_id)
    ]
    hits.sort(key=lambda r: norm(idx.edited.get(r.id)), reverse=True)
    needles = [w.lower() for w in words]
    hits.sort(key=lambda r: not all(n in (r.title or "").lower() for n in needles))
    hits = hits[:limit]
    snippets = _snippets(db, [r.id for r in hits], words)
    return [{**idx.summary(r), "snippet": snippets.get(r.id)} for r in hits]


@router.get("/pages/{page_id}")
def get_page(page_id: str, db: DB, user: SessionOrTokenUser) -> dict:
    return page_out(db, user, _owned_page(db, user, page_id))


# --- Writing -------------------------------------------------------------------------

FILE_REF_RE = re.compile(r"^/api/files/([^/?#]+)(?:/([^?#]*))?(?:[?#].*)?$")
SITE_FILE_RE = re.compile(r"^/_files/([^/?#]+)/([^?#]*)(?:[?#].*)?$")
HTTP_RE = re.compile(r"^https?://", re.IGNORECASE)
DEST_TITLE_RE = re.compile(r"(\S*)(.*)", re.DOTALL)
LINK_TITLE_RE = re.compile(r"""^("[^"]*"|'[^']*'|\([^)]*\))$""")


def _file_ref(target: str) -> dict | None:
    """``/api/files/<id>[/<name>]`` or a published site's ``/_files/<id>/<name>``
    as ``{file_id, name?}`` (app.mdblocks.js ``fileRef``)."""
    m = FILE_REF_RE.match(target) or SITE_FILE_RE.match(target)
    if m is None:
        return None
    out = {"file_id": unquote(m.group(1))}
    if m.group(2):
        out["name"] = unquote(m.group(2))
    return out


def _destination(target: str) -> str | None:
    """A link target's destination, without the ``<...>`` around it or a
    title after it. None when what follows it is not a title. As
    app.mdblocks.js ``exactLink``."""
    t = target.strip()
    if t.startswith("<"):
        gt = t.find(">")
        if gt < 0:
            return None
        dest, title = t[1:gt], t[gt + 1:]
    else:
        dest, title = DEST_TITLE_RE.match(t).groups()
    title = title.strip()
    return dest if not title or LINK_TITLE_RE.match(title) else None


def _as_the_editor_reads(nodes: list[BlockNode]) -> list[BlockNode]:
    """Images and file links as the app's Markdown mode makes them
    (app.mdblocks.js). An image line keeps an uploaded file's id or an
    http(s) address and is text otherwise. A line that is nothing but a link
    to an uploaded file is a file block."""
    out = []
    for n in nodes:
        n.children = _as_the_editor_reads(n.children)
        if n.type == "image":
            raw = str(n.props.get("url") or "")
            dest = _destination(raw) or ""
            ref = _file_ref(dest)
            if ref is not None:
                n.props = ref
            elif HTTP_RE.match(dest):
                n.props = {"url": dest}
            else:
                n = BlockNode("paragraph", f"![{n.text}]({raw})")
        elif n.type == "paragraph" and not n.children:
            link = whole_link(n.text)
            dest = _destination(link.target) if link is not None and not link.image else None
            ref = _file_ref(dest) if dest else None
            if ref is not None:
                n = BlockNode("file", "", {"file_id": ref["file_id"], "name": link.text})
        out.append(n)
    return out


def _size(nodes: list[BlockNode], depth: int = 1) -> tuple[int, int]:
    """How many blocks, and how deep they nest."""
    count, deepest = 0, depth if nodes else depth - 1
    for n in nodes:
        c, d = _size(n.children, depth + 1)
        count, deepest = count + 1 + c, max(deepest, d)
    return count, deepest


def _blocks_from(markdown: str) -> list[BlockNode]:
    try:
        nodes = parse_markdown(markdown)
        count, depth = _size(nodes)
    except RecursionError:
        count, depth = 0, MAX_DEPTH + 1
    if depth > MAX_DEPTH:
        raise HTTPException(status_code=422, detail=f"Blocks nest more than {MAX_DEPTH} levels deep")
    if count > MAX_BLOCKS:
        raise HTTPException(status_code=422, detail=f"More than {MAX_BLOCKS} blocks. Send the page in parts")
    return _as_the_editor_reads(nodes)


def _next_position(db: DBSession, model, *where) -> float:
    top = db.scalar(select(func.max(model.position)).where(model.deleted.is_(False), *where))
    return (top or 0.0) + 1.0


class _Writer:
    """Sync mutations made on the server, applied one by one in the request's
    transaction (each flushed, because the next one may name its row)."""

    def __init__(self, db: DBSession, user: User):
        self.db = db
        self.scope = Scope(owner=user, actor=ACTOR)
        self.at = utcnow()
        # The session holds rows weakly. Kept here, the blocks written stay in
        # it, and the sync engine's checks of a block's parents read them from
        # memory instead of selecting each one again.
        self.written: list = []

    def put(self, entity: str, row_id: str, data: dict) -> None:
        apply(self.db, SyncMutation(op_id=row_id, entity=entity, action="upsert", id=row_id,
                                    updated_at=self.at, data=data), self.scope)
        self.written.extend(self.db.new)
        self.db.flush()

    def blocks(self, page_id: str, nodes: list[BlockNode], parent_id: str | None = None,
               start: float = 1.0) -> None:
        for i, n in enumerate(nodes):
            block_id = str(uuid.uuid4())
            self.put("block", block_id, {"page_id": page_id, "parent_id": parent_id, "type": n.type,
                                         "text": n.text or "", "props": n.props or {}, "position": start + i})
            self.blocks(page_id, n.children, block_id)


@contextmanager
def _writes(db: DBSession) -> Iterator[None]:
    """Commit what the block wrote, or nothing of it."""
    try:
        yield
    except Refused as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc))
    except BaseException:
        db.rollback()
        raise
    db.commit()


@router.post("/pages", status_code=201)
def create_page(payload: ApiPageCreate, db: DB, user: SessionOrTokenUser) -> dict:
    """A new page, last among its siblings, its content read from Markdown."""
    if payload.parent_id:
        parent = _live_page(db, user, payload.parent_id, "parent page")
    elif payload.workspace:
        ws = resolve_workspace(db, user, payload.workspace)
        parent = _live_page(db, user, ws.root_page_id or "", "parent page")
    else:
        raise HTTPException(status_code=400, detail="Say where the page goes: parent_id or workspace")
    nodes = _blocks_from(payload.markdown)
    title = payload.title
    if title is None:
        title = nodes.pop(0).text if nodes and nodes[0].type == "heading_1" else ""

    page_id = str(uuid.uuid4())
    data = {"parent_id": parent.id, "title": title.strip()}
    if payload.icon:
        data["icon"] = payload.icon
    with _writes(db):
        # Taken before the position is read, so two requests cannot both
        # pick the same last place.
        lock_writes(db)
        data["position"] = _next_position(db, Page, Page.parent_id == parent.id)
        w = _Writer(db, user)
        w.put("page", page_id, data)
        w.blocks(page_id, nodes)
    return page_out(db, user, db.get(Page, page_id))


@router.post("/pages/{page_id}/append")
def append_to_page(page_id: str, payload: ApiPageAppend, db: DB, user: SessionOrTokenUser) -> dict:
    """Markdown added at the end of a page."""
    page = _live_page(db, user, page_id)
    nodes = _blocks_from(payload.markdown)
    with _writes(db):
        lock_writes(db)  # as in create_page
        start = _next_position(db, Block, Block.page_id == page.id, Block.parent_id.is_(None))
        _Writer(db, user).blocks(page.id, nodes, start=start)
    return page_out(db, user, page)
