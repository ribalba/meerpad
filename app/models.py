"""SQLAlchemy ORM models.

Design notes
------------
* Synced entities (Workspace, Page, Block) have client-generatable UUID string
  ids, so the offline client creates rows locally with a stable id and replays
  them without a remap step (meerato's rule).
* Synced rows carry three bookkeeping columns (see ``SyncedMixin``):
    - ``updated_at``: the client's clock at the last write. Last-write-wins.
    - ``clock``: per-field client timestamps, so two devices editing *different*
      fields of one page offline both survive (meerato resolves per row).
    - ``rev``: a server-wide counter, assigned on every write (database.py).
      Pulls are ``rev > cursor``, never clock based.
* Soft deletes (``deleted``), so a delete made on one device propagates.
* JSON columns are replaced, never mutated in place: SQLAlchemy does not notice
  ``page.props["x"] = 1``. Always assign a new dict.

The document model is Notion's: a workspace has one root page, every other page
has a parent page, and a page's content is a tree of blocks. A database is a page
with ``kind="database"`` and a ``schema``; its rows are its child pages, whose
property values live in ``props``. docs/DESIGN.md has the full contract.
"""

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base

JSONType = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    # Naive UTC throughout, normalised at the boundaries (meerato's convention).
    return datetime.now(timezone.utc).replace(tzinfo=None)


# --- Auth (meerato's tables, unchanged) -----------------------------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    name: Mapped[str | None] = mapped_column(String(200))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC", nullable=False)
    # Secret for the token API (?token=…): scripts, the Notion import CLI.
    api_token: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    # When the account answered the first-run welcome (the offer of the demo
    # workspace, app/demo). Null until then: the app asks on its next start.
    welcomed_at: Mapped[datetime | None] = mapped_column(DateTime)


class LoginToken(Base):
    """Magic link token emailed to a user, reusable until it expires (so mail
    scanners that prefetch the link do not burn it)."""

    __tablename__ = "login_tokens"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Where to land after signing in (a share link's page, for instance).
    redirect_to: Mapped[str | None] = mapped_column(String(500))


class LoginCode(Base):
    """Short sign-in code emailed alongside the link; one live code per email,
    only its HMAC stored, burned on success or after too many wrong guesses."""

    __tablename__ = "login_codes"

    email: Mapped[str] = mapped_column(String(320), primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class RateLimit(Base):
    """Fixed-window request counter, one row per ``action:subject`` key."""

    __tablename__ = "rate_limits"

    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Session(Base):
    __tablename__ = "sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# --- Sync bookkeeping ------------------------------------------------------


class SyncState(Base):
    """One row (id=1) holding the last revision handed out. See database.py."""

    __tablename__ = "sync_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    rev: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)


class SyncedMixin:
    __synced__ = True

    deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    rev: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False, index=True)
    clock: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)


# --- Documents ---------------------------------------------------------------


class Workspace(SyncedMixin, Base):
    """A separate tree of pages ("Work", "House", "Farm"). Owns exactly one root page."""

    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    icon: Mapped[str | None] = mapped_column(String(200))
    position: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    # Not a foreign key: the workspace and its root page are created together
    # (often offline, in either order on the wire), and a FK in each direction
    # would make the two tables mutually dependent.
    root_page_id: Mapped[str | None] = mapped_column(String(36))


class Page(SyncedMixin, Base):
    """A page, a database, or a database row (a page whose parent is a database)."""

    __tablename__ = "pages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True, nullable=False)
    # Null only for a workspace's root page.
    parent_id: Mapped[str | None] = mapped_column(String(36), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)

    kind: Mapped[str] = mapped_column(String(16), default="page", nullable=False)  # page | database
    title: Mapped[str] = mapped_column(Text, default="", nullable=False)
    icon: Mapped[str | None] = mapped_column(String(500))    # emoji, "file:<id>", or a URL
    cover: Mapped[str | None] = mapped_column(String(500))   # "file:<id>", a URL, or "gradient:<n>"
    position: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    # Row values when the parent is a database: {property_id: value}.
    props: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    # Database definition when kind == "database": {"properties": [...], "views": [...]}.
    schema: Mapped[dict | None] = mapped_column(JSONType)
    # Display options: {"full_width": bool, "font": "sans"|"serif"|"mono", "small_text": bool}.
    options: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Link sharing. Server-issued (REST, not sync): anyone holding the token can
    # read (share_token) or read and edit (edit_token) this page and its subpages.
    share_token: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    edit_token: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_edited_by: Mapped[str | None] = mapped_column(String(320))


class Block(SyncedMixin, Base):
    """One block of page content. ``text`` is inline Markdown (raw source for code
    blocks, the caption for media); ``props`` holds the type-specific rest."""

    __tablename__ = "blocks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    page_id: Mapped[str] = mapped_column(ForeignKey("pages.id"), index=True, nullable=False)
    # Null for a top-level block; otherwise the block this one is nested in.
    parent_id: Mapped[str | None] = mapped_column(String(36), index=True)
    type: Mapped[str] = mapped_column(String(32), default="paragraph", nullable=False)
    text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    props: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    position: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)


# --- Page history ----------------------------------------------------------------


class PageVersion(Base):
    """One editing session of a page, and the page as that session left it.

    Server-side only (not synced, no ``rev``); app/history.py writes it. A page
    has at most one open session, its newest: its end state is the live page,
    so it has no snapshot until the next session starts and closes it."""

    __tablename__ = "page_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    page_id: Mapped[str] = mapped_column(ForeignKey("pages.id"), index=True, nullable=False)
    # Server time of the session's first and last edit.
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ended_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Who edited (emails, or the edit link's label), in order of first edit.
    editors: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
    closed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # The earliest version held, with nothing before it to compare against: the
    # page as it was when its history began, or the oldest one kept.
    baseline: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # {"page": {...}, "blocks": [...]}; see history.snapshot(). Set on closing.
    snapshot: Mapped[dict | None] = mapped_column(JSONType)
    # Change counts against the previous version, set on closing.
    stats: Mapped[dict | None] = mapped_column(JSONType)


# --- Files -------------------------------------------------------------------


class File(Base):
    """An uploaded or fetched file. Referenced from blocks by id (props.file_id)."""

    __tablename__ = "files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    # The page it was added to. Decides who else may read it: a share link or a
    # published site covering that page.
    page_id: Mapped[str | None] = mapped_column(String(36), index=True)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    stored_name: Mapped[str] = mapped_column(String(120), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(200))
    size: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    source_url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# --- Published websites --------------------------------------------------------


class Site(Base):
    """A page published as a website at <app>/v/<slug> and, optionally, on a
    custom domain whose A record points at this server."""

    __tablename__ = "sites"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    page_id: Mapped[str] = mapped_column(ForeignKey("pages.id"), unique=True, nullable=False)
    # The name in the site's address, <app>/v/<slug>. Chosen by the owner, unique.
    slug: Mapped[str] = mapped_column(String(63), unique=True, index=True, nullable=False)
    custom_domain: Mapped[str | None] = mapped_column(String(253), unique=True, index=True)
    template: Mapped[str] = mapped_column(String(40), default="minimal", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # {"title", "description", "footer", "show_header", "show_nav", "accent"}; see app/sites.py.
    options: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# --- Imports -----------------------------------------------------------------


class Import(Base):
    """A Notion import job: an uploaded export, processed in the background."""

    __tablename__ = "imports"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    workspace_id: Mapped[str] = mapped_column(String(36), nullable=False)
    # The page the export's top-level pages were placed under.
    parent_page_id: Mapped[str | None] = mapped_column(String(36))
    source_name: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="queued", nullable=False)  # queued|running|done|error
    # {"pages", "databases", "rows", "blocks", "files": counts, "warnings": [...]},
    # plus "phase", "done", "total" (and a heartbeat) while it runs.
    stats: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
