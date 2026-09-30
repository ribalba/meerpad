"""Page history through the API: edits grouped into sessions as they are
pushed, the snapshot each session leaves, and the diffs between them.

Time passes by moving a page's sessions back in the database (``age``)."""

import threading
import uuid

import pytest
from sqlalchemy import select, text

from tests.helpers import mutation, needs_db, pull_all, running_app, sign_in

pytestmark = needs_db


@pytest.fixture
def client():
    with running_app() as c:
        yield c


def new_id() -> str:
    return str(uuid.uuid4())


def push(client, *mutations, path="/api/sync/push"):
    r = client.post(path, json={"mutations": list(mutations)})
    assert r.status_code == 200, r.text
    statuses = [x["status"] for x in r.json()["results"]]
    assert statuses == ["applied"] * len(mutations), r.json()
    return statuses


def root_of(client, name="Work") -> str:
    ws = next(w for w in pull_all(client)["workspaces"] if w["name"] == name)
    return ws["root_page_id"]


def new_page(client, title="Hühner", blocks=("Bestand",)) -> tuple[str, list[str]]:
    page, ids = new_id(), [new_id() for _ in blocks]
    push(client,
         mutation("page", page, {"parent_id": root_of(client), "title": title, "position": 1}),
         *[mutation("block", b, {"page_id": page, "type": "paragraph", "text": t, "position": i + 1})
           for i, (b, t) in enumerate(zip(ids, blocks))])
    return page, ids


def age(page_id: str, minutes: int, *, start_only: bool = False) -> None:
    """Move the page's sessions ``minutes`` into the past."""
    from app.database import engine

    sets = "started_at = started_at - make_interval(mins => :m)"
    if not start_only:
        sets += ", ended_at = ended_at - make_interval(mins => :m)"
    with engine.begin() as conn:
        conn.execute(text(f"UPDATE page_versions SET {sets} WHERE page_id = :p"), {"m": minutes, "p": page_id})


def sessions(client, page_id: str) -> list[dict]:
    r = client.get(f"/api/pages/{page_id}/history")
    assert r.status_code == 200, r.text
    return r.json()["sessions"]


def get_diff(client, page_id: str, version_id: str, against: str | None = None) -> dict:
    params = {"against": against} if against else {}
    r = client.get(f"/api/pages/{page_id}/history/{version_id}/diff", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def edit(client, block_id: str, text_: str, path="/api/sync/push"):
    push(client, mutation("block", block_id, {"text": text_}), path=path)


def test_edits_close_together_are_one_session(client):
    me = sign_in(client)
    page, (b,) = new_page(client)
    edit(client, b, "Bestand: 12")
    edit(client, b, "Bestand: 12 Hühner")

    (s,) = sessions(client, page)
    assert s["current"] and s["active"] and not s["baseline"]
    assert s["editors"] == [me["email"]]
    assert s["stats"] == {"added": 1, "removed": 0, "changed": 0, "moved": 0, "page": 1}

    d = get_diff(client, page, s["id"])
    assert d["from"] is None and d["to"]["id"] == s["id"]  # created in this session: against an empty page
    assert [(e["status"], e["text"]) for e in d["diff"]["blocks"]] == [("added", "Bestand: 12 Hühner")]


def test_a_quiet_page_starts_a_new_session_and_keeps_the_old_one(client):
    sign_in(client)
    page, (b,) = new_page(client)
    age(page, 11)
    edit(client, b, "Bestand: 14")

    new, old = sessions(client, page)
    assert new["current"] and new["active"] and not old["current"] and not old["active"]
    assert new["stats"]["changed"] == 1

    # The finished session's snapshot is the page as it left it.
    r = client.get(f"/api/pages/{page}/history/{old['id']}")
    assert r.status_code == 200
    assert [x["text"] for x in r.json()["snapshot"]["blocks"]] == ["Bestand"]
    assert r.json()["snapshot"]["page"]["title"] == "Hühner"
    # The current one's is the live page.
    live = client.get(f"/api/pages/{page}/history/{new['id']}").json()["snapshot"]
    assert [x["text"] for x in live["blocks"]] == ["Bestand: 14"]

    d = get_diff(client, page, new["id"])
    assert d["from"]["id"] == old["id"]
    (e,) = d["diff"]["blocks"]
    assert e["status"] == "changed" and e["old"]["text"] == "Bestand"
    assert e["segments"] == [{"op": "same", "text": "Bestand"}, {"op": "added", "text": ": 14"}]


def test_a_session_is_cut_at_its_maximum_length(client):
    sign_in(client)
    page, (b,) = new_page(client)
    age(page, 61, start_only=True)  # started an hour ago, edited just now
    edit(client, b, "later")
    assert len(sessions(client, page)) == 2


def test_only_content_edits_count(client):
    sign_in(client)
    page, _ = new_page(client)
    age(page, 30)
    push(client,
         mutation("page", page, {"favorite": True, "position": 5}),
         mutation("page", page, {"deleted": True}),
         mutation("page", page, {"deleted": False}),
         mutation("page", page, {"title": "Hühner"}))  # resent unchanged
    (s,) = sessions(client, page)
    assert not s["active"]


def test_a_page_older_than_its_history_gets_a_baseline(client):
    sign_in(client)
    root = root_of(client)  # made at sign-up, never through sync
    assert sessions(client, root) == []
    push(client, mutation("page", root, {"title": "Arbeit"}))

    current, base = sessions(client, root)
    assert base["baseline"] and base["stats"] is None and not current["baseline"]
    d = get_diff(client, root, current["id"])
    assert d["from"]["id"] == base["id"]
    assert d["diff"]["page"][0] == {"field": "title", "from": "Work", "to": "Arbeit",
                                    "segments": [{"op": "removed", "text": "Work"},
                                                 {"op": "added", "text": "Arbeit"}]}


def test_a_session_that_changed_nothing_is_dropped(client):
    sign_in(client)
    page, (b,) = new_page(client)
    first = sessions(client, page)[0]["id"]
    age(page, 11)
    edit(client, b, "Bestand?")
    edit(client, b, "Bestand")  # typed, then undone
    age(page, 11)
    edit(client, b, "Bestand!")

    listed = sessions(client, page)
    assert [s["id"] for s in listed][1:] == [first]
    d = get_diff(client, page, listed[0]["id"])
    assert d["from"]["id"] == first and d["diff"]["stats"]["changed"] == 1


def test_any_two_sessions_compare_from_older_to_newer(client):
    sign_in(client)
    page, (b,) = new_page(client, blocks=("eins",))
    for t in ("zwei", "drei"):
        age(page, 11)
        edit(client, b, t)
    current, middle, first = sessions(client, page)

    d = get_diff(client, page, current["id"], against=first["id"])
    assert (d["from"]["id"], d["to"]["id"]) == (first["id"], current["id"])
    assert d["diff"]["blocks"][0]["old"]["text"] == "eins" and d["diff"]["blocks"][0]["text"] == "drei"
    # Asked the other way round, it still reads old to new.
    assert get_diff(client, page, first["id"], against=current["id"])["from"]["id"] == first["id"]
    assert get_diff(client, page, middle["id"])["from"]["id"] == first["id"]


def test_edit_link_edits_are_attributed(client):
    me = sign_in(client)
    page, (b,) = new_page(client)
    token = client.post(f"/api/pages/{page}/share", json={"kind": "edit", "enabled": True}).json()["edit_token"]
    client.cookies.clear()  # a visitor without an account
    edit(client, b, "von aussen", path=f"/api/share/{token}/push")
    # The visitor cannot read the history: it is the owner's.
    assert client.get(f"/api/pages/{page}/history").status_code == 401

    sign_in(client)
    (s,) = sessions(client, page)
    assert s["editors"] == [me["email"], "Someone with the edit link"]


def test_a_block_moved_to_another_page_is_an_edit_of_both(client):
    sign_in(client)
    a, (b,) = new_page(client, "A", ("wandert",))
    other, _ = new_page(client, "B", ())
    age(a, 11)
    age(other, 11)
    push(client, mutation("block", b, {"page_id": other}))
    assert sessions(client, a)[0]["stats"]["removed"] == 1
    assert sessions(client, other)[0]["stats"]["added"] == 1


def test_deleting_a_page_forever_deletes_its_history(client):
    sign_in(client)
    page, (b,) = new_page(client)
    age(page, 11)
    edit(client, b, "x")
    push(client, mutation("page", page, {"deleted": True}))
    assert client.delete(f"/api/pages/{page}").status_code == 200

    from app.database import SessionLocal
    from app.models import PageVersion

    with SessionLocal() as db:
        assert db.scalars(select(PageVersion).where(PageVersion.page_id == page)).all() == []


def test_history_is_private(client):
    sign_in(client)
    page, _ = new_page(client)
    (s,) = sessions(client, page)
    assert client.get(f"/api/pages/{page}/history/{new_id()}").status_code == 404
    assert client.get(f"/api/pages/{page}/history/{s['id']}/diff", params={"against": new_id()}).status_code == 404

    sign_in(client, "someone@example.com")
    for path in (f"/api/pages/{page}/history", f"/api/pages/{page}/history/{s['id']}",
                 f"/api/pages/{page}/history/{s['id']}/diff"):
        assert client.get(path).status_code == 404, path


def test_old_sessions_are_pruned_down_to_a_baseline(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "history_keep_sessions", 2)
    sign_in(client)
    page, (b,) = new_page(client, blocks=("0",))
    for n in range(1, 5):
        age(page, 11)
        edit(client, b, str(n))
    listed = sessions(client, page)
    assert len(listed) == 3  # the open one and two finished
    assert listed[-1]["baseline"] and not listed[1]["baseline"]
    snap = client.get(f"/api/pages/{page}/history/{listed[-1]['id']}").json()["snapshot"]
    assert snap["blocks"][0]["text"] == "2"


def test_simultaneous_pushes_open_one_session(client):
    from app.database import SessionLocal
    from app.models import PageVersion, User
    from app.routers.sync import push_mutations
    from app.schemas import SyncPushRequest
    from app.syncing import Scope

    me = sign_in(client)
    page, (b,) = new_page(client)
    age(page, 11)
    gate = threading.Barrier(4)

    def writer(n: int):
        with SessionLocal() as db:
            user = db.get(User, me["id"])
            payload = SyncPushRequest(mutations=[mutation("block", b, {"text": f"w{n}"})])
            gate.wait()
            push_mutations(db, payload, Scope(owner=user, actor=user.email))

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    with SessionLocal() as db:
        rows = db.scalars(select(PageVersion).where(PageVersion.page_id == page)).all()
        assert sum(1 for v in rows if not v.closed) == 1
        assert len(rows) == 2
