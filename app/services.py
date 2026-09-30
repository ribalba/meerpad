"""Access checks and page-tree helpers shared by the routers."""

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .models import Page, User, Workspace


class PageTree:
    """The parent links of every page in one workspace, loaded in one query.

    Pages number in the thousands at most, so walking the tree in Python beats a
    recursive CTE for clarity and works the same on SQLite and Postgres.
    """

    def __init__(self, db: DBSession, workspace_id: str):
        rows = db.execute(
            select(Page.id, Page.parent_id, Page.deleted).where(Page.workspace_id == workspace_id)
        ).all()
        self.parent: dict[str, str | None] = {r.id: r.parent_id for r in rows}
        self.deleted: dict[str, bool] = {r.id: r.deleted for r in rows}
        self.children: dict[str | None, list[str]] = {}
        for r in rows:
            self.children.setdefault(r.parent_id, []).append(r.id)

    def add(self, page_id: str, parent_id: str | None, deleted: bool = False) -> None:
        self.parent[page_id] = parent_id
        self.deleted[page_id] = deleted
        self.children.setdefault(parent_id, []).append(page_id)

    def descendants(self, root_id: str, include_deleted: bool = True) -> list[str]:
        """``root_id`` and everything below it, parents before children."""
        out, stack, seen = [], [root_id], set()
        while stack:
            pid = stack.pop()
            if pid in seen:  # a corrupt cycle must not hang the request
                continue
            seen.add(pid)
            if not include_deleted and self.deleted.get(pid):
                continue
            out.append(pid)
            stack.extend(self.children.get(pid, []))
        return out

    def ancestors(self, page_id: str) -> list[str]:
        """Parent first, root last."""
        out, seen = [], {page_id}
        cur = self.parent.get(page_id)
        while cur is not None and cur not in seen:
            out.append(cur)
            seen.add(cur)
            cur = self.parent.get(cur)
        return out

    def is_within(self, page_id: str, root_id: str) -> bool:
        return page_id == root_id or root_id in self.ancestors(page_id)

    def is_trashed(self, page_id: str) -> bool:
        """Deleted itself, or sitting under a deleted page."""
        return bool(self.deleted.get(page_id)) or any(self.deleted.get(a) for a in self.ancestors(page_id))


def get_owned_page(db: DBSession, page_id: str, user: User) -> Page:
    page = db.get(Page, page_id)
    if page is None or page.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Page not found")
    return page


def get_owned_workspace(db: DBSession, workspace_id: str, user: User) -> Workspace:
    ws = db.get(Workspace, workspace_id)
    if ws is None or ws.owner_id != user.id or ws.deleted:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


# --- Share links ---------------------------------------------------------------


@dataclass
class ShareGrant:
    page: Page          # the page carrying the token: the top of what is shared
    mode: str           # "view" | "edit"
    tree: PageTree

    def pages(self) -> list[str]:
        """Every page the link reaches: the shared page and its live descendants."""
        return self.tree.descendants(self.page.id, include_deleted=False)

    def covers(self, page_id: str) -> bool:
        return self.tree.is_within(page_id, self.page.id) and not self._trashed_below(page_id)

    def _trashed_below(self, page_id: str) -> bool:
        """Deleted, or under a deleted page, between page_id and the share root."""
        cur: str | None = page_id
        while cur is not None:
            if self.tree.deleted.get(cur):
                return True
            if cur == self.page.id:
                return False
            cur = self.tree.parent.get(cur)
        return False


def resolve_share(db: DBSession, token: str) -> ShareGrant:
    """The page a share token opens, or 404. A link to a trashed page is dead."""
    if not token or len(token) > 64:
        raise HTTPException(status_code=404, detail="Link not found")
    page = db.query(Page).filter(Page.share_token == token).one_or_none()
    mode = "view"
    if page is None:
        page = db.query(Page).filter(Page.edit_token == token).one_or_none()
        mode = "edit"
    if page is None:
        raise HTTPException(status_code=404, detail="Link not found")
    ws = db.get(Workspace, page.workspace_id)
    tree = PageTree(db, page.workspace_id)
    if ws is None or ws.deleted or tree.is_trashed(page.id):
        raise HTTPException(status_code=404, detail="Link not found")
    return ShareGrant(page=page, mode=mode, tree=tree)
