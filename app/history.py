"""Page history: edits grouped into sessions, and the page as each one left it.

Every write that changes what a page shows (its title, icon, cover, row values,
database schema, display options, or any of its blocks) is counted into the
page's open session by :func:`touch`, which the sync engine calls
(app/syncing.py). A session ends after HISTORY_IDLE_MINUTES without an edit, or
once it is HISTORY_MAX_SESSION_MINUTES old, and the next edit starts a new one.

The snapshot of a finished session is taken when the *next* session starts,
before that session's first edit is written: the page is still exactly as the
old session left it, since any edit in between would have joined the old
session. So a page is copied once per session rather than once per push,
nothing has to run in the background to close sessions, and the open session
needs no copy at all: its end state is the live page.

Session times are the server's, so an offline device's edits land in the
session in which they were synced. Snapshots are read with column selects,
which see the database rather than the ORM's identity map: the mutation being
applied is not flushed yet, so they see the page as it was before it.

A diff compares two snapshots block by block (a block keeps its id through
edits), and a block's text word by word. A session that turns out to change
nothing visible (typing that was undone, block positions renumbered) is dropped
when it closes.
"""

import difflib
import math
import re
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession
from sqlalchemy.orm import defer

from .config import get_settings
from .database import lock_writes
from .models import Block, Page, PageVersion, utcnow
from .serialize import iso

# The page fields a snapshot holds. Writing any other one (position, parent,
# favourite, trash) is not an edit of the page.
PAGE_FIELDS = ("title", "icon", "cover", "kind", "props", "schema", "options")
BLOCK_FIELDS = ("parent_id", "type", "text", "props", "position")
# Display options a reader would notice; "purged" is bookkeeping.
OPTION_KEYS = ("full_width", "font", "small_text")

TOKEN_RE = re.compile(r"\w+|\s+|[^\w\s]")


# --- Snapshots ---------------------------------------------------------------------


def snapshot(db: DBSession, page_id: str) -> dict | None:
    """The page as the database holds it, or None if it has no row yet."""
    with db.no_autoflush:
        row = db.execute(select(*(getattr(Page, f) for f in PAGE_FIELDS)).where(Page.id == page_id)).first()
        if row is None:
            return None
        blocks = db.execute(
            select(Block.id, *(getattr(Block, f) for f in BLOCK_FIELDS))
            .where(Block.page_id == page_id, Block.deleted.is_(False))
        ).all()
    page = dict(row._mapping)
    page["props"] = page["props"] or {}
    page["options"] = page["options"] or {}
    return {"page": page, "blocks": ordered([dict(b._mapping) for b in blocks])}


def _position(v) -> float:
    return v if isinstance(v, (int, float)) and math.isfinite(v) else 0.0


def ordered(blocks: list[dict]) -> list[dict]:
    """Blocks in document order, each with its nesting ``depth``.

    As on a published page (render.build_tree), a block under a missing parent
    is left out, and so is a corrupt cycle: the editor shows neither."""
    kids: dict[str | None, list[dict]] = {}
    for b in blocks:
        kids.setdefault(b.get("parent_id") or None, []).append(b)
    for siblings in kids.values():
        siblings.sort(key=lambda b: (_position(b.get("position")), b["id"]))
    out, seen = [], set()
    stack = [(b, 0) for b in reversed(kids.get(None, []))]
    while stack:
        b, depth = stack.pop()
        if b["id"] in seen:
            continue
        seen.add(b["id"])
        out.append({**b, "text": b.get("text") or "", "props": b.get("props") or {}, "depth": depth})
        stack.extend((c, depth + 1) for c in reversed(kids.get(b["id"], [])))
    return out


def _has_content(snap: dict) -> bool:
    page = snap["page"]
    return bool(snap["blocks"] or page.get("title") or page.get("icon") or page.get("cover")
                or _clean(page.get("props")) or page.get("schema"))


# --- Sessions ----------------------------------------------------------------------


def _new_id() -> str:
    return str(uuid.uuid4())


def _ended(v: PageVersion, now: datetime) -> bool:
    """Whether an edit made ``now`` would start a new session after ``v``."""
    s = get_settings()
    return (now - v.ended_at >= timedelta(minutes=s.history_idle_minutes)
            or now - v.started_at >= timedelta(minutes=s.history_max_session_minutes))


def _open_session(db: DBSession, page_id: str) -> PageVersion | None:
    return db.scalars(
        select(PageVersion).where(PageVersion.page_id == page_id, PageVersion.closed.is_(False))
        .order_by(PageVersion.started_at.desc())
    ).first()


def _closed(page_id: str):
    """Finished sessions, newest first. A baseline sorts before a session that
    starts at the same instant."""
    return (select(PageVersion).where(PageVersion.page_id == page_id, PageVersion.closed.is_(True))
            .order_by(PageVersion.started_at.desc(), PageVersion.baseline.asc()))


def touch(db: DBSession, page_id: str, actor: str | None) -> None:
    """Count an edit of ``page_id`` into its open session, first starting a new
    session if the open one has ended.

    Call it before the edit is flushed: starting a session snapshots the page
    as the previous one left it."""
    lock_writes(db)  # two pushes to one page must not both open a session
    now = utcnow()
    cur = _open_session(db, page_id)
    if cur is not None and not _ended(cur, now):
        cur.ended_at = now
        if actor and actor not in cur.editors:
            cur.editors = [*cur.editors, actor]
        return

    snap = snapshot(db, page_id)
    if cur is not None:
        _close(db, cur, snap)
    elif snap is not None and _has_content(snap) and db.scalars(_closed(page_id)).first() is None:
        # Edited before its history began (or made by the Notion import): keep
        # how it looked as the version the first session is compared with.
        meta = db.execute(
            select(Page.created_at, Page.updated_at, Page.last_edited_by).where(Page.id == page_id)
        ).one()
        # updated_at is a client clock, up to five minutes ahead of ours.
        ended = min(max(meta.updated_at or now, meta.created_at or now), now)
        db.add(PageVersion(
            id=_new_id(), page_id=page_id, started_at=min(meta.created_at or ended, ended), ended_at=ended,
            editors=[meta.last_edited_by] if meta.last_edited_by else [],
            closed=True, baseline=True, snapshot=snap,
        ))
    db.add(PageVersion(id=_new_id(), page_id=page_id, started_at=now, ended_at=now,
                       editors=[actor] if actor else [], closed=False))


def _close(db: DBSession, cur: PageVersion, snap: dict | None) -> None:
    """Finish ``cur`` with the page as it left it, or drop it if that changes
    nothing against the version before."""
    prev = db.scalars(_closed(cur.page_id)).first()
    d = diff(prev.snapshot if prev else None, snap) if snap is not None else None
    if d is None or is_empty(d):
        db.delete(cur)
        return
    cur.closed = True
    cur.snapshot = snap
    cur.stats = d["stats"]
    # Keep the newest sessions; the oldest one kept becomes the baseline.
    keep = max(1, get_settings().history_keep_sessions)
    older = [v for v in db.scalars(_closed(cur.page_id).options(defer(PageVersion.snapshot))) if v is not cur]
    kept = [cur, *older]
    if len(kept) > keep:
        for v in kept[keep:]:
            db.delete(v)
        kept[keep - 1].baseline = True


def forget(db: DBSession, page_ids: list[str]) -> None:
    """Drop the history of pages that are deleted for good."""
    for v in db.scalars(select(PageVersion).where(PageVersion.page_id.in_(page_ids))):
        db.delete(v)


# --- Diffs -------------------------------------------------------------------------


def _blank(v) -> bool:
    return v is None or v is False or v == "" or v == [] or v == {}


def _clean(d) -> dict:
    """A props or options object without its empty values: an unchecked box, a
    cleared field and an absent key all read the same."""
    return {k: v for k, v in (d or {}).items() if not _blank(v)} if isinstance(d, dict) else {}


def segments(a: str, b: str) -> list[dict]:
    """``a`` to ``b`` word by word: [{op: same|added|removed, text}].

    Whitespace between two changes joins them, so a rewritten phrase reads as
    one removal and one addition, not word, space, word."""
    ta, tb = TOKEN_RE.findall(a or ""), TOKEN_RE.findall(b or "")
    ops = difflib.SequenceMatcher(None, ta, tb, autojunk=False).get_opcodes()
    out: list[dict] = []
    removed: list[str] = []
    added: list[str] = []

    def flush():
        if removed:
            out.append({"op": "removed", "text": "".join(removed)})
        if added:
            out.append({"op": "added", "text": "".join(added)})
        removed.clear()
        added.clear()

    for k, (tag, i1, i2, j1, j2) in enumerate(ops):
        if tag == "equal" and not (0 < k < len(ops) - 1 and not "".join(tb[j1:j2]).strip()):
            flush()
            text = "".join(tb[j1:j2])
            if out and out[-1]["op"] == "same":
                out[-1]["text"] += text
            else:
                out.append({"op": "same", "text": text})
        else:
            removed.extend(ta[i1:i2])
            added.extend(tb[j1:j2])
    flush()
    return out


def _value_changes(a: dict, b: dict, keys=None) -> list[dict]:
    a, b = _clean(a), _clean(b)
    keys = keys or [*b, *(k for k in a if k not in b)]
    return [{"key": k, "from": a.get(k), "to": b.get(k)} for k in keys if a.get(k) != b.get(k)]


def _schema_changes(a, b) -> list[dict]:
    a = a if isinstance(a, dict) else {}
    b = b if isinstance(b, dict) else {}
    out = []
    for kind, key in (("property", "properties"), ("view", "views")):
        old = {x.get("id"): x for x in a.get(key) or [] if isinstance(x, dict)}
        new = {x.get("id"): x for x in b.get(key) or [] if isinstance(x, dict)}
        for i, x in new.items():
            y, name = old.get(i), x.get("name") or ""
            if y is None:
                out.append({"kind": kind, "change": "added", "id": i, "name": name})
            elif (y.get("name") or "") != name:
                out.append({"kind": kind, "change": "renamed", "id": i, "name": name,
                            "from": y.get("name") or "", "to": name})
            elif y != x:
                out.append({"kind": kind, "change": "changed", "id": i, "name": name})
        out += [{"kind": kind, "change": "removed", "id": i, "name": y.get("name") or ""}
                for i, y in old.items() if i not in new]
    return out


def _page_changes(a: dict, b: dict) -> list[dict]:
    out = []
    ta, tb = a.get("title") or "", b.get("title") or ""
    if ta != tb:
        out.append({"field": "title", "from": ta, "to": tb, "segments": segments(ta, tb)})
    for f in ("icon", "cover", "kind"):
        if (a.get(f) or None) != (b.get(f) or None):
            out.append({"field": f, "from": a.get(f), "to": b.get(f)})
    props = _value_changes(a.get("props"), b.get("props"))
    if props:
        out.append({"field": "props", "changes": props})
    schema = _schema_changes(a.get("schema"), b.get("schema"))
    if schema:
        out.append({"field": "schema", "changes": schema})
    options = _value_changes(a.get("options"), b.get("options"), OPTION_KEYS)
    if options:
        out.append({"field": "options", "changes": options})
    return out


def _entry(b: dict, status: str) -> dict:
    return {"id": b["id"], "type": b["type"], "depth": b["depth"], "status": status, "moved": False,
            "text": b["text"], "props": b["props"], "old": None, "segments": None}


def _block_changes(old: list[dict], new: list[dict]) -> list[dict]:
    """The newer version's blocks in order, with each removed block placed
    where it was. A block counts as moved when it changed parent or left its
    place among the others, but not when it only travelled with its parent."""
    a_by = {b["id"]: b for b in old}
    b_by = {b["id"]: b for b in new}
    a_ids, b_ids = list(a_by), list(b_by)
    out: list[dict] = []
    moved: set[str] = set()

    def both(bid: str, shifted: bool) -> dict:
        a, b = a_by[bid], b_by[bid]
        changed = a["type"] != b["type"] or a["text"] != b["text"] or _clean(a["props"]) != _clean(b["props"])
        e = _entry(b, "changed" if changed else "same")
        if changed:
            e["old"] = {"type": a["type"], "text": a["text"], "props": a["props"]}
        if a["text"] != b["text"]:
            e["segments"] = segments(a["text"], b["text"])
        reparented = (a.get("parent_id") or None) != (b.get("parent_id") or None)
        if reparented or (shifted and b.get("parent_id") not in moved):
            e["moved"] = True
            moved.add(bid)
        return e

    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a_ids, b_ids, autojunk=False).get_opcodes():
        if tag == "equal":
            out += [both(bid, False) for bid in b_ids[j1:j2]]
            continue
        out += [_entry(a_by[bid], "removed") for bid in a_ids[i1:i2] if bid not in b_by]
        out += [both(bid, True) if bid in a_by else _entry(b_by[bid], "added") for bid in b_ids[j1:j2]]
    return out


def diff(old: dict | None, new: dict) -> dict:
    """What changed from snapshot ``old`` to ``new``. ``old=None`` compares
    with an empty page (of the same kind, so a new database is not "turned
    into a database")."""
    if old is None:
        old = {"page": {"kind": new["page"].get("kind")}, "blocks": []}
    page = _page_changes(old["page"], new["page"])
    blocks = _block_changes(old["blocks"], new["blocks"])
    stats = {s: sum(1 for e in blocks if e["status"] == s) for s in ("added", "removed", "changed")}
    stats["moved"] = sum(1 for e in blocks if e["moved"])
    stats["page"] = len(page)
    return {"page": page, "blocks": blocks, "stats": stats}


def is_empty(d: dict) -> bool:
    return not any(d["stats"].values())


# --- Reading it back -----------------------------------------------------------------


class History:
    """A page's sessions, oldest first, for one request. The live page is read
    once, and only if something asks for the open session's end state."""

    def __init__(self, db: DBSession, page: Page):
        self.db, self.page = db, page
        rows = db.scalars(
            select(PageVersion).where(PageVersion.page_id == page.id).options(defer(PageVersion.snapshot))
        ).all()
        self.versions = sorted(rows, key=lambda v: (v.started_at, not v.baseline))
        self._live: dict | None = None
        self._stats: dict | None = None

    def get(self, version_id: str) -> PageVersion | None:
        return next((v for v in self.versions if v.id == version_id), None)

    def before(self, v: PageVersion) -> PageVersion | None:
        i = self.versions.index(v)
        return None if v.baseline or i == 0 else self.versions[i - 1]

    def snapshot_of(self, v: PageVersion) -> dict:
        if v.closed:
            return v.snapshot
        if self._live is None:
            self._live = snapshot(self.db, self.page.id)
        return self._live

    def diff(self, older: PageVersion | None, newer: PageVersion) -> dict:
        return diff(self.snapshot_of(older) if older else None, self.snapshot_of(newer))

    def describe(self, v: PageVersion) -> dict:
        current = not v.closed
        stats = v.stats
        if current:
            if self._stats is None:
                self._stats = self.diff(self.before(v), v)["stats"]
            stats = self._stats
        return {
            "id": v.id,
            "started_at": iso(v.started_at),
            "ended_at": iso(v.ended_at),
            "editors": list(v.editors or []),
            "baseline": v.baseline,
            "current": current,
            "active": current and not _ended(v, utcnow()),
            "stats": None if v.baseline else stats,
        }
