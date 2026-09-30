"""Page operations that need the server: share links, emptying the trash, export.

Everything else about a page (creating, editing, moving, trashing, restoring)
goes through offline sync.
"""

import secrets

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from ..config import get_settings
from ..database import DB
from ..models import Block, File, Page, Site
from ..schemas import ShareOut, ShareUpdate
from ..security import CurrentUser
from ..services import PageTree, get_owned_page
from ..storage import path_for

router = APIRouter(prefix="/api/pages", tags=["pages"])
settings = get_settings()


def _share_out(db: DBSession, page: Page) -> ShareOut:
    tree = PageTree(db, page.workspace_id)
    inherited = None
    for aid in tree.ancestors(page.id):
        anc = db.get(Page, aid)
        if anc is not None and (anc.share_token or anc.edit_token):
            inherited = aid
            break
    base = settings.base_url.rstrip("/")
    return ShareOut(
        page_id=page.id,
        share_token=page.share_token,
        edit_token=page.edit_token,
        share_url=f"{base}/s/{page.share_token}" if page.share_token else None,
        edit_url=f"{base}/s/{page.edit_token}" if page.edit_token else None,
        inherited_from=inherited,
    )


@router.get("/{page_id}/share", response_model=ShareOut)
def get_share(page_id: str, db: DB, user: CurrentUser):
    return _share_out(db, get_owned_page(db, page_id, user))


@router.post("/{page_id}/share", response_model=ShareOut)
def set_share(page_id: str, payload: ShareUpdate, db: DB, user: CurrentUser):
    """Turn the view or edit link on or off (or replace it, killing the old one).

    Tokens are issued here rather than by the client so they are unguessable no
    matter what the client does; the change reaches every device on its next pull
    (the page's rev moves)."""
    page = get_owned_page(db, page_id, user)
    attr = "share_token" if payload.kind == "view" else "edit_token"
    if not payload.enabled:
        setattr(page, attr, None)
    elif payload.rotate or not getattr(page, attr):
        setattr(page, attr, secrets.token_urlsafe(18))
    db.commit()
    return _share_out(db, page)


@router.delete("/{page_id}")
def purge_page(page_id: str, db: DB, user: CurrentUser) -> dict:
    """Delete a trashed page for good, with everything below it.

    The page rows stay behind as tombstones (``options.purged``, emptied, still
    ``deleted``) so other devices learn about it on their next pull and drop their
    copies; blocks, files, and a published site go for real."""
    page = get_owned_page(db, page_id, user)
    tree = PageTree(db, page.workspace_id)
    if not tree.is_trashed(page.id):
        raise HTTPException(status_code=409, detail="Move the page to the trash first")
    ids = tree.descendants(page.id)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for f in db.scalars(select(File).where(File.page_id.in_(chunk))).all():
            path_for(f.stored_name).unlink(missing_ok=True)
            db.delete(f)
        for s in db.scalars(select(Site).where(Site.page_id.in_(chunk))).all():
            db.delete(s)
        for b in db.scalars(select(Block).where(Block.page_id.in_(chunk))).all():
            db.delete(b)
        for p in db.scalars(select(Page).where(Page.id.in_(chunk))).all():
            p.deleted = True
            p.title = ""
            p.props = {}
            p.schema = None
            p.icon = None
            p.cover = None
            p.share_token = None
            p.edit_token = None
            p.options = {"purged": True}
    db.commit()
    return {"ok": True, "purged": len(ids)}


@router.get("/{page_id}/markdown", response_class=PlainTextResponse)
def export_markdown(page_id: str, db: DB, user: CurrentUser):
    """The page as one Markdown document (Notion-flavoured: the same dialect the
    Notion importer reads)."""
    from ..mdblocks import page_to_markdown

    page = get_owned_page(db, page_id, user)
    return PlainTextResponse(page_to_markdown(db, page), media_type="text/markdown; charset=utf-8")
