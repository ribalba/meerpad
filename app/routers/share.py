"""Share links: anyone with the link can view a page tree, or view and edit it.

Two tokens live on the page (``share_token`` reads, ``edit_token`` reads and
writes) and cover the page and every page below it. The owner turns them on and
off with ``POST /api/pages/{id}/share`` (routers/pages.py).

A visitor's browser speaks the same sync protocol as the owner's, scoped to the
shared tree: ``/api/share/{token}/pull`` and, for an edit link, ``/push``. The
visitor keeps no offline copy (see app/static/share.html).
"""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from ..database import DB
from ..models import User
from ..schemas import ShareInfo, SyncPushRequest, SyncPushResponse
from ..security import OptionalUser
from ..services import resolve_share
from ..syncing import Scope, pull
from .sync import push_mutations

router = APIRouter(prefix="/api/share", tags=["share"])


@router.get("/{token}", response_model=ShareInfo)
def share_info(token: str, db: DB, viewer: OptionalUser) -> ShareInfo:
    grant = resolve_share(db, token)
    owner = db.get(User, grant.page.owner_id)
    return ShareInfo(
        mode=grant.mode,
        root_page_id=grant.page.id,
        title=grant.page.title,
        icon=grant.page.icon,
        owner_name=(owner.name or owner.email.split("@")[0]) if owner else None,
        signed_in=viewer is not None,
    )


@router.get("/{token}/pull")
def share_pull(
    token: str,
    db: DB,
    cursor: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=20000)] = 5000,
) -> dict:
    grant = resolve_share(db, token)
    live = grant.pages()
    out = pull(
        db, cursor, limit,
        page_ids=grant.tree.descendants(grant.page.id),
        block_page_ids=live,
    )
    # The complete set of pages the link reaches right now. A page moved out of
    # the shared tree never shows up in a delta again, so the client prunes
    # anything it holds that is not in this list.
    out["scope_page_ids"] = live
    out["root_page_id"] = grant.page.id
    out["mode"] = grant.mode
    return out


@router.post("/{token}/push", response_model=SyncPushResponse)
def share_push(token: str, payload: SyncPushRequest, db: DB, viewer: OptionalUser):
    grant = resolve_share(db, token)
    if grant.mode != "edit":
        raise HTTPException(status_code=403, detail="This link is view-only")
    owner = db.get(User, grant.page.owner_id)
    actor = viewer.email if viewer else "Someone with the edit link"
    scope = Scope(owner=owner, actor=actor, root_page_id=grant.page.id)
    return push_mutations(db, payload, scope)
