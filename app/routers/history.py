"""Page history: a page's editing sessions, the page as each one left it, and
what changed between two of them. The owner's only; app/history.py keeps it.
"""

from fastapi import APIRouter, HTTPException

from ..config import get_settings
from ..database import DB
from ..history import History
from ..models import PageVersion
from ..security import CurrentUser
from ..services import get_owned_page

router = APIRouter(prefix="/api/pages", tags=["history"])
settings = get_settings()


def _version(h: History, version_id: str) -> PageVersion:
    v = h.get(version_id)
    if v is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return v


@router.get("/{page_id}/history")
def list_sessions(page_id: str, db: DB, user: CurrentUser) -> dict:
    """Every session, newest first."""
    h = History(db, get_owned_page(db, page_id, user))
    return {
        "page_id": page_id,
        "idle_minutes": settings.history_idle_minutes,
        "max_session_minutes": settings.history_max_session_minutes,
        "sessions": [h.describe(v) for v in reversed(h.versions)],
    }


@router.get("/{page_id}/history/{version_id}")
def get_snapshot(page_id: str, version_id: str, db: DB, user: CurrentUser) -> dict:
    """The page as the session left it (the open one: as it is now)."""
    h = History(db, get_owned_page(db, page_id, user))
    v = _version(h, version_id)
    return {"session": h.describe(v), "snapshot": h.snapshot_of(v)}


@router.get("/{page_id}/history/{version_id}/diff")
def get_diff(page_id: str, version_id: str, db: DB, user: CurrentUser, against: str | None = None) -> dict:
    """What the session changed, against the one before it; or, with
    ``against``, between two sessions, read from the older to the newer.
    ``from: null`` means compared with an empty page."""
    h = History(db, get_owned_page(db, page_id, user))
    v = _version(h, version_id)
    if against is None:
        older, newer = h.before(v), v
    else:
        other = _version(h, against)
        older, newer = sorted((v, other), key=h.versions.index)
    return {
        "from": h.describe(older) if older else None,
        "to": h.describe(newer),
        "diff": h.diff(older, newer),
    }
