"""Shared test helpers: a running app on a clean database, and a signed-in client."""

import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

needs_db = pytest.mark.skipif(not os.environ.get("MEERPAD_TEST_DB"), reason="MEERPAD_TEST_DB not set")


def truncate() -> None:
    from app.database import Base, engine

    names = ", ".join(t.name for t in Base.metadata.sorted_tables)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
        conn.execute(text("INSERT INTO sync_state (id, rev) VALUES (1, 0) ON CONFLICT DO NOTHING"))


@contextmanager
def running_app():
    from fastapi.testclient import TestClient

    from app.database import init_db
    from app.main import app

    init_db()
    truncate()
    with TestClient(app) as client:
        yield client


def sign_in(client, email: str = "didi@example.com") -> dict:
    """Sign in through the real code flow and return /api/auth/me."""
    from app.database import SessionLocal
    from app.security import create_login_code

    with SessionLocal() as db:
        code = create_login_code(db, email)
    r = client.post("/api/auth/verify-code", json={"email": email, "code": code})
    assert r.status_code == 200, r.text
    return client.get("/api/auth/me").json()


def now_iso(offset_seconds: float = 0) -> str:
    ts = datetime.now(timezone.utc).timestamp() + offset_seconds
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def mutation(entity: str, id: str, data: dict | None = None, action: str = "upsert", at: str | None = None) -> dict:
    return {
        "op_id": str(uuid.uuid4()),
        "entity": entity,
        "action": action,
        "id": id,
        "updated_at": at or now_iso(),
        "data": data or {},
    }


def pull_all(client, path: str = "/api/sync/pull", cursor: int = 0) -> dict:
    """Pull until has_more is false; returns the merged rows and the final cursor."""
    out = {"workspaces": [], "pages": [], "blocks": []}
    while True:
        r = client.get(path, params={"cursor": cursor, "limit": 50})
        assert r.status_code == 200, r.text
        data = r.json()
        for k in out:
            out[k] += data.get(k, [])
        cursor = data["cursor"]
        if not data["has_more"]:
            out["cursor"] = cursor
            out["last"] = data
            return out


def heic(size: tuple[int, int] = (40, 20), exif: dict | None = None, icc: bytes | None = None) -> bytes:
    """A real HEIC, encoded by pillow-heif, so the conversion is tested
    against libheif rather than a stand-in. ``exif`` maps tag to value
    (0x0112 is the orientation, which pillow-heif stores as a rotation)."""
    import io

    from PIL import Image

    import app.images  # noqa: F401 - registers the HEIF plugin

    im = Image.new("RGB", size, (200, 30, 30))
    kw = {}
    if exif:
        ex = Image.Exif()
        ex.update(exif)
        kw["exif"] = ex.tobytes()
    if icc:
        kw["icc_profile"] = icc
    buf = io.BytesIO()
    im.save(buf, format="HEIF", quality=80, **kw)
    return buf.getvalue()
