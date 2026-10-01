"""The demo workspace (app/demo, routers/demo.py) and the first-run welcome
that offers it."""

import re

import pytest

from tests.helpers import needs_db, pull_all, running_app, sign_in

pytestmark = needs_db

# docs/DESIGN.md §2 and §4: the demo is there to show all of it.
BLOCK_TYPES = {
    "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list", "numbered_list", "to_do", "toggle",
    "quote", "callout", "code", "divider", "image", "file", "bookmark", "embed", "table", "page", "database",
    "equation", "grid", "grid_cell",
}
PROPERTY_TYPES = {
    "title", "text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "email", "phone",
    "person", "created_time", "last_edited_time",
}
VIEW_TYPES = {"table", "board", "list", "gallery", "gantt"}
PAGE_LINK = re.compile(r"\]\(/p/([0-9a-f-]{36})\)")


@pytest.fixture
def client():
    with running_app() as c:
        yield c


def add_demo(client) -> dict:
    r = client.post("/api/demo")
    assert r.status_code == 200, r.text
    return r.json()


def demo_rows(client, out: dict) -> tuple[dict, dict, list]:
    """The demo's workspace, its pages by id, and its blocks."""
    data = pull_all(client)
    ws = next(w for w in data["workspaces"] if w["id"] == out["workspace_id"])
    pages = {p["id"]: p for p in data["pages"] if p["workspace_id"] == ws["id"]}
    blocks = [b for b in data["blocks"] if b["page_id"] in pages]
    return ws, pages, blocks


def test_a_new_account_is_welcomed_once(client):
    me = sign_in(client)
    assert me["welcomed_at"] is None
    first = client.patch("/api/auth/me", json={"welcomed": True}).json()["welcomed_at"]
    assert first
    # A second answer keeps the first; signing in again does not ask again.
    assert client.patch("/api/auth/me", json={"welcomed": True}).json()["welcomed_at"] == first
    assert sign_in(client)["welcomed_at"] == first
    # false asks again on the next start.
    assert client.patch("/api/auth/me", json={"welcomed": False}).json()["welcomed_at"] is None


def test_demo_needs_sign_in(client):
    assert client.post("/api/demo").status_code == 401


def test_demo_arrives_by_pull_after_the_other_workspaces(client):
    sign_in(client)
    before = pull_all(client)
    out = add_demo(client)
    assert client.get("/api/auth/me").json()["welcomed_at"]  # adding it answers the welcome

    delta = pull_all(client, cursor=before["cursor"])
    ws = next(w for w in delta["workspaces"] if w["id"] == out["workspace_id"])
    assert ws["name"] == "Farm" and ws["root_page_id"] == out["root_page_id"]
    assert ws["position"] > max(w["position"] for w in before["workspaces"])
    pages = {p["id"]: p for p in delta["pages"]}
    root = pages[out["root_page_id"]]
    assert root["parent_id"] is None and root["title"] == "Farm" and root["icon"] == ws["icon"]
    assert all(p["workspace_id"] == ws["id"] for p in pages.values())
    # One tree: every page but the root has a parent in it, every block a page
    # and (if nested) a parent block on the same page.
    assert all(p["parent_id"] in pages for p in pages.values() if p["id"] != root["id"])
    by_id = {b["id"]: b for b in delta["blocks"]}
    for b in delta["blocks"]:
        assert b["page_id"] in pages
        if b["parent_id"]:
            assert by_id[b["parent_id"]]["page_id"] == b["page_id"]


def test_demo_shows_every_block_property_and_view(client):
    sign_in(client)
    _, pages, blocks = demo_rows(client, add_demo(client))
    assert {b["type"] for b in blocks} >= BLOCK_TYPES
    dbs = [p for p in pages.values() if p["kind"] == "database"]
    assert {pr["type"] for d in dbs for pr in d["schema"]["properties"]} >= PROPERTY_TYPES
    assert {v["type"] for d in dbs for v in d["schema"]["views"]} >= VIEW_TYPES
    assert any(v.get("filter") for d in dbs for v in d["schema"]["views"])
    # The app shows a database page as its views only: text on one would be
    # seen on a published site and nowhere in the editor.
    assert not {b["page_id"] for b in blocks} & {d["id"] for d in dbs}

    # Nested blocks, colours, a to-do in each state, a PDF that opens previewed.
    # Paragraphs wrapped in app/demo's source are single lines of text.
    assert not any("\n" in b["text"] for b in blocks if b["type"] == "paragraph")
    assert any(b["parent_id"] for b in blocks)
    assert any(b["props"].get("color", "").endswith("_bg") for b in blocks)
    assert any(b["props"].get("color") and not b["props"]["color"].endswith("_bg") for b in blocks)
    assert {b["props"]["checked"] for b in blocks if b["type"] == "to_do"} == {True, False}
    assert any(b["type"] == "file" and b["props"].get("preview") for b in blocks)
    assert any(b["type"] == "code" and b["props"]["language"] == "mermaid" for b in blocks)

    # Page looks: icons, both kinds of cover, fonts and widths, a favourite,
    # and a page in the trash to restore.
    live = [p for p in pages.values() if not p["deleted"]]
    root = next(p for p in live if p["parent_id"] is None)
    assert all(p["icon"] for p in live if p["id"] == root["id"] or p["parent_id"] == root["id"])
    covers = {p["cover"].split(":")[0] for p in live if p["cover"]}
    assert covers == {"file", "gradient"}
    assert any(p["options"].get("font") == "serif" for p in live)
    assert any(p["options"].get("full_width") and p["options"].get("small_text") for p in live)
    assert any(p["favorite"] for p in live)
    trashed = [p for p in pages.values() if p["deleted"]]
    assert len(trashed) == 1 and trashed[0]["deleted_at"]


def test_everything_the_demo_points_at_exists(client):
    """Links between pages, page cards, inline databases and their views, the
    values in database rows, and every file."""
    sign_in(client)
    _, pages, blocks = demo_rows(client, add_demo(client))
    live = {pid for pid, p in pages.items() if not p["deleted"]}

    texts = [b["text"] for b in blocks] + [c for b in blocks if b["type"] == "table" for r in b["props"]["rows"] for c in r]
    linked = {pid for t in texts for pid in PAGE_LINK.findall(t)}
    assert len(linked) >= 8 and linked <= live

    files = set()
    for b in blocks:
        p = b["props"]
        if b["type"] in ("page", "database"):
            assert p["page_id"] in live
        if b["type"] == "database":
            assert p["view_id"] in {v["id"] for v in pages[p["page_id"]]["schema"]["views"]}
        if p.get("file_id"):
            files.add((p["file_id"], p["content_type"]))
    for pg in pages.values():
        if (pg["cover"] or "").startswith("file:"):
            files.add((pg["cover"][5:], "image/svg+xml"))
    assert len(files) >= 10  # two covers, the map, the PDF, a hen per breed
    for file_id, ctype in files:
        r = client.get(f"/api/files/{file_id}")
        assert r.status_code == 200 and r.headers["content-type"].startswith(ctype), file_id
        assert int(r.headers["content-length"]) > 500

    for db in (p for p in pages.values() if p["kind"] == "database"):
        props = {pr["id"]: pr for pr in db["schema"]["properties"]}
        for v in db["schema"]["views"]:
            used = [v.get(k) for k in ("group_by", "date_property", "color_by") if v.get(k)]
            used += [s["property"] for s in v.get("sort", []) + v.get("filter", [])]
            used += v.get("hidden", []) + list(v.get("widths", {}))
            assert set(used) <= set(props), (db["title"], v["name"])
            if v["type"] == "board":
                assert props[v["group_by"]]["type"] in ("select", "status")
        rows = [p for p in pages.values() if p["parent_id"] == db["id"]]
        assert rows, db["title"]
        for row in rows:
            for pid, value in row["props"].items():
                pr = props[pid]  # nothing stored for a property the schema lacks
                names = {o["name"] for o in pr.get("options", [])}
                if pr["type"] in ("select", "status"):
                    assert value in names, (row["title"], pr["name"], value)
                elif pr["type"] == "multi_select":
                    assert set(value) <= names
                elif pr["type"] == "date":
                    for d in ([value["start"], value["end"]] if isinstance(value, dict) else [value]):
                        assert re.fullmatch(r"\d{4}-\d\d-\d\d", d)
                assert pr["type"] not in ("title", "created_time", "last_edited_time")


def test_every_demo_page_exports_as_markdown(client):
    sign_in(client)
    _, pages, _ = demo_rows(client, add_demo(client))
    for pid in pages:
        assert client.get(f"/api/pages/{pid}/markdown").status_code == 200, pages[pid]["title"]


@pytest.mark.parametrize("template", ["minimal", "docs", "blog", "landing"])
def test_the_demo_renders_as_a_website(client, template):
    """The tour says to publish it, so every page of it must render in every template."""
    sign_in(client)
    out = add_demo(client)
    r = client.put(f"/api/pages/{out['root_page_id']}/site", json={"slug": "farm", "template": template, "enabled": True})
    assert r.status_code == 200, r.text
    urls = re.findall(r"<loc>http://testserver(/v/farm/[^<]*)</loc>", client.get("/v/farm/sitemap.xml").text)
    assert len(urls) >= 30  # pages, subpages and database rows
    for url in urls:
        assert client.get(url).status_code == 200, url


def test_the_demo_publishes_and_shares_nothing_by_itself(client):
    sign_in(client)
    _, pages, _ = demo_rows(client, add_demo(client))
    assert client.get("/api/sites").json() == []
    assert not any(p["share_token"] or p["edit_token"] for p in pages.values())


def test_each_demo_is_a_copy_of_its_own(client):
    sign_in(client)
    a, b = add_demo(client), add_demo(client)
    _, pa, _ = demo_rows(client, a)
    _, pb, _ = demo_rows(client, b)
    assert a["workspace_id"] != b["workspace_id"] and not set(pa) & set(pb)
    assert len(pa) == len(pb)
