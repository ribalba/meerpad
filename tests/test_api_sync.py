"""Offline sync: push, pull, per-field last-write-wins, moves, and the rev cursor."""

import uuid

import pytest

from tests.helpers import mutation, needs_db, now_iso, pull_all, running_app, sign_in

pytestmark = needs_db


@pytest.fixture
def client():
    with running_app() as c:
        yield c


def new_id() -> str:
    return str(uuid.uuid4())


def root_of(client, name="Work") -> tuple[str, str]:
    data = pull_all(client)
    ws = next(w for w in data["workspaces"] if w["name"] == name)
    return ws["id"], ws["root_page_id"]


def push(client, *mutations, path="/api/sync/push"):
    r = client.post(path, json={"mutations": list(mutations)})
    assert r.status_code == 200, r.text
    return [x["status"] for x in r.json()["results"]], r.json()["results"]


def test_new_account_gets_default_workspaces_with_root_pages(client):
    sign_in(client)
    data = pull_all(client)
    names = sorted(w["name"] for w in data["workspaces"])
    assert names == ["Private", "Work"]
    roots = {p["id"]: p for p in data["pages"]}
    for ws in data["workspaces"]:
        root = roots[ws["root_page_id"]]
        assert root["parent_id"] is None and root["workspace_id"] == ws["id"]


def test_sync_requires_sign_in(client):
    assert client.get("/api/sync/pull").status_code == 401
    assert client.post("/api/sync/push", json={"mutations": []}).status_code == 401


def test_create_page_and_blocks_then_pull_incrementally(client):
    sign_in(client)
    ws_id, root = root_of(client)
    cursor = pull_all(client)["cursor"]

    page, b1, b2 = new_id(), new_id(), new_id()
    statuses, _ = push(
        client,
        mutation("page", page, {"workspace_id": ws_id, "parent_id": root, "title": "Hühner", "position": 1}),
        mutation("block", b1, {"page_id": page, "type": "heading_1", "text": "Bestand", "position": 1}),
        mutation("block", b2, {"page_id": page, "type": "to_do", "text": "**Nistkästen** aufhängen",
                               "props": {"checked": False}, "position": 2}),
    )
    assert statuses == ["applied"] * 3

    delta = pull_all(client, cursor=cursor)
    assert [p["id"] for p in delta["pages"]] == [page]
    assert {b["id"] for b in delta["blocks"]} == {b1, b2}
    assert delta["cursor"] > cursor
    # Nothing new since: an empty delta at the same cursor.
    again = pull_all(client, cursor=delta["cursor"])
    assert again["pages"] == [] and again["blocks"] == [] and again["cursor"] == delta["cursor"]


def test_pull_pages_through_has_more(client):
    sign_in(client)
    _, root = root_of(client)
    ids = [new_id() for _ in range(120)]
    push(client, *[mutation("page", i, {"parent_id": root, "title": f"P{n}", "position": n}) for n, i in enumerate(ids)])
    data = pull_all(client)  # limit=50 inside pull_all forces several rounds
    got = [p["id"] for p in data["pages"]]
    assert set(ids) <= set(got)
    assert len(got) == len(set(got))


def test_last_write_wins_per_field(client):
    sign_in(client)
    _, root = root_of(client)
    page = new_id()
    push(client, mutation("page", page, {"parent_id": root, "title": "Draft"}, at=now_iso(-100)))

    # Device A renamed at t-10, device B changed the icon at t-20: both survive,
    # even though B's write reaches the server last.
    push(client, mutation("page", page, {"title": "Final"}, at=now_iso(-10)))
    statuses, _ = push(client, mutation("page", page, {"icon": "🐔"}, at=now_iso(-20)))
    assert statuses == ["applied"]
    # An older write to the same field loses.
    statuses, _ = push(client, mutation("page", page, {"title": "Older"}, at=now_iso(-50)))
    assert statuses == ["stale"]

    p = next(p for p in pull_all(client)["pages"] if p["id"] == page)
    assert p["title"] == "Final" and p["icon"] == "🐔"


def test_future_client_clock_is_clamped(client):
    sign_in(client)
    _, root = root_of(client)
    page = new_id()
    push(client, mutation("page", page, {"parent_id": root, "title": "From the future"}, at=now_iso(86400 * 365)))
    # A device with a sane clock can still edit it afterwards.
    statuses, _ = push(client, mutation("page", page, {"title": "Fixed"}, at=now_iso(600)))
    assert statuses == ["applied"]


def test_delete_and_restore_page(client):
    sign_in(client)
    _, root = root_of(client)
    page = new_id()
    push(client, mutation("page", page, {"parent_id": root, "title": "Temp"}))
    push(client, mutation("page", page, action="delete"))
    p = next(p for p in pull_all(client)["pages"] if p["id"] == page)
    assert p["deleted"] is True and p["deleted_at"]
    push(client, mutation("page", page, {"deleted": False}))
    p = next(p for p in pull_all(client)["pages"] if p["id"] == page)
    assert p["deleted"] is False and p["deleted_at"] is None


def test_root_page_cannot_move_and_pages_need_parents(client):
    sign_in(client)
    ws_id, root = root_of(client)
    _, other_root = root_of(client, "Private")
    statuses, _ = push(client, mutation("page", root, {"parent_id": other_root}))
    assert statuses == ["error"]
    statuses, _ = push(client, mutation("page", new_id(), {"workspace_id": ws_id, "title": "Orphan"}))
    assert statuses == ["error"]


def test_no_cycles(client):
    sign_in(client)
    _, root = root_of(client)
    a, b = new_id(), new_id()
    push(client, mutation("page", a, {"parent_id": root}), mutation("page", b, {"parent_id": a}))
    statuses, _ = push(client, mutation("page", a, {"parent_id": b}))
    assert statuses == ["error"]
    statuses, _ = push(client, mutation("page", a, {"parent_id": a}))
    assert statuses == ["error"]


def test_move_page_to_other_workspace_takes_subtree(client):
    sign_in(client)
    _, root = root_of(client)
    other_ws, other_root = root_of(client, "Private")
    a, b, c = new_id(), new_id(), new_id()
    push(client, mutation("page", a, {"parent_id": root}), mutation("page", b, {"parent_id": a}),
         mutation("page", c, {"parent_id": b}))
    statuses, _ = push(client, mutation("page", a, {"parent_id": other_root}))
    assert statuses == ["applied"]
    pages = {p["id"]: p for p in pull_all(client)["pages"]}
    assert {pages[x]["workspace_id"] for x in (a, b, c)} == {other_ws}


def test_block_nesting_and_move_between_pages(client):
    sign_in(client)
    _, root = root_of(client)
    p1, p2, toggle, child, grandchild = (new_id() for _ in range(5))
    push(
        client,
        mutation("page", p1, {"parent_id": root}),
        mutation("page", p2, {"parent_id": root}),
        mutation("block", toggle, {"page_id": p1, "type": "toggle", "text": "More"}),
        mutation("block", child, {"page_id": p1, "parent_id": toggle, "type": "paragraph", "text": "inside"}),
        mutation("block", grandchild, {"page_id": p1, "parent_id": child, "type": "paragraph"}),
    )
    # Not into itself, not into a descendant, not under a block on another page.
    assert push(client, mutation("block", toggle, {"parent_id": grandchild}))[0] == ["error"]
    assert push(client, mutation("block", toggle, {"parent_id": toggle}))[0] == ["error"]
    # Moving the toggle to p2 takes the nested blocks along.
    assert push(client, mutation("block", toggle, {"page_id": p2}))[0] == ["applied"]
    blocks = {b["id"]: b for b in pull_all(client)["blocks"]}
    assert {blocks[x]["page_id"] for x in (toggle, child, grandchild)} == {p2}


def test_accounts_are_isolated(client):
    sign_in(client, "a@example.com")
    _, root_a = root_of(client)
    page = new_id()
    push(client, mutation("page", page, {"parent_id": root_a, "title": "Mine"}))

    client.cookies.clear()
    sign_in(client, "b@example.com")
    data = pull_all(client)
    assert page not in {p["id"] for p in data["pages"]}
    assert push(client, mutation("page", page, {"title": "Stolen"}))[0] == ["error"]
    assert push(client, mutation("block", new_id(), {"page_id": page, "type": "paragraph"}))[0] == ["error"]
    assert push(client, mutation("page", new_id(), {"parent_id": page}))[0] == ["error"]


def test_new_workspace_offline_with_root_page(client):
    sign_in(client)
    ws, root = new_id(), new_id()
    statuses, _ = push(
        client,
        mutation("workspace", ws, {"name": "Farm", "icon": "🐄", "root_page_id": root, "position": 5}),
        mutation("page", root, {"workspace_id": ws, "parent_id": None, "title": "Farm"}),
    )
    assert statuses == ["applied", "applied"]
    # A second parentless page in the same workspace is refused.
    assert push(client, mutation("page", new_id(), {"workspace_id": ws, "parent_id": None}))[0] == ["error"]


def test_bad_values_are_refused_not_crashing(client):
    sign_in(client)
    _, root = root_of(client)
    page = new_id()
    push(client, mutation("page", page, {"parent_id": root}))
    for data in ({"position": "x"}, {"kind": "spreadsheet"}, {"props": [1]}, {"title": None}):
        statuses, _ = push(client, mutation("page", page, data))
        assert statuses == ["error"], data
    assert push(client, mutation("block", new_id(), {"page_id": page, "type": "Bad Type"}))[0] == ["error"]


def test_workspace_icon_is_held_to_its_column_width(client):
    sign_in(client)
    ws, root = root_of(client)
    icon = "https://example.com/" + "a" * 300
    # A page takes a long image URL as its icon; the workspace refuses it
    # rather than failing in the database.
    assert push(client, mutation("page", root, {"icon": icon}))[0] == ["applied"]
    assert push(client, mutation("workspace", ws, {"icon": icon}))[0] == ["error"]
    assert push(client, mutation("workspace", ws, {"icon": "🌾"}))[0] == ["applied"]
