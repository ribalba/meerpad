"""The revision counter under concurrency: a puller must never skip a row.

The claim in app/database.py is that revs are handed out in commit order,
because the counter row stays locked until the writing transaction commits.
This hammers it: several writers commit pages with random pauses inside their
transactions while a puller walks the cursor, and afterwards every page must
have been seen.
"""

import random
import threading
import time
import uuid

from sqlalchemy import select

from tests.helpers import needs_db, running_app, sign_in

pytestmark = needs_db


def test_concurrent_writers_never_skip_rows():
    from app.database import SessionLocal
    from app.models import Page, Workspace
    from app.syncing import pull

    with running_app() as client:
        me = sign_in(client)
        with SessionLocal() as db:
            ws = db.scalars(select(Workspace).where(Workspace.owner_id == me["id"])).first()
            root, ws_id = ws.root_page_id, ws.id

        written: list[str] = []
        lock = threading.Lock()
        stop = threading.Event()

        def writer():
            rnd = random.Random()
            for _ in range(15):
                with SessionLocal() as db:
                    pid = str(uuid.uuid4())
                    db.add(Page(id=pid, workspace_id=ws_id, parent_id=root, owner_id=me["id"], title="x"))
                    db.flush()          # takes a rev and the counter lock
                    time.sleep(rnd.uniform(0, 0.01))  # hold it a moment before committing
                    db.commit()
                with lock:
                    written.append(pid)

        seen: set[str] = set()

        def puller():
            cursor = 0
            while not stop.is_set():
                with SessionLocal() as db:
                    out = pull(db, cursor, 7, owner_id=me["id"])
                seen.update(p["id"] for p in out["pages"])
                cursor = out["cursor"]
            # One last sweep after the writers are done.
            while True:
                with SessionLocal() as db:
                    out = pull(db, cursor, 1000, owner_id=me["id"])
                seen.update(p["id"] for p in out["pages"])
                cursor = out["cursor"]
                if not out["has_more"]:
                    break

        writers = [threading.Thread(target=writer) for _ in range(4)]
        p = threading.Thread(target=puller)
        p.start()
        for w in writers:
            w.start()
        for w in writers:
            w.join()
        stop.set()
        p.join()

        assert len(written) == 60
        assert set(written) <= seen, f"missed {len(set(written) - seen)} rows"

        # And every rev is unique.
        with SessionLocal() as db:
            revs = db.scalars(select(Page.rev).where(Page.owner_id == me["id"])).all()
            assert len(revs) == len(set(revs))
