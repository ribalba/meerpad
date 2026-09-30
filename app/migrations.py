"""Incremental schema migrations, applied automatically on startup.

meerato's mechanism, unchanged. ``Base.metadata.create_all`` (see
:func:`database.init_db`) only ever *creates missing tables*; it never touches a
table that already exists. This module closes that gap: a short, ordered list of
migrations, each run once per database and recorded in ``schema_migrations``.

Adding one: write a ``_verb_noun(conn) -> bool`` function that returns whether it
changed anything, then append it to :data:`MIGRATIONS` with the next id. Never
edit or reorder an id that has shipped.
"""

import logging
from collections.abc import Callable

from sqlalchemy import Connection, Engine, text

logger = logging.getLogger("uvicorn.error")

# Arbitrary but fixed: every process that migrates this database takes the same
# advisory lock, so replicas (or a reloader's workers) booting together apply the
# list one at a time instead of racing on the same ALTER.
_LOCK_KEY = 8_314_207_031

def _column_exists(conn: Connection, table: str, column: str) -> bool:
    return conn.execute(
        text("SELECT 1 FROM information_schema.columns WHERE table_name = :t AND column_name = :c"),
        {"t": table, "c": column},
    ).scalar() is not None


def _sites_subdomain_to_slug(conn: Connection) -> bool:
    """Published sites moved from <subdomain>.<domain> to <app>/v/<slug>, so the
    column is renamed (with its unique index). The values carry over: every
    subdomain was already a valid slug, and the old address becomes the path."""
    if not _column_exists(conn, "sites", "subdomain") or _column_exists(conn, "sites", "slug"):
        return False
    conn.execute(text("ALTER TABLE sites RENAME COLUMN subdomain TO slug"))
    conn.execute(text("ALTER INDEX IF EXISTS ix_sites_subdomain RENAME TO ix_sites_slug"))
    return True


def _users_add_welcomed_at(conn: Connection) -> bool:
    """The first-run welcome (the offer of the demo workspace) is for accounts
    created from now on: every account that already exists counts as welcomed,
    so nobody who has been using meerpad is asked."""
    added = not _column_exists(conn, "users", "welcomed_at")
    if added:
        conn.execute(text("ALTER TABLE users ADD COLUMN welcomed_at TIMESTAMP WITHOUT TIME ZONE"))
    done = conn.execute(
        text("UPDATE users SET welcomed_at = COALESCE(created_at, now() AT TIME ZONE 'utc') WHERE welcomed_at IS NULL")
    )
    return added or done.rowcount > 0


MIGRATIONS: list[tuple[str, Callable[[Connection], bool]]] = [
    ("0001_sites_subdomain_to_slug", _sites_subdomain_to_slug),
    ("0002_users_add_welcomed_at", _users_add_welcomed_at),
]


def run_migrations(engine: Engine) -> None:
    """Apply every migration this database has not seen yet, in one transaction."""
    if engine.dialect.name != "postgresql":
        return

    with engine.begin() as conn:
        conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _LOCK_KEY})
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "  id text PRIMARY KEY,"
                "  applied_at timestamptz NOT NULL DEFAULT now()"
                ")"
            )
        )
        applied = {row[0] for row in conn.execute(text("SELECT id FROM schema_migrations"))}
        for migration_id, migrate in MIGRATIONS:
            if migration_id in applied:
                continue
            changed = migrate(conn)
            conn.execute(text("INSERT INTO schema_migrations (id) VALUES (:id)"), {"id": migration_id})
            logger.info("migration %s %s", migration_id, "applied" if changed else "skipped (already current)")
