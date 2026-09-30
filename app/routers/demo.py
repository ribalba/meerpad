"""The demo workspace (app/demo): offered when an account starts for the first
time, and from Settings whenever someone wants another look."""

from fastapi import APIRouter

from ..database import DB
from ..demo import create_demo
from ..models import utcnow
from ..security import CurrentUser

router = APIRouter(prefix="/api/demo", tags=["demo"])


@router.post("")
def add_demo(db: DB, user: CurrentUser) -> dict:
    """Add the demo Farm workspace to the account; it reaches the account's
    devices on their next pull. Answers the first-run welcome too. Every call
    adds another copy, so the client does not call it twice."""
    ws = create_demo(db, user)
    user.welcomed_at = user.welcomed_at or utcnow()
    db.commit()
    return {"workspace_id": ws.id, "root_page_id": ws.root_page_id}
