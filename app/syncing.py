"""The sync engine: applying client mutations and answering pulls.

Used by the account's own sync (routers/sync.py) and by edit links
(routers/share.py). The difference is a ``Scope``: an account writes anywhere in
its own data; an edit link writes only inside the page tree it was issued for.

Conflicts resolve last-write-wins *per field* on the client's timestamp (stored
in each row's ``clock``), so renaming a page on the laptop and moving it on the
phone, both offline, keeps both changes. meerato resolves per row; blocks are
small enough that it would do here, but a page carries title, icon, props,
schema and position, and losing a rename to an unrelated move is not fine.
"""

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .database import current_rev
from .models import Block, Page, User, Workspace, utcnow
from .schemas import SyncMutation
from .serialize import block_dict, page_dict, workspace_dict
from .services import PageTree


class Refused(ValueError):
    """A mutation the server will never accept (as opposed to a transport error)."""


FIELDS = {
    "workspace": ("name", "icon", "position", "root_page_id", "deleted"),
    "page": (
        "workspace_id", "parent_id", "kind", "title", "icon", "cover", "position",
        "props", "schema", "options", "favorite", "deleted",
    ),
    "block": ("page_id", "parent_id", "type", "text", "props", "position", "deleted"),
}

# Fields an edit link may not touch. Favourites are the owner's sidebar.
RESTRICTED_FIELDS = {"page": {"workspace_id", "favorite"}}

BLOCK_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_TEXT = 1_000_000
MAX_JSON = 2_000_000


@dataclass
class Scope:
    owner: User                     # whose data is written
    actor: str                      # recorded as last_edited_by
    root_page_id: str | None = None  # set for an edit link: the tree it may touch
    _trees: dict = field(default_factory=dict)

    @property
    def restricted(self) -> bool:
        return self.root_page_id is not None

    def tree(self, db: DBSession, workspace_id: str) -> PageTree:
        if workspace_id not in self._trees:
            self._trees[workspace_id] = PageTree(db, workspace_id)
        return self._trees[workspace_id]

    def check_page(self, db: DBSession, page: Page) -> None:
        if page.owner_id != self.owner.id:
            raise Refused("Not allowed")
        if self.restricted and not self.tree(db, page.workspace_id).is_within(page.id, self.root_page_id):
            raise Refused("Outside the shared page")


# --- Timestamps ------------------------------------------------------------------


def norm(dt: datetime | None) -> datetime:
    """Any datetime to naive UTC (tz-aware input converted, naive assumed UTC)."""
    if dt is None:
        return datetime(1970, 1, 1, tzinfo=timezone.utc).replace(tzinfo=None)
    if dt.tzinfo:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def clock_key(dt: datetime) -> str:
    # Fixed width, so string comparison is time comparison.
    return norm(dt).isoformat(timespec="microseconds")


def lww(row, data: dict, ts: datetime, fields) -> bool:
    """Write each field in ``data`` whose last write is not newer than ``ts``."""
    clock = dict(row.clock or {})
    key = clock_key(ts)
    changed = False
    for f in fields:
        if f not in data:
            continue
        prev = clock.get(f)
        if prev is not None and prev > key:
            continue
        setattr(row, f, data[f])
        clock[f] = key
        changed = True
    if changed:
        row.clock = clock
        if row.updated_at is None or norm(ts) > row.updated_at:
            row.updated_at = norm(ts)
    return changed


# --- Field validation ------------------------------------------------------------


def _str(v, limit: int, name: str, nullable: bool = True):
    if v is None:
        if nullable:
            return None
        raise Refused(f"{name} is required")
    if not isinstance(v, str):
        raise Refused(f"{name} must be a string")
    if len(v) > limit:
        raise Refused(f"{name} is too long")
    return v


def _float(v, name: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise Refused(f"{name} must be a number")
    return float(v)


def _json(v, name: str, nullable: bool = False):
    if v is None and nullable:
        return None
    if not isinstance(v, dict):
        raise Refused(f"{name} must be an object")
    if len(repr(v)) > MAX_JSON:
        raise Refused(f"{name} is too large")
    return v


def _bool(v, name: str) -> bool:
    if not isinstance(v, bool):
        raise Refused(f"{name} must be true or false")
    return v


def clean(entity: str, data: dict) -> dict:
    out = {}
    for k, v in data.items():
        if k not in FIELDS[entity]:
            continue  # unknown fields are ignored, for forward compatibility
        if k in ("name",):
            v = (_str(v, 200, k, nullable=False).strip() or "Untitled")
        elif k in ("icon", "cover"):
            v = _str(v, 200 if entity == "workspace" else 500, k)  # the column widths
        elif k in ("root_page_id", "workspace_id", "page_id"):
            v = _str(v, 36, k, nullable=(k == "root_page_id"))
        elif k == "parent_id":
            v = _str(v, 36, k)
        elif k == "position":
            v = _float(v, k)
        elif k in ("deleted", "favorite"):
            v = _bool(v, k)
        elif k == "kind":
            if v not in ("page", "database"):
                raise Refused("kind must be page or database")
        elif k == "title":
            v = _str(v, 10_000, k, nullable=False)
        elif k == "text":
            v = _str(v, MAX_TEXT, k, nullable=False)
        elif k == "type":
            if not isinstance(v, str) or not BLOCK_TYPE_RE.match(v):
                raise Refused("Invalid block type")
        elif k in ("props", "options"):
            v = _json(v, k)
        elif k == "schema":
            v = _json(v, k, nullable=True)
        out[k] = v
    return out


# --- Apply -------------------------------------------------------------------------


def apply(db: DBSession, m: SyncMutation, scope: Scope) -> str:
    ts = norm(m.updated_at)
    # A client clock far in the future would win every conflict forever after.
    # Clamp it to the server's now (plus a little slack for honest skew).
    now = utcnow()
    if (ts - now).total_seconds() > 300:
        ts = now
    data = {"deleted": True} if m.action == "delete" else clean(m.entity, m.data)
    if m.entity == "workspace":
        return _apply_workspace(db, m, data, ts, scope)
    if m.entity == "page":
        return _apply_page(db, m, data, ts, scope)
    return _apply_block(db, m, data, ts, scope)


def _apply_workspace(db, m, data, ts, scope: Scope) -> str:
    if scope.restricted:
        raise Refused("Not allowed")
    ws = db.get(Workspace, m.id)
    is_new = ws is None
    if ws is None:
        if m.action == "delete":
            return "skipped"
        ws = Workspace(id=m.id, owner_id=scope.owner.id, name=data.get("name") or "Untitled",
                       created_at=ts, updated_at=ts, clock={})
        db.add(ws)
    elif ws.owner_id != scope.owner.id:
        raise Refused("Not allowed")
    if "root_page_id" in data and not is_new and ws.root_page_id and data["root_page_id"] != ws.root_page_id:
        raise Refused("A workspace's root page cannot change")
    changed = lww(ws, data, ts, FIELDS["workspace"])
    return "applied" if changed or is_new else "stale"


def _owned_page(db, page_id: str | None, scope: Scope, what: str) -> Page:
    page = db.get(Page, page_id) if page_id else None
    if page is None:
        raise Refused(f"{what} not found")
    scope.check_page(db, page)
    return page


def _apply_page(db, m, data, ts, scope: Scope) -> str:
    if scope.restricted:
        for f in RESTRICTED_FIELDS["page"]:
            data.pop(f, None)
    page = db.get(Page, m.id)
    is_new = page is None

    if is_new:
        if m.action == "delete":
            return "skipped"
        parent_id = data.get("parent_id")
        if parent_id is None:
            # Only a workspace's root page has no parent, and only one may exist.
            if scope.restricted:
                raise Refused("Not allowed")
            ws = db.get(Workspace, data.get("workspace_id"))
            if ws is None or ws.owner_id != scope.owner.id:
                raise Refused("Workspace not found")
            if ws.root_page_id != m.id:
                raise Refused("A page needs a parent")
        else:
            parent = _owned_page(db, parent_id, scope, "Parent page")
            ws = db.get(Workspace, parent.workspace_id)
            data["workspace_id"] = parent.workspace_id
        page = Page(id=m.id, workspace_id=ws.id, parent_id=parent_id, owner_id=scope.owner.id,
                    created_at=ts, updated_at=ts, clock={}, props={}, options={})
        db.add(page)
        scope.tree(db, ws.id).add(page.id, parent_id)
    else:
        scope.check_page(db, page)
        if "parent_id" in data or "workspace_id" in data:
            _check_move(db, page, data, scope)
        if scope.restricted and page.id == scope.root_page_id and (data.get("deleted") or "parent_id" in data):
            raise Refused("The shared page itself cannot be moved or deleted")

    old_ws = page.workspace_id
    was_deleted = page.deleted
    changed = lww(page, data, ts, FIELDS["page"])
    if changed:
        page.last_edited_by = scope.actor
        if page.deleted != was_deleted:
            page.deleted_at = utcnow() if page.deleted else None
        if not is_new and page.workspace_id != old_ws:
            _cascade_workspace(db, page, old_ws, ts, scope)
    return "applied" if changed or is_new else "stale"


def _check_move(db, page: Page, data: dict, scope: Scope) -> None:
    if page.parent_id is None:
        # A root page stays where it is: it *is* its workspace's top.
        if data.get("parent_id") is not None or data.get("workspace_id", page.workspace_id) != page.workspace_id:
            raise Refused("A workspace's root page cannot move")
        data.pop("parent_id", None)
        return
    parent_id = data.get("parent_id", page.parent_id)
    if parent_id is None:
        raise Refused("A page needs a parent")
    parent = _owned_page(db, parent_id, scope, "Parent page")
    # The parent decides the workspace; a stale or missing workspace_id is corrected.
    data["workspace_id"] = parent.workspace_id
    tree = scope.tree(db, parent.workspace_id)
    if parent.id == page.id or page.id in tree.ancestors(parent.id):
        raise Refused("A page cannot move inside itself")


def _cascade_workspace(db, page: Page, old_ws: str, ts: datetime, scope: Scope) -> None:
    """A page moved to another workspace takes its whole subtree along."""
    tree = PageTree(db, old_ws)
    key = clock_key(ts)
    for pid in tree.descendants(page.id)[1:]:
        child = db.get(Page, pid)
        child.workspace_id = page.workspace_id
        child.clock = {**(child.clock or {}), "workspace_id": key}
    scope._trees.pop(old_ws, None)
    scope._trees.pop(page.workspace_id, None)


def _apply_block(db, m, data, ts, scope: Scope) -> str:
    blk = db.get(Block, m.id)
    is_new = blk is None
    if is_new:
        if m.action == "delete":
            return "skipped"
        page = _owned_page(db, data.get("page_id"), scope, "Page")
        blk = Block(id=m.id, page_id=page.id, type=data.get("type", "paragraph"),
                    created_at=ts, updated_at=ts, clock={}, props={})
        db.add(blk)
    else:
        _owned_page(db, blk.page_id, scope, "Page")
        if "page_id" in data and data["page_id"] != blk.page_id:
            _owned_page(db, data["page_id"], scope, "Page")

    target_page = data.get("page_id", blk.page_id)
    parent_id = data.get("parent_id")
    if parent_id:
        if parent_id == blk.id:
            raise Refused("A block cannot contain itself")
        parent = db.get(Block, parent_id)
        if parent is None or parent.page_id != target_page:
            raise Refused("Parent block not found on this page")
        # Walk up: the new parent must not be one of this block's descendants.
        cur, hops = parent, 0
        while cur is not None and cur.parent_id and hops < 200:
            if cur.parent_id == blk.id:
                raise Refused("A block cannot move inside itself")
            cur, hops = db.get(Block, cur.parent_id), hops + 1

    old_page = blk.page_id
    changed = lww(blk, data, ts, FIELDS["block"])
    if changed and not is_new and blk.page_id != old_page:
        _cascade_block_page(db, blk, old_page, ts)
    return "applied" if changed or is_new else "stale"


def _cascade_block_page(db, blk: Block, old_page: str, ts: datetime) -> None:
    """A block moved to another page takes its nested blocks along."""
    rows = db.execute(select(Block.id, Block.parent_id).where(Block.page_id == old_page)).all()
    children: dict[str, list[str]] = {}
    for r in rows:
        if r.parent_id:
            children.setdefault(r.parent_id, []).append(r.id)
    key = clock_key(ts)
    stack = list(children.get(blk.id, []))
    while stack:
        bid = stack.pop()
        child = db.get(Block, bid)
        child.page_id = blk.page_id
        child.clock = {**(child.clock or {}), "page_id": key}
        stack.extend(children.get(bid, []))


# --- Pull --------------------------------------------------------------------------


def pull(db: DBSession, cursor: int, limit: int, *, owner_id: str | None = None,
         page_ids: list[str] | None = None, block_page_ids: list[str] | None = None) -> dict:
    """Rows changed after ``cursor``, oldest first, at most ``limit`` of them.

    Either everything an account owns (``owner_id``) or, for a share link, a fixed
    set of pages (``page_ids``, trashed ones included so a delete reaches the
    visitor) and the blocks of the live ones (``block_page_ids``). The top revision is read
    *first* and every query is capped at it: a transaction committing between
    our statements then shows up on the next pull instead of being skipped.
    """
    top = current_rev(db)
    reset = cursor > top  # the database was rebuilt under the client
    if reset:
        cursor = 0

    def window(stmt, model):
        return stmt.where(model.rev > cursor, model.rev <= top).order_by(model.rev).limit(limit + 1)

    workspaces: list = []
    if owner_id is not None:
        workspaces = db.scalars(window(select(Workspace).where(Workspace.owner_id == owner_id), Workspace)).all()
        pages = db.scalars(window(select(Page).where(Page.owner_id == owner_id), Page)).all()
        blocks = db.scalars(
            window(select(Block).join(Page, Block.page_id == Page.id).where(Page.owner_id == owner_id), Block)
        ).all()
    else:
        pages, blocks = [], []
        ids = page_ids or []
        for i in range(0, len(ids), 1000):  # keep IN lists a sane size
            pages += db.scalars(window(select(Page).where(Page.id.in_(ids[i:i + 1000])), Page)).all()
        ids = block_page_ids or []
        for i in range(0, len(ids), 1000):
            blocks += db.scalars(window(select(Block).where(Block.page_id.in_(ids[i:i + 1000])), Block)).all()

    rows = [("w", r) for r in workspaces] + [("p", r) for r in pages] + [("b", r) for r in blocks]
    rows.sort(key=lambda t: t[1].rev)
    has_more = len(rows) > limit
    rows = rows[:limit]
    new_cursor = rows[-1][1].rev if has_more else top

    owner = owner_id is not None
    return {
        "cursor": new_cursor,
        "has_more": has_more,
        "reset": reset,
        "server_time": utcnow().isoformat(timespec="milliseconds") + "Z",
        "workspaces": [workspace_dict(r) for k, r in rows if k == "w"],
        "pages": [page_dict(r, owner=owner) for k, r in rows if k == "p"],
        "blocks": [block_dict(r) for k, r in rows if k == "b"],
    }
