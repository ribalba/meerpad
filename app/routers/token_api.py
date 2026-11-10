"""The token API: pages as JSON and Markdown, for scripts and agents.

The app reads and writes through offline sync, a protocol made for a client
that mirrors everything. A script wants one request per step instead: list the
workspaces and the page tree, search, read a page as Markdown or as blocks,
create a page from Markdown, append to a page, replace its Markdown, edit one
block. Every route here takes the session cookie or the account's API token,
as ``?token=`` or as ``Authorization: Bearer <token>`` (app/security.py).

Writes go through the sync engine (app/syncing.py) as mutations made on the
server, so they get revisions, per-field clocks and page history like any edit
from the app, and every device picks them up on its next pull. Page history
names them "API", and so does the "last edited by" of a page created here
(as in the app, adding blocks does not change it). The writes of one request
commit together or not at all.
"""

import json
import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from difflib import SequenceMatcher
from typing import Annotated
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session as DBSession

from ..config import get_settings
from ..database import DB, lock_writes
from ..mdblocks import (
    INLINE_TYPES,
    LIST_TYPES,
    BlockNode,
    block_markdown,
    block_tree,
    blocks_to_markdown,
    linked_titles,
    page_to_markdown,
    parse_markdown,
    whole_link,
)
from ..models import Block, Page, User, Workspace, utcnow
from ..schemas import (
    ApiBlockEdit,
    ApiBlockInsert,
    ApiPageAppend,
    ApiPageCreate,
    ApiPageReplace,
    SyncMutation,
)
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
# A gap between two siblings too small to split (DESIGN §6).
MIN_GAP = 1e-6

# Blocks whose whole content is their text, so their type can change.
TEXT_TYPES = (*INLINE_TYPES, "code", "equation")
NO_TEXT_TYPES = ("divider", "table", "page", "database", "grid", "grid_cell")
# Blocks whose Markdown can change in place, and which of their props it spells
# out. The other props (a colour, a table's header flags) stay. Any other block
# is its link, so a different one is a different block.
IN_PLACE_TYPES = (*TEXT_TYPES, "table", "grid", "grid_cell")
MARKDOWN_PROPS = {"to_do": ("checked",), "code": ("language",), "callout": ("icon",), "table": ("rows",),
                  "grid": ("columns",)}
# Blocks whose nested blocks are in their Markdown. What is under any other
# block (a paragraph under a heading) is not, so no Markdown can change it.
MARKDOWN_NESTS = (*LIST_TYPES, "paragraph", "toggle", "callout", "grid", "grid_cell")

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
        self.writes = 0

    def put(self, entity: str, row_id: str, data: dict) -> None:
        self.writes += 1
        if self.writes > MAX_BLOCKS + 1:  # the blocks, and the page they are on
            raise Refused(f"This writes more than {MAX_BLOCKS} blocks. Make the change in parts")
        status = apply(self.db, SyncMutation(op_id=row_id, entity=entity, action="upsert", id=row_id,
                                             updated_at=self.at, data=data), self.scope)
        if status == "stale":  # a device whose clock runs ahead wrote this row
            raise Refused("This was just edited with a newer timestamp. Try again in a few minutes")
        self.written.extend(self.db.new)
        self.db.flush()

    def block(self, page_id: str, node: BlockNode, parent_id: str | None, position: float) -> None:
        block_id = str(uuid.uuid4())
        self.put("block", block_id, {"page_id": page_id, "parent_id": parent_id, "type": node.type,
                                     "text": node.text or "", "props": node.props or {}, "position": position})
        self.blocks(page_id, node.children, block_id)

    def blocks(self, page_id: str, nodes: list[BlockNode], parent_id: str | None = None,
               start: float = 1.0) -> None:
        for i, n in enumerate(nodes):
            self.block(page_id, n, parent_id, start + i)


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


# --- Editing what is there -----------------------------------------------------------

# One sibling after an edit. (block, None) leaves a block as it is, (block, new)
# makes it read as ``new`` and (None, new) creates a block.
Slot = tuple[BlockNode | None, BlockNode | None]


def _kept(nodes: list[BlockNode]) -> list[Slot]:
    return [(n, None) for n in nodes]


def _opcodes(a: list[str], b: list[str]) -> list[tuple]:
    return SequenceMatcher(None, a, b, autojunk=False).get_opcodes()


def _place(positions: list[float | None]) -> list[float]:
    """Positions for siblings in their order. A block that has one keeps it and
    a new block (None) goes between its neighbours. When a gap is too small to
    split, the list is renumbered 1, 2, 3 (DESIGN §6)."""
    out = list(positions)
    i = 0
    while i < len(out):
        if out[i] is not None:
            i += 1
            continue
        end = i
        while end < len(out) and out[end] is None:
            end += 1
        n = end - i
        low, high = out[i - 1] if i else None, out[end] if end < len(out) else None
        step = 1.0
        if low is not None and high is not None:
            step = (high - low) / (n + 1)
            if step < MIN_GAP:
                return [float(k + 1) for k in range(len(out))]
        elif low is None:
            low = 0.0 if high is None else high - n - 1
        out[i:end] = [low + step * (k + 1) for k in range(n)]
        i = end
    return out


class _PageEdit(_Writer):
    """A page's live blocks, and the changes one request makes to them.

    Made inside ``_writes``: it takes the write lock first, so nothing changes
    between reading the blocks and writing to them."""

    def __init__(self, db: DBSession, user: User, page: Page):
        super().__init__(db, user)
        lock_writes(db)
        rows = db.scalars(select(Block).where(Block.page_id == page.id)).all()
        self.written.extend(rows)  # see _Writer
        self.page_id = page.id
        self.top = block_tree(rows)
        self.titles = linked_titles(db, page.owner_id, self.top).get
        self.parents: dict[str, BlockNode | None] = {}
        self.nodes: dict[str, BlockNode] = {}
        stack: list[tuple[BlockNode, BlockNode | None]] = [(n, None) for n in self.top]
        while stack:
            node, parent = stack.pop()
            self.nodes[node.id], self.parents[node.id] = node, parent
            stack.extend((c, node) for c in node.children)

    def find(self, block_id: str) -> BlockNode:
        if block_id not in self.nodes:
            raise HTTPException(status_code=404, detail="Block not found")
        return self.nodes[block_id]

    def around(self, node: BlockNode) -> tuple[str | None, list[BlockNode], int]:
        """The block's parent id, its siblings and its index among them."""
        parent = self.parents[node.id]
        siblings = parent.children if parent else self.top
        # By identity, since two blocks with the same content are equal.
        return parent.id if parent else None, siblings, next(i for i, s in enumerate(siblings) if s is node)

    def remove(self, node: BlockNode) -> None:
        self.put("block", node.id, {"deleted": True})
        for child in node.children:
            self.remove(child)

    def reads(self, node: BlockNode) -> str:
        return block_markdown(node, self.titles)

    def align(self, old: list[BlockNode], new: list[BlockNode]) -> tuple[list[Slot], list[BlockNode]]:
        """Pair stored blocks with the blocks read from Markdown, in order.

        Blocks that read the same are the same block, whatever each is stored
        as, like a page link card and a line holding that link. In a stretch
        that differs, blocks of the same type, in order, are the same block
        with changes. Returns the slots and the blocks left without a
        counterpart."""
        slots: list[Slot] = []
        removed: list[BlockNode] = []
        for tag, i1, i2, j1, j2 in _opcodes([self.reads(o) for o in old], [self.reads(n) for n in new]):
            if tag == "equal":
                slots += zip(old[i1:i2], new[j1:j2], strict=True)
                continue
            was, now = old[i1:i2], new[j1:j2]
            for same, a1, a2, b1, b2 in _opcodes([o.type for o in was], [n.type for n in now]):
                if same == "equal" and was[a1].type in IN_PLACE_TYPES:
                    slots += zip(was[a1:a2], now[b1:b2], strict=True)
                else:
                    removed += was[a1:a2]
                    slots += [(None, n) for n in now[b1:b2]]
        return slots, removed

    def replace(self, parent_id: str | None, old: list[BlockNode], new: list[BlockNode]) -> None:
        """Make one list of siblings read as ``new``. A block Markdown does not
        show (an empty paragraph) stays, or goes with the block before it."""
        shown: list[BlockNode] = []
        unseen: dict[str | None, list[BlockNode]] = {}
        for o in old:
            if o.type == "grid_cell" or o.children or self.reads(o).strip():
                shown.append(o)
            else:
                unseen.setdefault(shown[-1].id if shown else None, []).append(o)
        slots, removed = self.align(shown, new)
        for gone in removed:
            for o in (gone, *unseen.get(gone.id, ())):
                self.remove(o)
        merged = _kept(unseen.get(None, []))
        for slot in slots:
            merged.append(slot)
            if slot[0]:
                merged += _kept(unseen.get(slot[0].id, []))
        self.arrange(parent_id, merged)

    def arrange(self, parent_id: str | None, slots: list[Slot]) -> None:
        positions = _place([old.position if old else None for old, _ in slots])
        for (old, new), position in zip(slots, positions, strict=True):
            if old is None:
                self.block(self.page_id, new, parent_id, position)
                continue
            data = self.taken_from(old, new) if new else {}
            if position != old.position:
                data["position"] = position
            if data:
                self.put("block", old.id, data)
            if new and old.type in MARKDOWN_NESTS:
                self.replace(old.id, old.children, new.children)

    def taken_from(self, old: BlockNode, new: BlockNode) -> dict:
        """What a stored block has to change to read as ``new``."""
        if self.reads(old) == self.reads(new):
            return {}
        data = {}
        if new.text != old.text:
            data["text"] = new.text
        spelled = {k: new.props[k] for k in MARKDOWN_PROPS.get(old.type, ()) if k in new.props}
        if {**old.props, **spelled} != old.props:
            data["props"] = {**old.props, **spelled}
        return data

    def rewrite(self, node: BlockNode, new: list[BlockNode]) -> None:
        """One block replaced by the blocks read from Markdown."""
        if node.type == "grid_cell":
            # Its Markdown is its content, and it stays a cell of its grid.
            self.replace(node.id, node.children, new)
            return
        if not new:
            raise HTTPException(status_code=422, detail="The Markdown holds no block. Delete the block instead")
        parent_id, siblings, i = self.around(node)
        slots, removed = self.align([node], new)
        for gone in removed:
            self.remove(gone)
        self.arrange(parent_id, [*_kept(siblings[:i]), *slots, *_kept(siblings[i + 1:])])


def blocks_out(db: DBSession, page: Page) -> list[dict]:
    """A page's live blocks in document order, each once, with its nesting."""
    top = block_tree(list(db.scalars(select(Block).where(Block.page_id == page.id))))
    titles = linked_titles(db, page.owner_id, top).get
    out: list[dict] = []

    def visit(nodes: list[BlockNode], parent_id: str | None, depth: int) -> None:
        for n in nodes:
            out.append({"id": n.id, "parent_id": parent_id, "depth": depth, "type": n.type, "text": n.text,
                        "props": n.props, "markdown": blocks_to_markdown([n], titles).rstrip("\n")})
            visit(n.children, n.id, depth + 1)

    visit(top, None, 0)
    return out


def _edited(db: DBSession, user: User, page: Page) -> dict:
    """Every edit returns the page and its blocks, with any new ids."""
    return {**page_out(db, user, page), "blocks": blocks_out(db, page)}


def _title_to_write(page: Page, given: str | None, nodes: list[BlockNode]) -> str | None:
    """The title a replacement sets, or None to leave it. As when creating a
    page, a leading ``# Heading`` is the title unless one is given, and it is
    not kept as a block."""
    if given is not None:
        title = given.strip()
    elif nodes and nodes[0].type == "heading_1":
        title = nodes.pop(0).text.strip()
        if title == "Untitled" and not page.title:  # how the export writes no title
            return None
    else:
        return None
    return None if title == (page.title or "").strip() else title


@router.get("/pages/{page_id}/blocks")
def list_blocks(page_id: str, db: DB, user: SessionOrTokenUser) -> list[dict]:
    return blocks_out(db, _owned_page(db, user, page_id))


@router.put("/pages/{page_id}/markdown")
def replace_markdown(page_id: str, payload: ApiPageReplace, db: DB, user: SessionOrTokenUser) -> dict:
    """The page's content replaced by Markdown. Only what differs is written,
    so what Markdown cannot say (colours, link cards, an inline database) stays
    on every block the new Markdown still has."""
    page = _live_page(db, user, page_id)
    if page.kind == "database":
        raise HTTPException(status_code=422, detail="A database's Markdown is its rows. Edit each row as a page")
    nodes = _blocks_from(payload.markdown)
    title = _title_to_write(page, payload.title, nodes)
    with _writes(db):
        edit = _PageEdit(db, user, page)
        if title is not None:
            edit.put("page", page.id, {"title": title})
        # Compared as read, not as written. Sending back what was read must be
        # no edit at all, also where Markdown drops something (nesting under a
        # paragraph, a blank line inside one).
        if _as_the_editor_reads(parse_markdown(blocks_to_markdown(edit.top, edit.titles))) != nodes:
            edit.replace(None, edit.top, nodes)
    return _edited(db, user, page)


@router.post("/pages/{page_id}/blocks")
def insert_blocks(page_id: str, payload: ApiBlockInsert, db: DB, user: SessionOrTokenUser) -> dict:
    """Markdown added at one place in a page, after or before a block, as the
    last blocks inside one, or at the end of the page."""
    page = _live_page(db, user, page_id)
    if sum(v is not None for v in (payload.after, payload.before, payload.parent_id)) > 1:
        raise HTTPException(status_code=422, detail="Say one place: after, before or parent_id")
    nodes = _blocks_from(payload.markdown)
    with _writes(db):
        edit = _PageEdit(db, user, page)
        if payload.after or payload.before:
            anchor = edit.find(payload.after or payload.before)
            if anchor.type == "grid_cell":
                raise HTTPException(status_code=422, detail="A grid holds only its cells. Add the blocks inside a cell")
            parent_id, siblings, i = edit.around(anchor)
            i += 1 if payload.after else 0
        else:
            parent = edit.find(payload.parent_id) if payload.parent_id else None
            if parent is not None and parent.type == "grid":
                raise HTTPException(status_code=422, detail="A grid holds only its cells. Add the blocks inside a cell")
            parent_id, siblings = parent.id if parent else None, parent.children if parent else edit.top
            i = len(siblings)
        edit.arrange(parent_id, [*_kept(siblings[:i]), *((None, n) for n in nodes), *_kept(siblings[i:])])
    return _edited(db, user, page)


def _page_of_block(db: DBSession, user: User, block_id: str) -> Page:
    block = db.get(Block, block_id) if "\x00" not in block_id else None
    if block is None:
        raise HTTPException(status_code=404, detail="Block not found")
    return _live_page(db, user, block.page_id)


def _is_table_rows(rows) -> bool:
    return bool(rows) and isinstance(rows, list) and all(
        isinstance(r, list) and all(isinstance(c, str) for c in r) for r in rows
    )


def _fields_to_write(node: BlockNode, payload: ApiBlockEdit) -> dict:
    data: dict = {}
    if payload.text is not None:
        if node.type in NO_TEXT_TYPES:
            raise HTTPException(status_code=422, detail=f"A {node.type} block has no text. Send markdown or props")
        data["text"] = payload.text
    if payload.type is not None and payload.type != node.type:
        if node.type not in TEXT_TYPES or payload.type not in TEXT_TYPES:
            raise HTTPException(status_code=422, detail="Only text blocks can change type. Send markdown instead")
        data["type"] = payload.type
    if payload.props is not None:
        try:
            # NaN and infinity are read from JSON but JSONB cannot hold them.
            # The schema cannot refuse them, as its error echoes them and fails.
            json.dumps(payload.props, allow_nan=False)
        except (ValueError, RecursionError):
            raise HTTPException(status_code=422, detail="props must be plain JSON with finite numbers") from None
        data["props"] = {k: v for k, v in {**node.props, **payload.props}.items() if v is not None}
        if node.type == "table" and not _is_table_rows(data["props"].get("rows")):
            raise HTTPException(status_code=422, detail="A table's rows must be a list of lists of strings")
    return data


@router.patch("/blocks/{block_id}")
def edit_block(block_id: str, payload: ApiBlockEdit, db: DB, user: SessionOrTokenUser) -> dict:
    """One block changed, either its ``text``, ``type`` or ``props``, or all of
    it (and what is nested in it) through ``markdown``."""
    page = _page_of_block(db, user, block_id)
    fields = (payload.text, payload.type, payload.props)
    if payload.markdown is None and all(f is None for f in fields):
        raise HTTPException(status_code=422, detail="Nothing to change")
    if payload.markdown is not None and any(f is not None for f in fields):
        raise HTTPException(status_code=422, detail="Send markdown, or text, type and props, not both")
    nodes = None if payload.markdown is None else _blocks_from(payload.markdown)
    with _writes(db):
        edit = _PageEdit(db, user, page)
        node = edit.find(block_id)
        if nodes is not None:
            edit.rewrite(node, nodes)
        elif data := _fields_to_write(node, payload):
            edit.put("block", node.id, data)
    return _edited(db, user, page)


@router.delete("/blocks/{block_id}")
def delete_block(block_id: str, db: DB, user: SessionOrTokenUser) -> dict:
    """A block and everything nested in it, deleted as the app deletes them."""
    page = _page_of_block(db, user, block_id)
    with _writes(db):
        edit = _PageEdit(db, user, page)
        node = edit.find(block_id)
        if node.type == "grid_cell":
            # Every cell after it would shift. The grid's Markdown can drop one.
            raise HTTPException(status_code=422, detail="A cell goes with its grid. Edit the grid's markdown")
        edit.remove(node)
    return _edited(db, user, page)
