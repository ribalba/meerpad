"""Pydantic request/response models.

Synced rows (workspaces, pages, blocks) go out as plain dicts built in
app/serialize.py rather than as models here: a Page has a ``schema`` field,
which would shadow BaseModel.schema.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

# --- Auth ------------------------------------------------------------------


class LoginRequest(BaseModel):
    email: EmailStr
    # "desktop" makes the emailed link a meerpad:// deep link (see routers/auth.py).
    client: Literal["web", "desktop"] = "web"
    # Where to land after signing in, e.g. a share link the visitor came from.
    # Only same-site paths are honoured.
    next: str | None = None


class VerifyCodeRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=1, max_length=32)


class UserOut(BaseModel):
    id: str
    email: str
    name: str | None = None
    timezone: str
    api_token: str | None = None

    model_config = {"from_attributes": True}


class ProfileUpdate(BaseModel):
    name: str | None = None
    timezone: str | None = None


# --- Sync ------------------------------------------------------------------


class SyncMutation(BaseModel):
    op_id: str = Field(max_length=64)
    entity: Literal["workspace", "page", "block"]
    # create/update are accepted as aliases of upsert (meerato's vocabulary).
    action: Literal["upsert", "create", "update", "delete"]
    id: str = Field(min_length=1, max_length=36)
    # The client's clock when the change was made: last-write-wins per field.
    updated_at: datetime
    data: dict = Field(default_factory=dict)


class SyncPushRequest(BaseModel):
    mutations: list[SyncMutation] = Field(max_length=2000)


class SyncResult(BaseModel):
    op_id: str
    # applied: written. stale: every field already had a newer write, nothing
    # changed. skipped: nothing to do (delete of a row the server never saw).
    # error: refused, with the reason in detail.
    status: Literal["applied", "stale", "skipped", "error"]
    detail: str | None = None


class SyncPushResponse(BaseModel):
    results: list[SyncResult]


# --- Files -----------------------------------------------------------------


class FileOut(BaseModel):
    id: str
    filename: str
    content_type: str | None = None
    size: int
    url: str


class FetchUrlRequest(BaseModel):
    url: str = Field(max_length=4000)
    page_id: str | None = None


class ProbeOut(BaseModel):
    ok: bool
    url: str
    kind: Literal["image", "pdf", "video", "audio", "file", "html", "unknown"]
    content_type: str | None = None
    filename: str | None = None
    size: int | None = None
    detail: str | None = None


# --- Sharing ---------------------------------------------------------------


class ShareUpdate(BaseModel):
    kind: Literal["view", "edit"]
    enabled: bool
    # Replace an existing token, so the old link stops working.
    rotate: bool = False


class ShareOut(BaseModel):
    page_id: str
    share_token: str | None = None
    edit_token: str | None = None
    share_url: str | None = None
    edit_url: str | None = None
    # Set when the page is not the top of its share: an ancestor's link covers it.
    inherited_from: str | None = None


class ShareInfo(BaseModel):
    mode: Literal["view", "edit"]
    root_page_id: str
    title: str
    icon: str | None = None
    owner_name: str | None = None
    signed_in: bool = False
