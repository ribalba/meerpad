"""Engine, sessions, schema bootstrap, and the sync revision counter."""

from collections.abc import Generator
from typing import Annotated

from fastapi import Depends
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings
from .migrations import run_migrations

settings = get_settings()

# check_same_thread=False is required for SQLite when used across FastAPI's threadpool.
connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

engine = create_engine(settings.database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# The request's session, as a type (meerpic's style: keeps Depends() out of
# argument defaults).
DB = Annotated[Session, Depends(get_db)]


# --- Sync revisions ------------------------------------------------------------
#
# Every synced row (workspaces, pages, blocks) carries `rev`, a number taken from
# one server-wide counter each time the row is written. Clients pull "everything
# with rev > my cursor", so the counter is what makes pulls complete.
#
# meerato pulls on `updated_at > since` instead, where updated_at is the *client's*
# clock (it doubles as the last-write-wins timestamp). A device whose clock runs
# behind writes rows that are already "in the past" for every other device, and
# they never arrive. Splitting the two jobs (client time decides conflicts, server
# rev decides what to send) closes that.
#
# The counter is one row, bumped with UPDATE ... RETURNING inside the writing
# transaction. The row lock that UPDATE takes is held until commit, so a second
# writer waits and then gets higher numbers: revs are handed out in commit order,
# and a client can never see rev 11 while rev 10 is still uncommitted. The cost is
# that writes to synced tables are serialised, which a notes app does not notice.
# Keep long-running writers (the Notion import) committing in small batches.
#
# Assigned automatically in before_flush for every new or modified row of a model
# that has a `rev` column, so no code path can forget. The one way around it is a
# bulk query.update()/insert(), which skips the ORM: do not use those on synced
# tables.


def _synced(obj) -> bool:
    return hasattr(type(obj), "__synced__")


@event.listens_for(Session, "before_flush")
def _assign_revs(session: Session, flush_context, instances) -> None:
    dirty = [o for o in session.new if _synced(o)]
    dirty += [o for o in session.dirty if _synced(o) and session.is_modified(o)]
    if not dirty:
        return
    top = session.connection().execute(
        text("UPDATE sync_state SET rev = rev + :n WHERE id = 1 RETURNING rev"),
        {"n": len(dirty)},
    ).scalar_one()
    for i, obj in enumerate(dirty):
        obj.rev = top - len(dirty) + 1 + i


def current_rev(db: Session) -> int:
    return db.execute(text("SELECT rev FROM sync_state WHERE id = 1")).scalar_one()


# --- Schema bootstrap ----------------------------------------------------------

# Columns added to existing tables after that table's first release. create_all()
# creates missing *tables* but never alters an existing one. All entries must be
# nullable (or defaulted) so adding them needs no backfill. (meerato's pattern.)
_ADDED_COLUMNS: dict[str, dict[str, str]] = {}


def _add_missing_columns() -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    for table, columns in _ADDED_COLUMNS.items():
        if table not in tables:
            continue
        present = {c["name"] for c in inspector.get_columns(table)}
        missing = {name: sql for name, sql in columns.items() if name not in present}
        if not missing:
            continue
        with engine.begin() as conn:
            for name, sql_type in missing.items():
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))


def init_db() -> None:
    from . import models  # noqa: F401  (registers the tables on Base)

    Base.metadata.create_all(bind=engine)
    _add_missing_columns()
    run_migrations(engine)
    with engine.begin() as conn:
        # ON CONFLICT: two processes booting together both reach this line.
        conn.execute(text("INSERT INTO sync_state (id, rev) VALUES (1, 0) ON CONFLICT DO NOTHING"))
