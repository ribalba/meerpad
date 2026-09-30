"""Share links: view and edit tokens, their scope, and what visitors can see."""

import uuid

import pytest

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
    return [x["status"] for x in r.json()["results"]]


def setup_tree(client):
    """root > shared > (child > grandchild), root > private; blocks on each."""
    sign_in(client)
    data = pull_all(client)
    ws = next(w for w in data["workspaces"] if w["name"] == "Work")
    root = ws["root_page_id"]
    ids = {k: new_id() for k in ("shared", "child", "grandchild", "private", "b_shared", "b_child", "b_private")}
    push(
        client,
        mutation("page", ids["shared"], {"parent_id": root, "title": "Farm plan"}),
        mutation("page", ids["child"], {"parent_id": ids["shared"], "title": "Chickens"}),
        mutation("page", ids["grandchild"], {"parent_id": ids["child"], "title": "Breeds"}),
        mutation("page", ids["private"], {"parent_id": root, "title": "Diary"}),
        mutation("block", ids["b_shared"], {"page_id": ids["shared"], "type": "paragraph", "text": "public"}),
        mutation("block", ids["b_child"], {"page_id": ids["child"], "type": "paragraph", "text": "hens"}),
        mutation("block", ids["b_private"], {"page_id": ids["private"], "type": "paragraph", "text": "secret"}),
    )
    ids["root"] = root
    return ids


def test_view_link_scope_and_no_token_leak(client):
    ids = setup_tree(client)
    r = client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "view", "enabled": True})
    assert r.status_code == 200
    share = r.json()
    token = share["share_token"]
    assert share["share_url"].endswith(f"/s/{token}") and share["edit_token"] is None

    # Also turn on an edit link: a view-link visitor must never learn it.
    client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "edit", "enabled": True})

    client.cookies.clear()  # an anonymous visitor
    info = client.get(f"/api/share/{token}").json()
    assert info["mode"] == "view" and info["root_page_id"] == ids["shared"] and info["title"] == "Farm plan"
    data = pull_all(client, f"/api/share/{token}/pull")
    page_ids = {p["id"] for p in data["pages"]}
    assert page_ids == {ids["shared"], ids["child"], ids["grandchild"]}
    assert {b["text"] for b in data["blocks"]} == {"public", "hens"}
    assert set(data["last"]["scope_page_ids"]) == page_ids
    assert data["workspaces"] == []
    for p in data["pages"]:
        assert "edit_token" not in p and "share_token" not in p and "favorite" not in p

    # A view link cannot write.
    r = client.post(f"/api/share/{token}/push", json={"mutations": [mutation("block", ids["b_shared"], {"text": "x"})]})
    assert r.status_code == 403


def test_edit_link_writes_inside_tree_only(client):
    ids = setup_tree(client)
    token = client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "edit", "enabled": True}).json()["edit_token"]
    owner_cookies = dict(client.cookies)
    client.cookies.clear()
    path = f"/api/share/{token}/push"
    new_page, new_block = new_id(), new_id()
    assert push(client, mutation("block", ids["b_child"], {"text": "hens and ducks"}), path=path) == ["applied"]
    assert push(client, mutation("page", new_page, {"parent_id": ids["child"], "title": "Ducks"}), path=path) == ["applied"]
    assert push(client, mutation("block", new_block, {"page_id": new_page, "type": "to_do", "text": "pond"}), path=path) == ["applied"]

    # Outside the tree, the workspace itself, and the shared page's own place: refused.
    assert push(client, mutation("block", ids["b_private"], {"text": "hacked"}), path=path) == ["error"]
    assert push(client, mutation("page", new_id(), {"parent_id": ids["root"]}), path=path) == ["error"]
    assert push(client, mutation("page", ids["child"], {"parent_id": ids["private"]}), path=path) == ["error"]
    assert push(client, mutation("page", ids["shared"], {"deleted": True}), path=path) == ["error"]
    assert push(client, mutation("page", ids["shared"], {"parent_id": ids["private"]}), path=path) == ["error"]
    assert push(client, mutation("workspace", new_id(), {"name": "Mine now"}), path=path) == ["error"]
    # Deleting a subpage is fine: it lands in the owner's trash.
    assert push(client, mutation("page", ids["grandchild"], action="delete"), path=path) == ["applied"]

    # The owner sees the edits, credited to the link.
    client.cookies.update(owner_cookies)
    data = pull_all(client)
    pages = {p["id"]: p for p in data["pages"]}
    assert pages[new_page]["title"] == "Ducks"
    assert pages[new_page]["last_edited_by"] == "Someone with the edit link"
    assert {b["id"]: b for b in data["blocks"]}[ids["b_child"]]["text"] == "hens and ducks"
    assert pages[ids["grandchild"]]["deleted"] is True


def test_trashed_pages_leave_the_share(client):
    ids = setup_tree(client)
    token = client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "view", "enabled": True}).json()["share_token"]
    push(client, mutation("page", ids["child"], action="delete"))
    client.cookies.clear()
    data = pull_all(client, f"/api/share/{token}/pull")
    live = set(data["last"]["scope_page_ids"])
    assert live == {ids["shared"]}
    # The trashed page's row still arrives (so the visitor learns it is gone),
    # but not its content.
    assert {b["text"] for b in data["blocks"]} == {"public"}


def test_link_dies_when_disabled_rotated_or_trashed(client):
    ids = setup_tree(client)
    token = client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "view", "enabled": True}).json()["share_token"]
    rotated = client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "view", "enabled": True, "rotate": True}).json()["share_token"]
    assert rotated != token
    assert client.get(f"/api/share/{token}").status_code == 404
    assert client.get(f"/api/share/{rotated}").status_code == 200
    push(client, mutation("page", ids["shared"], action="delete"))
    assert client.get(f"/api/share/{rotated}").status_code == 404
    push(client, mutation("page", ids["shared"], {"deleted": False}))
    assert client.get(f"/api/share/{rotated}").status_code == 200
    client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "view", "enabled": False})
    assert client.get(f"/api/share/{rotated}").status_code == 404


def test_inherited_share_reported(client):
    ids = setup_tree(client)
    client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "view", "enabled": True})
    r = client.get(f"/api/pages/{ids['grandchild']}/share").json()
    assert r["inherited_from"] == ids["shared"] and r["share_token"] is None


def test_share_endpoints_need_the_owner(client):
    ids = setup_tree(client)
    client.cookies.clear()
    sign_in(client, "other@example.com")
    assert client.post(f"/api/pages/{ids['shared']}/share", json={"kind": "view", "enabled": True}).status_code == 404
    assert client.get(f"/api/pages/{ids['shared']}/share").status_code == 404


def test_share_html_entry_points(client):
    assert client.get("/s/whatever").status_code == 200
    assert client.get("/s/whatever/some-page").status_code == 200
