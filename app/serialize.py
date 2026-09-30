"""Synced rows to the JSON the client stores in IndexedDB.

Timestamps go out as ISO-8601 with a ``Z``: they are naive UTC in the database,
and the client must not read them as local time.
"""

from datetime import datetime

from .models import Block, Page, Workspace


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="milliseconds") + "Z" if dt else None


def workspace_dict(w: Workspace) -> dict:
    return {
        "id": w.id,
        "name": w.name,
        "icon": w.icon,
        "position": w.position,
        "root_page_id": w.root_page_id,
        "deleted": w.deleted,
        "created_at": iso(w.created_at),
        "updated_at": iso(w.updated_at),
        "rev": w.rev,
    }


def page_dict(p: Page, owner: bool = True) -> dict:
    """``owner=False`` for share-link visitors: they never see the page's own
    share tokens (a view link must not reveal the edit link) or favourites."""
    out = {
        "id": p.id,
        "workspace_id": p.workspace_id,
        "parent_id": p.parent_id,
        "kind": p.kind,
        "title": p.title,
        "icon": p.icon,
        "cover": p.cover,
        "position": p.position,
        "props": p.props or {},
        "schema": p.schema,
        "options": p.options or {},
        "deleted": p.deleted,
        "deleted_at": iso(p.deleted_at),
        "created_at": iso(p.created_at),
        "updated_at": iso(p.updated_at),
        "last_edited_by": p.last_edited_by,
        "rev": p.rev,
    }
    if owner:
        out["favorite"] = p.favorite
        out["share_token"] = p.share_token
        out["edit_token"] = p.edit_token
    return out


def block_dict(b: Block) -> dict:
    return {
        "id": b.id,
        "page_id": b.page_id,
        "parent_id": b.parent_id,
        "type": b.type,
        "text": b.text,
        "props": b.props or {},
        "position": b.position,
        "deleted": b.deleted,
        "created_at": iso(b.created_at),
        "updated_at": iso(b.updated_at),
        "rev": b.rev,
    }
