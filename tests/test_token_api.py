"""The token API: the page tree, search, pages as Markdown, and pages written from
Markdown, with the API token as ``?token=`` or a Bearer header. Writes go
through the sync engine, so the app pulls them like any other edit."""

import uuid

import pytest

from tests.helpers import mutation, needs_db, now_iso, pull_all, running_app, sign_in

pytestmark = needs_db

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture
def client():
    with running_app() as c:
        yield c


@pytest.fixture
def api(client):
    """A second client without the session cookie, so only a token signs it in."""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


def new_id() -> str:
    return str(uuid.uuid4())


def token_headers(client, email: str = "didi@example.com") -> dict:
    """Sign ``client`` in as ``email`` and return its Bearer header."""
    sign_in(client, email)
    return {"Authorization": f"Bearer {client.post('/api/auth/api-token').json()['api_token']}"}


def push(client, *mutations) -> None:
    r = client.post("/api/sync/push", json={"mutations": list(mutations)})
    assert r.status_code == 200, r.text
    assert all(x["status"] == "applied" for x in r.json()["results"]), r.json()


def root_of(client, name: str = "Work") -> str:
    return next(w for w in pull_all(client)["workspaces"] if w["name"] == name)["root_page_id"]


def page(pid, parent, title, position=1.0, **extra) -> dict:
    return mutation("page", pid, {"parent_id": parent, "title": title, "position": position, **extra})


def block(bid, page_id, text, position=1.0, **extra) -> dict:
    return mutation("block", bid, {"page_id": page_id, "type": "paragraph", "text": text,
                                   "position": position, **extra})


# --- Signing in --------------------------------------------------------------------


def test_the_token_works_as_a_header_or_a_query_parameter(client, api):
    h = token_headers(client)
    token = h["Authorization"].split()[1]

    assert api.get("/api/workspaces").status_code == 401
    r = api.get("/api/workspaces", headers=h)
    assert r.status_code == 200, r.text
    assert [w["name"] for w in r.json()] == ["Work", "Private"]
    assert api.get("/api/workspaces", params={"token": token}).status_code == 200
    assert api.get("/api/workspaces", headers={"Authorization": f"bearer {token}"}).status_code == 200

    assert api.get("/api/workspaces", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert api.get("/api/workspaces", headers={"Authorization": f"Basic {token}"}).status_code == 401
    # The app's own sync stays cookie only.
    assert api.get("/api/sync/pull", headers=h).status_code == 401
    # A rotated token stops working.
    client.post("/api/auth/api-token/rotate")
    assert api.get("/api/workspaces", headers=h).status_code == 401


def test_the_session_cookie_works_too(client):
    sign_in(client)
    assert client.get("/api/workspaces").status_code == 200


# --- The page tree -------------------------------------------------------------------


def test_pages_are_listed_in_sidebar_order(client, api):
    h = token_headers(client)
    root = root_of(client)
    a, b, b1, db, row, trash, under = (new_id() for _ in range(7))
    push(client,
         page(a, root, "A", 2), page(b, root, "B", 1), page(b1, b, "B1"),
         page(db, a, "Herde", kind="database"), page(row, db, "Berta"),
         page(trash, root, "Weg", 3), page(under, trash, "Darunter"))
    push(client, mutation("page", trash, {"deleted": True}))

    r = api.get("/api/pages", params={"workspace": "work"}, headers=h)
    assert r.status_code == 200, r.text
    got = r.json()
    assert [p["title"] for p in got] == ["Work", "B", "B1", "A", "Herde"]
    assert [p["depth"] for p in got] == [0, 1, 2, 1, 2]
    b1_out = got[2]
    assert b1_out["path"] == "Work / B" and b1_out["parent_id"] == b and b1_out["workspace"] == "Work"
    assert b1_out["url"].endswith(f"/p/{b1}") and not b1_out["is_row"]

    with_rows = api.get("/api/pages", params={"workspace": "Work", "rows": "true"}, headers=h).json()
    assert [p["title"] for p in with_rows][-1] == "Berta" and with_rows[-1]["is_row"]

    assert [p["title"] for p in api.get("/api/pages", params={"parent": b}, headers=h).json()] == ["B1"]
    shallow = api.get("/api/pages", params={"workspace": "Work", "depth": 1}, headers=h).json()
    assert [p["title"] for p in shallow] == ["Work", "B", "A"]
    everything = api.get("/api/pages", headers=h).json()
    assert {"Work", "Private"} <= {p["title"] for p in everything}

    assert api.get("/api/pages", params={"parent": trash}, headers=h).status_code == 409
    assert api.get("/api/pages", params={"parent": new_id()}, headers=h).status_code == 404
    assert api.get("/api/pages", params={"workspace": "Farm"}, headers=h).status_code == 404


# --- Search --------------------------------------------------------------------------


def test_search_finds_every_word_in_titles_blocks_and_tables(client, api):
    h = token_headers(client)
    root = root_of(client)
    hens, plan, costs, gone = new_id(), new_id(), new_id(), new_id()
    push(client,
         page(hens, root, "Hühner", 1), page(plan, root, "Stall plan", 2), page(costs, root, "Kosten", 3),
         page(gone, root, "Alt", 4),
         block(new_id(), hens, "Die **Nistkästen** hängen im Stall, gleich links."),
         mutation("block", new_id(), {"page_id": costs, "type": "table", "text": "",
                                      "props": {"rows": [["Posten", "Euro"], ["Futterkosten", "40"]]}}),
         block(new_id(), gone, "Nistkästen von früher"))
    push(client, mutation("page", gone, {"deleted": True}))

    def titles(q, **params):
        r = api.get("/api/search", params={"q": q, **params}, headers=h)
        assert r.status_code == 200, r.text
        return [p["title"] for p in r.json()]

    assert titles("nistkästen") == ["Hühner"]
    hit = api.get("/api/search", params={"q": "NISTKÄSTEN"}, headers=h).json()[0]
    assert "Nistkästen" in hit["snippet"] and hit["path"] == "Work"
    # Title matches first.
    assert titles("stall") == ["Stall plan", "Hühner"]
    # Every word, anywhere on the page.
    assert titles("nist stall") == ["Hühner"]
    assert titles("futterkosten") == ["Kosten"]
    # LIKE's wildcards are plain characters.
    assert titles("%") == [] and titles("_") == []
    assert titles("stall", workspace="Private") == []

    # Nobody else's pages.
    stranger = token_headers(client, "stranger@example.com")
    push(client, page(new_id(), root_of(client), "Nistkästen bei mir"))
    assert titles("nistkästen") == ["Hühner"]
    r = api.get("/api/search", params={"q": "nistkästen"}, headers=stranger)
    assert [p["title"] for p in r.json()] == ["Nistkästen bei mir"]


# --- Reading a page ------------------------------------------------------------------


def test_a_page_reads_as_markdown_with_its_place_in_the_tree(client, api):
    h = token_headers(client)
    root = root_of(client)
    pid, child = new_id(), new_id()
    push(client, page(pid, root, "Hühner"), page(child, pid, "Rassen"),
         mutation("block", new_id(), {"page_id": pid, "type": "heading_2", "text": "Bestand", "position": 1}),
         mutation("block", new_id(), {"page_id": pid, "type": "to_do", "text": "Eier holen",
                                      "props": {"checked": True}, "position": 2}))

    r = api.get(f"/api/pages/{pid}", headers=h)
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["title"] == "Hühner" and p["workspace"] == "Work" and p["trashed"] is False
    assert p["markdown"] == "# Hühner\n\n## Bestand\n\n- [x] Eier holen\n"
    assert p["ancestors"] == [{"id": root, "title": "Work", "kind": "page"}]
    assert [c["title"] for c in p["children"]] == ["Rassen"]
    assert p["edited_at"] and p["created_at"]

    md = api.get(f"/api/pages/{pid}/markdown", headers=h)
    assert md.status_code == 200 and md.text == p["markdown"]

    push(client, mutation("page", pid, {"deleted": True}))
    assert api.get(f"/api/pages/{pid}", headers=h).json()["trashed"] is True
    assert api.get(f"/api/pages/{child}", headers=h).json()["trashed"] is True

    stranger = token_headers(client, "stranger@example.com")
    assert api.get(f"/api/pages/{pid}", headers=stranger).status_code == 404
    assert api.get(f"/api/pages/{pid}/markdown", headers=stranger).status_code == 404


def test_files_download_with_the_token(client, api):
    h = token_headers(client)
    pid = new_id()
    push(client, page(pid, root_of(client), "Docs"))
    f = client.post("/api/files", files={"file": ("hen.png", PNG, "image/png")}, data={"page_id": pid}).json()

    got = api.get(f["url"], headers=h)
    assert got.status_code == 200 and got.content == PNG
    assert api.get(f["url"]).status_code == 404
    assert api.get(f["url"], headers=token_headers(client, "stranger@example.com")).status_code == 404


# --- Writing -------------------------------------------------------------------------


def test_a_page_is_created_from_markdown_and_syncs_to_the_app(client, api):
    h = token_headers(client)
    root = root_of(client)
    cursor = pull_all(client)["cursor"]
    md = ("# Einkauf\n\n- Eier\n    - braun\n- [ ] Mehl\n\n"
          "<details>\n<summary>Mehr</summary>\n\nZucker\n\n</details>\n")

    r = api.post("/api/pages", json={"workspace": "Work", "markdown": md, "icon": "🥚"}, headers=h)
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["title"] == "Einkauf" and p["icon"] == "🥚" and p["parent_id"] == root
    assert p["last_edited_by"] == "API" and p["path"] == "Work"
    assert p["markdown"] == md

    # The app pulls it like any other change, the tree intact.
    delta = pull_all(client, cursor=cursor)
    assert [x["id"] for x in delta["pages"]] == [p["id"]]
    blocks = {b["text"]: b for b in delta["blocks"]}
    assert blocks["braun"]["parent_id"] == blocks["Eier"]["id"]
    assert blocks["Zucker"]["parent_id"] == blocks["Mehr"]["id"] and blocks["Mehr"]["type"] == "toggle"
    assert blocks["Mehl"]["props"] == {"checked": False}
    assert all(b["rev"] > cursor for b in delta["blocks"])

    # Page history names the API.
    sessions = client.get(f"/api/pages/{p['id']}/history").json()["sessions"]
    assert [s["editors"] for s in sessions] == [["API"]]

    # Under a page, after its siblings. An explicit title keeps the heading.
    first = api.post("/api/pages", json={"parent_id": p["id"], "title": "Montag"}, headers=h).json()
    second = api.post("/api/pages", json={"parent_id": p["id"], "title": "Dienstag", "markdown": "# Plan\n\nText"},
                      headers=h).json()
    assert second["title"] == "Dienstag" and second["markdown"] == "# Dienstag\n\n# Plan\n\nText\n"
    pages = {x["id"]: x for x in pull_all(client)["pages"]}
    assert pages[second["id"]]["position"] > pages[first["id"]]["position"]
    assert first["markdown"] == "# Montag\n"


def test_creating_a_page_needs_a_live_place_of_your_own(client, api):
    h = token_headers(client)
    root = root_of(client)
    trash = new_id()
    push(client, page(trash, root, "Weg"))
    push(client, mutation("page", trash, {"deleted": True}))

    def status(body, headers=h):
        return api.post("/api/pages", json=body, headers=headers).status_code

    assert status({"title": "Nirgends"}) == 400
    assert status({"workspace": "Farm"}) == 404
    assert status({"parent_id": new_id()}) == 404
    assert status({"parent_id": trash}) == 409
    assert status({"parent_id": root}, headers=token_headers(client, "stranger@example.com")) == 404
    assert status({"parent_id": root, "markdown": "- x\n" * 2001}) == 422
    sign_in(client)
    assert {x["title"] for x in pull_all(client)["pages"]} == {"Work", "Private", "Weg"}


def test_a_refused_write_leaves_nothing_behind(client, api, monkeypatch):
    from app.routers import token_api
    from app.syncing import Refused

    h = token_headers(client)
    real = token_api.apply
    calls = []

    def flaky(db, m, scope):
        calls.append(m.entity)
        if len(calls) == 3:
            raise Refused("No")
        return real(db, m, scope)

    monkeypatch.setattr(token_api, "apply", flaky)
    r = api.post("/api/pages", json={"workspace": "Work", "markdown": "eins\n\nzwei\n\ndrei"}, headers=h)
    assert r.status_code == 422 and r.json()["detail"] == "No"
    data = pull_all(client)
    assert {x["title"] for x in data["pages"]} == {"Work", "Private"} and data["blocks"] == []


def test_images_and_file_links_read_as_the_editor_reads_them(client, api):
    h = token_headers(client)
    md = ("![hen](/api/files/abc/hen.png)\n\n![web](https://example.com/x.png)\n\n![rel](img/x.png)\n\n"
          "[Rechnung.pdf](/api/files/def/Rechnung.pdf)\n\n[Seite](/p/xyz)")
    p = api.post("/api/pages", json={"workspace": "Work", "title": "Medien", "markdown": md}, headers=h).json()
    blocks = sorted((b for b in pull_all(client)["blocks"] if b["page_id"] == p["id"]), key=lambda b: b["position"])
    assert [(b["type"], b["text"], b["props"]) for b in blocks] == [
        ("image", "hen", {"file_id": "abc", "name": "hen.png"}),
        ("image", "web", {"url": "https://example.com/x.png"}),
        ("paragraph", "![rel](img/x.png)", {}),
        ("file", "", {"file_id": "def", "name": "Rechnung.pdf"}),
        ("paragraph", "[Seite](/p/xyz)", {}),
    ]


def test_markdown_is_appended_at_the_end_of_a_page(client, api):
    h = token_headers(client)
    pid = new_id()
    push(client, page(pid, root_of(client), "Log"), block(new_id(), pid, "Erster Eintrag", 5))

    r = api.post(f"/api/pages/{pid}/append", json={"markdown": "Zweiter Eintrag\n\n- mit Punkt"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["markdown"] == "# Log\n\nErster Eintrag\n\nZweiter Eintrag\n\n- mit Punkt\n"
    top = sorted(b["position"] for b in pull_all(client)["blocks"] if b["page_id"] == pid and not b["parent_id"])
    assert top == [5.0, 6.0, 7.0]

    assert api.post(f"/api/pages/{pid}/append", json={"markdown": ""}, headers=h).status_code == 422
    assert api.post(f"/api/pages/{new_id()}/append", json={"markdown": "x"}, headers=h).status_code == 404
    stranger = token_headers(client, "stranger@example.com")
    assert api.post(f"/api/pages/{pid}/append", json={"markdown": "x"}, headers=stranger).status_code == 404
    sign_in(client)
    push(client, mutation("page", pid, {"deleted": True}))
    assert api.post(f"/api/pages/{pid}/append", json={"markdown": "x"}, headers=h).status_code == 409


# --- Edge cases ----------------------------------------------------------------------


def test_search_reads_values_not_json_keys(client, api):
    h = token_headers(client)
    root = root_of(client)
    table, files, mark, herd, row = new_id(), new_id(), new_id(), new_id(), new_id()
    push(client,
         page(table, root, "Tabelle", 1), page(files, root, "Ablage", 2), page(mark, root, "Links", 3),
         page(herd, root, "Herde", 4, kind="database",
              schema={"properties": [{"id": "title", "name": "Name", "type": "title"},
                                     {"id": "p_note", "name": "Notiz", "type": "text"}]}),
         mutation("block", new_id(), {"page_id": table, "type": "table", "text": "",
                                      "props": {"rows": [["Pfad", 'Sie sagt "hallo"'], ["C:\\temp", "x"]],
                                                "header_row": True}}),
         mutation("block", new_id(), {"page_id": files, "type": "file", "text": "",
                                      "props": {"file_id": "f1234", "name": "Rechnung.pdf"}}),
         mutation("block", new_id(), {"page_id": mark, "type": "bookmark", "text": "",
                                      "props": {"url": "https://example.com", "title": "Beispielseite"}}),
         mutation("block", new_id(), {"page_id": table, "type": "to_do", "text": "Erledigt",
                                      "props": {"checked": True}}))
    push(client, page(row, herd, "Berta", props={"p_note": "lahmt vorne links"}))

    def titles(q):
        r = api.get("/api/search", params={"q": q}, headers=h)
        assert r.status_code == 200, r.text
        return sorted(p["title"] for p in r.json())

    for key in ("rows", "header_row", "true", "name", "file_id", "f1234", "url", "checked", "p_note"):
        assert titles(key) == [], key
    assert titles('"hallo"') == ["Tabelle"]
    assert titles("C:\\temp") == ["Tabelle"]
    assert titles("rechnung") == ["Ablage"]
    assert titles("beispielseite") == ["Links"]
    assert titles("example.com") == ["Links"]
    assert titles("lahmt") == ["Berta"]


def test_link_titles_are_not_part_of_the_address(client, api):
    h = token_headers(client)
    md = ('![a](https://e.com/x.png "Ein Titel")\n\n![b](<https://e.com/y z.png>)\n\n'
          "[Plan.pdf](/api/files/abc 'T')\n\n![c](https://e.com/x.png kein Titel)")
    p = api.post("/api/pages", json={"workspace": "Work", "title": "T", "markdown": md}, headers=h).json()
    blocks = sorted((b for b in pull_all(client)["blocks"] if b["page_id"] == p["id"]), key=lambda b: b["position"])
    assert [(b["type"], b["props"]) for b in blocks] == [
        ("image", {"url": "https://e.com/x.png"}),
        ("image", {"url": "https://e.com/y z.png"}),
        ("file", {"file_id": "abc", "name": "Plan.pdf"}),
        ("paragraph", {}),
    ]


def test_bad_input_is_refused_without_writing(client, api):
    h = token_headers(client)
    root = root_of(client)
    assert api.post("/api/pages", json={"workspace": "Work", "markdown": "a\x00b"}, headers=h).status_code == 422
    assert api.post("/api/pages", json={"parent_id": root, "title": "a\x00"}, headers=h).status_code == 422
    assert api.post(f"/api/pages/{root}/append", json={"markdown": "\x00"}, headers=h).status_code == 422
    assert api.get("/api/search", params={"q": "a\x00b"}, headers=h).status_code == 422
    assert api.get("/api/pages", params={"workspace": "W\x00"}, headers=h).status_code == 422
    deep = "".join("    " * i + "- x\n" for i in range(41))
    r = api.post("/api/pages", json={"workspace": "Work", "markdown": deep}, headers=h)
    assert r.status_code == 422 and "40 levels" in r.json()["detail"]
    ok = "".join("    " * i + "- x\n" for i in range(40))
    assert api.post("/api/pages", json={"workspace": "Work", "markdown": ok}, headers=h).status_code == 201
    assert len([x for x in pull_all(client)["pages"] if x["title"] not in ("Work", "Private")]) == 1


def test_the_header_wins_over_a_bad_query_token(client, api):
    h = token_headers(client)
    assert api.get("/api/workspaces", params={"token": "stale"}, headers=h).status_code == 200


def test_a_purged_page_is_gone(client, api):
    h = token_headers(client)
    pid = new_id()
    push(client, page(pid, root_of(client), "Weg"))
    push(client, mutation("page", pid, {"deleted": True}))
    assert client.delete(f"/api/pages/{pid}").status_code == 200

    assert api.get(f"/api/pages/{pid}", headers=h).status_code == 404
    assert api.post("/api/pages", json={"parent_id": pid}, headers=h).status_code == 404
    assert api.post(f"/api/pages/{pid}/append", json={"markdown": "x"}, headers=h).status_code == 404
    assert api.get("/api/pages", params={"parent": pid}, headers=h).status_code == 404


def test_appends_at_the_same_time_do_not_interleave(client, api):
    import threading

    from fastapi.testclient import TestClient

    from app.main import app

    h = token_headers(client)
    pid = new_id()
    push(client, page(pid, root_of(client), "Log"))
    status = {}

    def run(name, md):
        status[name] = TestClient(app).post(f"/api/pages/{pid}/append", json={"markdown": md}, headers=h).status_code

    threads = [threading.Thread(target=run, args=("A", "\n\n".join(f"A{i}" for i in range(150)))),
               threading.Thread(target=run, args=("B", "B0\n\nB1\n\nB2"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert status == {"A": 200, "B": 200}
    blocks = sorted((b for b in pull_all(client)["blocks"] if b["page_id"] == pid), key=lambda b: b["position"])
    assert len({b["position"] for b in blocks}) == len(blocks) == 153
    order = "".join(b["text"][0] for b in blocks)
    assert order in ("A" * 150 + "BBB", "BBB" + "A" * 150)


# --- Replacing a page's Markdown -----------------------------------------------------


def typed(bid, page_id, type_, text="", position=1.0, **extra) -> dict:
    return mutation("block", bid, {"page_id": page_id, "type": type_, "text": text, "position": position, **extra})


def live_blocks(client, pid) -> list[dict]:
    return [b for b in pull_all(client)["blocks"] if b["page_id"] == pid and not b["deleted"]]


def by_text(client, pid) -> dict:
    return {b["text"]: b for b in live_blocks(client, pid)}


TABLE_PROPS = {"rows": [["Tier", "Anzahl"], ["Huhn", "3"]], "header_row": True, "header_col": True, "color": "gray"}


def test_replacing_the_markdown_writes_only_what_differs(client, api):
    h = token_headers(client)
    pid, head, para, gone, inner, table = (new_id() for _ in range(6))
    push(client, page(pid, root_of(client), "Stall"),
         typed(head, pid, "heading_2", "Bestand", 1, props={"color": "red"}),
         block(para, pid, "Bleibt", 2, props={"color": "blue"}),
         typed(gone, pid, "toggle", "Weg", 3),
         block(inner, pid, "Darin", 1, parent_id=gone),
         typed(table, pid, "table", "", 4, props=TABLE_PROPS))
    cursor = pull_all(client)["cursor"]

    md = "# Stall\n\n## Bestand\n\nBleibt\n\n| Tier | Anzahl |\n| --- | --- |\n| Huhn | 5 |\n\nNeu am Ende\n"
    r = api.put(f"/api/pages/{pid}/markdown", json={"markdown": md}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["markdown"] == md
    assert [b["type"] for b in r.json()["blocks"]] == ["heading_2", "paragraph", "table", "paragraph"]

    delta = {b["id"]: b for b in pull_all(client, cursor=cursor)["blocks"]}
    new = next(i for i, b in delta.items() if b["text"] == "Neu am Ende")
    assert set(delta) == {table, gone, inner, new}, "the heading and the paragraph were not written"
    assert delta[gone]["deleted"] and delta[inner]["deleted"]
    # The table is the same block with new cells, and keeps what Markdown cannot say.
    assert delta[table]["props"] == {**TABLE_PROPS, "rows": [["Tier", "Anzahl"], ["Huhn", "5"]]}
    assert delta[new]["position"] > delta[table]["position"]
    assert "API" in client.get(f"/api/pages/{pid}/history").json()["sessions"][0]["editors"]


def rich_page(client, pid) -> dict:
    """A page with every kind of block, much of it more than Markdown can say."""
    root = root_of(client)
    other, herd = new_id(), new_id()
    push(client, page(pid, root, "Reich"), page(other, root, "Andere"), page(herd, root, "Herde", kind="database"))
    toggle, item, heading, grid, cell, ids = new_id(), new_id(), new_id(), new_id(), new_id(), {}
    rows = [
        block(new_id(), pid, "Anker", 1, props={"color": "blue_bg"}),
        typed(new_id(), pid, "page", "", 2, props={"page_id": other}),
        typed(new_id(), pid, "database", "", 3, props={"page_id": herd, "view_id": "v1"}),
        typed(new_id(), pid, "bookmark", "", 4, props={"url": "https://example.com", "title": "Beispiel"}),
        typed(new_id(), pid, "image", "", 5, props={"file_id": "f1", "name": "hen.png", "width": 300}),
        typed(new_id(), pid, "file", "Eine Bildunterschrift", 6, props={"file_id": "f2", "name": "a.pdf", "size": 9}),
        block(new_id(), pid, "", 7),
        typed(toggle, pid, "toggle", "Mehr", 8, props={"color": "red"}),
        block(new_id(), pid, "Innen", 1, parent_id=toggle),
        typed(item, pid, "bulleted_list", "Punkt", 9),
        typed(new_id(), pid, "to_do", "Unter", 1, parent_id=item, props={"checked": True}),
        typed(new_id(), pid, "numbered_list", "Eins", 10),
        typed(new_id(), pid, "numbered_list", "Zwei", 11),
        typed(new_id(), pid, "quote", "Zitat\nZweite Zeile", 12),
        typed(new_id(), pid, "callout", "Achtung", 13, props={"icon": "🐔", "color": "yellow_bg"}),
        typed(new_id(), pid, "code", "x = 1\n\ny = 2", 14, props={"language": "python"}),
        typed(new_id(), pid, "equation", "a^2", 15),
        typed(new_id(), pid, "divider", "", 16),
        typed(new_id(), pid, "table", "", 17, props={"rows": [["a|b", "c\nd"], ["e", ""]], "header_row": False}),
        typed(heading, pid, "heading_2", "Überschrift", 18),
        # Markdown does not show what is under a heading.
        block(new_id(), pid, "Unter der Überschrift", 1, parent_id=heading),
        typed(grid, pid, "grid", "", 19, props={"columns": 2}),
        typed(cell, pid, "grid_cell", "", 1, parent_id=grid),
        block(new_id(), pid, "In der Zelle", 1, parent_id=cell),
        typed(new_id(), pid, "grid_cell", "", 2, parent_id=grid),
    ]
    push(client, *rows)
    ids["all"] = {r["id"] for r in rows}
    return ids


def test_sending_the_markdown_back_changes_nothing(client, api):
    h = token_headers(client)
    pid = new_id()
    rich_page(client, pid)
    # What Markdown reads differently from how it was stored.
    para = new_id()
    push(client, block(para, pid, "Eltern", 20), block(new_id(), pid, "Kind", 1, parent_id=para),
         block(new_id(), pid, "Mit\n\nLeerzeile", 21))
    before = client.get(f"/api/pages/{pid}/history").json()["sessions"]
    cursor = pull_all(client)["cursor"]

    md = api.get(f"/api/pages/{pid}/markdown", headers=h).text
    r = api.put(f"/api/pages/{pid}/markdown", json={"markdown": md}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["markdown"] == md
    delta = pull_all(client, cursor=cursor)
    assert (delta["blocks"], delta["pages"]) == ([], [])
    assert client.get(f"/api/pages/{pid}/history").json()["sessions"] == before


def test_an_edit_elsewhere_leaves_what_markdown_cannot_say_alone(client, api):
    h = token_headers(client)
    pid = new_id()
    rich_page(client, pid)
    cursor = pull_all(client)["cursor"]
    anchor = next(b for b in live_blocks(client, pid) if b["text"] == "Anker")
    md = api.get(f"/api/pages/{pid}/markdown", headers=h).text

    r = api.put(f"/api/pages/{pid}/markdown", json={"markdown": md.replace("Anker", "Neuer Anker")}, headers=h)
    assert r.status_code == 200, r.text
    delta = pull_all(client, cursor=cursor)["blocks"]
    assert [b["id"] for b in delta] == [anchor["id"]]
    assert delta[0]["text"] == "Neuer Anker" and delta[0]["props"] == {"color": "blue_bg"}


def test_replacing_nested_blocks_and_a_grid(client, api):
    h = token_headers(client)
    pid = new_id()
    rich_page(client, pid)
    before = by_text(client, pid)
    md = api.get(f"/api/pages/{pid}/markdown", headers=h).text
    md = md.replace("Innen", "Innen neu").replace("- [x] Unter", "- [ ] Unter").replace("In der Zelle", "Zelle neu")

    assert api.put(f"/api/pages/{pid}/markdown", json={"markdown": md}, headers=h).status_code == 200
    after = by_text(client, pid)
    assert after["Innen neu"]["id"] == before["Innen"]["id"]
    assert after["Innen neu"]["parent_id"] == before["Mehr"]["id"]
    assert after["Unter"]["id"] == before["Unter"]["id"] and after["Unter"]["props"] == {"checked": False}
    assert after["Zelle neu"]["id"] == before["In der Zelle"]["id"]
    # A paragraph under a heading is not in the Markdown, so it stays.
    assert after["Unter der Überschrift"]["id"] == before["Unter der Überschrift"]["id"]


def test_empty_blocks_stay_unless_the_block_before_them_goes(client, api):
    h = token_headers(client)
    pid, keep, spacer, doomed, lost = (new_id() for _ in range(5))
    push(client, page(pid, root_of(client), "Luft"), block(keep, pid, "A", 1), block(spacer, pid, "", 2),
         block(doomed, pid, "- B", 3), block(lost, pid, "", 4), block(new_id(), pid, "C", 5))

    r = api.put(f"/api/pages/{pid}/markdown", json={"markdown": "A\n\nC"}, headers=h)
    assert r.status_code == 200, r.text
    assert [b["id"] for b in r.json()["blocks"] if b["text"] != "C"] == [keep, spacer]


def test_the_title_comes_from_the_heading_unless_one_is_given(client, api):
    h = token_headers(client)
    pid, blank = new_id(), new_id()
    push(client, page(pid, root_of(client), "Alt"), page(blank, root_of(client), "", 2))

    def put(body, target=pid):
        r = api.put(f"/api/pages/{target}/markdown", json=body, headers=h)
        assert r.status_code == 200, r.text
        return r.json()

    p = put({"markdown": "# Neu\n\nText"})
    assert p["title"] == "Neu" and p["markdown"] == "# Neu\n\nText\n" and p["last_edited_by"] == "API"
    p = put({"markdown": "# Block\n\nText", "title": "Titel"})
    assert p["title"] == "Titel" and p["markdown"] == "# Titel\n\n# Block\n\nText\n"
    p = put({"markdown": "Nur Text"})
    assert p["title"] == "Titel" and p["markdown"] == "# Titel\n\nNur Text\n"
    p = put({"markdown": ""})
    assert p["title"] == "Titel" and p["markdown"] == "# Titel\n" and p["blocks"] == []
    # The export's name for no title is not a title.
    assert put({"markdown": api.get(f"/api/pages/{blank}/markdown", headers=h).text}, blank)["title"] == ""


def test_a_replacement_is_refused_where_it_cannot_apply(client, api):
    h = token_headers(client)
    root = root_of(client)
    pid, trash, herd = new_id(), new_id(), new_id()
    push(client, page(pid, root, "Hier"), page(trash, root, "Weg", 2), page(herd, root, "Herde", 3, kind="database"))
    push(client, mutation("page", trash, {"deleted": True}))

    def status(target, body=None, headers=h):
        return api.put(f"/api/pages/{target}/markdown", json=body or {"markdown": "x"}, headers=headers).status_code

    assert status(trash) == 409 and status(new_id()) == 404 and status(herd) == 422
    assert status(pid, {"title": "ohne Markdown"}) == 422
    assert status(pid, {"markdown": "a\x00"}) == 422
    assert status(pid, {"markdown": "- x\n" * 2001}) == 422
    assert status(pid, headers=token_headers(client, "stranger@example.com")) == 404
    sign_in(client)
    assert live_blocks(client, pid) == []


# --- Editing blocks ------------------------------------------------------------------


def test_blocks_are_listed_in_document_order_with_their_ids(client, api):
    h = token_headers(client)
    pid, item, gone = new_id(), new_id(), new_id()
    push(client, page(pid, root_of(client), "Liste"),
         typed(item, pid, "bulleted_list", "Oben", 2), block(new_id(), pid, "Davor", 1),
         typed(new_id(), pid, "bulleted_list", "Unten", 1, parent_id=item),
         block(gone, pid, "Gelöscht", 3))
    push(client, mutation("block", gone, {"deleted": True}))

    r = api.get(f"/api/pages/{pid}/blocks", headers=h)
    assert r.status_code == 200, r.text
    got = r.json()
    assert [(b["text"], b["depth"]) for b in got] == [("Davor", 0), ("Oben", 0), ("Unten", 1)]
    assert got[2]["parent_id"] == item and got[1]["id"] == item and got[1]["type"] == "bulleted_list"
    assert got[1]["markdown"] == "- Oben\n    - Unten"

    stranger = token_headers(client, "stranger@example.com")
    assert api.get(f"/api/pages/{pid}/blocks", headers=stranger).status_code == 404
    assert api.get(f"/api/pages/{new_id()}/blocks", headers=h).status_code == 404


def test_a_table_is_edited_through_its_props(client, api):
    h = token_headers(client)
    pid, table = new_id(), new_id()
    push(client, page(pid, root_of(client), "T"), typed(table, pid, "table", "", 1, props=TABLE_PROPS))
    cursor = pull_all(client)["cursor"]

    rows = [["Tier", "Anzahl"], ["Huhn", "7"]]
    r = api.patch(f"/api/blocks/{table}", json={"props": {"rows": rows, "color": None}}, headers=h)
    assert r.status_code == 200, r.text
    assert "| Huhn | 7 |" in r.json()["markdown"]
    assert r.json()["blocks"][0]["id"] == table
    delta = pull_all(client, cursor=cursor)["blocks"]
    assert [b["id"] for b in delta] == [table]
    assert delta[0]["props"] == {"rows": rows, "header_row": True, "header_col": True}, "merged, and null removes"


def test_a_table_is_edited_through_its_markdown_in_place(client, api):
    h = token_headers(client)
    pid, table = new_id(), new_id()
    push(client, page(pid, root_of(client), "T"), typed(table, pid, "table", "", 1, props=TABLE_PROPS))

    md = "| Tier | Anzahl |\n| --- | --- |\n| Ente | 2 |"
    r = api.patch(f"/api/blocks/{table}", json={"markdown": md}, headers=h)
    assert r.status_code == 200, r.text
    assert [b["id"] for b in r.json()["blocks"]] == [table]
    got = live_blocks(client, pid)[0]["props"]
    assert got == {**TABLE_PROPS, "rows": [["Tier", "Anzahl"], ["Ente", "2"]]}


def test_a_block_changes_its_text_and_type(client, api):
    h = token_headers(client)
    pid, para, child = new_id(), new_id(), new_id()
    push(client, page(pid, root_of(client), "T"), typed(para, pid, "toggle", "Alt", 1, props={"color": "red"}),
         block(child, pid, "Bleibt", 1, parent_id=para))

    r = api.patch(f"/api/blocks/{para}", json={"text": "Neu **fett**", "type": "paragraph"}, headers=h)
    assert r.status_code == 200, r.text
    b = by_text(client, pid)
    assert b["Neu **fett**"]["id"] == para and b["Neu **fett**"]["type"] == "paragraph"
    assert b["Neu **fett**"]["props"] == {"color": "red"}
    assert b["Bleibt"]["parent_id"] == para, "text, type and props leave what is nested alone"


def test_a_block_is_rewritten_as_several_in_its_place(client, api):
    h = token_headers(client)
    pid, first, mid, last = (new_id() for _ in range(4))
    push(client, page(pid, root_of(client), "T"), block(first, pid, "A", 1), block(mid, pid, "B", 2),
         block(last, pid, "C", 3))

    r = api.patch(f"/api/blocks/{mid}", json={"markdown": "B1\n\n## B2\n\n- B3"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["markdown"] == "# T\n\nA\n\nB1\n\n## B2\n\n- B3\n\nC\n"
    ids = [b["id"] for b in r.json()["blocks"]]
    assert (ids[0], ids[1], ids[-1]) == (first, mid, last), "the paragraph stays, the rest is new"

    # Of a different type, it is a different block.
    r = api.patch(f"/api/blocks/{mid}", json={"markdown": "- Liste"}, headers=h)
    assert r.status_code == 200, r.text
    got = r.json()["blocks"]
    assert got[1]["type"] == "bulleted_list" and got[1]["id"] != mid
    assert r.json()["markdown"] == "# T\n\nA\n\n- Liste\n\n## B2\n\n- B3\n\nC\n"


def test_a_cells_markdown_is_its_content(client, api):
    h = token_headers(client)
    pid, grid, cell, other = (new_id() for _ in range(4))
    push(client, page(pid, root_of(client), "G"), typed(grid, pid, "grid", "", 1, props={"columns": 2}),
         typed(cell, pid, "grid_cell", "", 1, parent_id=grid), typed(other, pid, "grid_cell", "", 2, parent_id=grid),
         block(new_id(), pid, "Alt", 1, parent_id=cell))

    r = api.patch(f"/api/blocks/{cell}", json={"markdown": "Neu\n\nZwei"}, headers=h)
    assert r.status_code == 200, r.text
    got = r.json()["blocks"]
    assert [(b["type"], b["text"], b["depth"]) for b in got] == [
        ("grid", "", 0), ("grid_cell", "", 1), ("paragraph", "Neu", 2), ("paragraph", "Zwei", 2), ("grid_cell", "", 1),
    ]
    assert got[1]["id"] == cell
    r = api.patch(f"/api/blocks/{cell}", json={"markdown": ""}, headers=h)
    assert r.status_code == 200 and [b["type"] for b in r.json()["blocks"]] == ["grid", "grid_cell", "grid_cell"]

    # Nothing but cells goes into a grid, and a cell goes with its grid.
    def insert(**where):
        return api.post(f"/api/pages/{pid}/blocks", json={"markdown": "x", **where}, headers=h).status_code

    assert insert(parent_id=grid) == 422 and insert(after=cell) == 422 and insert(before=other) == 422
    assert insert(parent_id=cell) == 200
    assert api.delete(f"/api/blocks/{other}", headers=h).status_code == 422


def test_bad_block_edits_are_refused_without_writing(client, api):
    h = token_headers(client)
    pid, para, table, trash, gone, in_trash = (new_id() for _ in range(6))
    root = root_of(client)
    push(client, page(pid, root, "T"), page(trash, root, "Weg", 2), block(para, pid, "A", 1),
         typed(table, pid, "table", "", 2, props=TABLE_PROPS), block(gone, pid, "G", 3),
         block(in_trash, trash, "X", 1))
    push(client, mutation("block", gone, {"deleted": True}), mutation("page", trash, {"deleted": True}))
    cursor = pull_all(client)["cursor"]

    def status(block_id, body, headers=h):
        return api.patch(f"/api/blocks/{block_id}", json=body, headers=headers).status_code

    assert status(para, {}) == 422
    assert status(para, {"markdown": "x", "text": "y"}) == 422
    assert status(para, {"markdown": "   "}) == 422
    assert status(para, {"text": "a\x00"}) == 422
    assert status(para, {"props": {"a": ["b\x00"]}}) == 422
    assert status(para, {"type": "table"}) == 422
    assert status(table, {"type": "paragraph"}) == 422
    assert status(table, {"text": "| a |"}) == 422
    for rows in ([], "x", [["a"], "b"], [["a", 1]], None):
        assert status(table, {"props": {"rows": rows}}) == 422, rows
    bad = api.patch(f"/api/blocks/{para}", content='{"props": {"x": NaN}}',
                    headers={**h, "Content-Type": "application/json"})
    assert bad.status_code == 422
    assert status(gone, {"text": "x"}) == 404 and status(new_id(), {"text": "x"}) == 404
    assert api.patch("/api/blocks/a%00b", json={"text": "x"}, headers=h).status_code == 404
    assert status(in_trash, {"text": "x"}) == 409
    assert status(para, {"text": "x"}, headers=token_headers(client, "stranger@example.com")) == 404
    sign_in(client)
    assert pull_all(client, cursor=cursor)["blocks"] == []


def test_an_edit_a_newer_device_write_beats_is_refused(client, api):
    h = token_headers(client)
    pid, para = new_id(), new_id()
    push(client, page(pid, root_of(client), "T"), block(para, pid, "A", 1))
    push(client, mutation("block", para, {"text": "Vom Gerät"}, at=now_iso(200)))

    r = api.patch(f"/api/blocks/{para}", json={"text": "Von der API"}, headers=h)
    assert r.status_code == 422 and "newer" in r.json()["detail"]
    assert live_blocks(client, pid)[0]["text"] == "Vom Gerät"


def test_a_change_that_writes_too_many_blocks_is_refused(client, api, monkeypatch):
    from app.routers import token_api

    h = token_headers(client)
    pid = new_id()
    push(client, page(pid, root_of(client), "T"), *(block(new_id(), pid, str(i), i) for i in range(1, 6)))
    monkeypatch.setattr(token_api, "MAX_BLOCKS", 3)

    r = api.put(f"/api/pages/{pid}/markdown", json={"markdown": ""}, headers=h)
    assert r.status_code == 422 and "more than 3" in r.json()["detail"]
    assert len(live_blocks(client, pid)) == 5, "all of it or none"


def test_blocks_are_inserted_where_asked(client, api):
    h = token_headers(client)
    pid, first, toggle, last = (new_id() for _ in range(4))
    push(client, page(pid, root_of(client), "T"), block(first, pid, "A", 1), typed(toggle, pid, "toggle", "M", 2),
         block(last, pid, "Z", 3))

    def insert(md, **where):
        r = api.post(f"/api/pages/{pid}/blocks", json={"markdown": md, **where}, headers=h)
        assert r.status_code == 200, r.text
        return [(b["text"], b["depth"]) for b in r.json()["blocks"]]

    assert [t for t, _ in insert("A1\n\nA2", after=first)] == ["A", "A1", "A2", "M", "Z"]
    assert [t for t, _ in insert("Y", before=last)] == ["A", "A1", "A2", "M", "Y", "Z"]
    assert [t for t, _ in insert("Start", before=first)] == ["Start", "A", "A1", "A2", "M", "Y", "Z"]
    got = insert("In M", parent_id=toggle)
    assert got[got.index(("M", 0)) + 1] == ("In M", 1)
    assert insert("Ende")[-1] == ("Ende", 0)
    top = sorted(b["position"] for b in live_blocks(client, pid) if not b["parent_id"])
    assert len(set(top)) == len(top)

    def status(body, target=pid):
        return api.post(f"/api/pages/{target}/blocks", json=body, headers=h).status_code

    assert status({"markdown": "x", "after": first, "before": last}) == 422
    assert status({"markdown": "x", "after": new_id()}) == 404
    assert status({"markdown": ""}) == 422
    assert status({"markdown": "x"}, new_id()) == 404


def test_a_block_from_another_page_is_no_place_to_insert(client, api):
    h = token_headers(client)
    root = root_of(client)
    a, b, there = new_id(), new_id(), new_id()
    push(client, page(a, root, "A"), page(b, root, "B", 2), block(there, b, "Dort", 1))
    r = api.post(f"/api/pages/{a}/blocks", json={"markdown": "x", "after": there}, headers=h)
    assert r.status_code == 404
    assert live_blocks(client, a) == []


def test_siblings_are_renumbered_when_there_is_no_room_between_them(client, api):
    h = token_headers(client)
    pid, first, second = new_id(), new_id(), new_id()
    push(client, page(pid, root_of(client), "T"), block(first, pid, "A", 1.0), block(second, pid, "C", 1.0 + 1e-7))

    r = api.post(f"/api/pages/{pid}/blocks", json={"markdown": "B", "after": first}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["markdown"] == "# T\n\nA\n\nB\n\nC\n"
    assert sorted(b["position"] for b in live_blocks(client, pid)) == [1.0, 2.0, 3.0]


def test_a_block_is_deleted_with_what_is_nested_in_it(client, api):
    h = token_headers(client)
    pid, toggle, inner, deeper, stays = (new_id() for _ in range(5))
    push(client, page(pid, root_of(client), "T"), typed(toggle, pid, "toggle", "M", 1),
         typed(inner, pid, "toggle", "N", 1, parent_id=toggle), block(deeper, pid, "O", 1, parent_id=inner),
         block(stays, pid, "Bleibt", 2))
    cursor = pull_all(client)["cursor"]

    r = api.delete(f"/api/blocks/{toggle}", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["markdown"] == "# T\n\nBleibt\n"
    delta = pull_all(client, cursor=cursor)["blocks"]
    assert {b["id"] for b in delta} == {toggle, inner, deeper} and all(b["deleted"] for b in delta)
    assert api.delete(f"/api/blocks/{toggle}", headers=h).status_code == 404
    assert api.delete(f"/api/blocks/{stays}", headers=token_headers(client, "stranger@example.com")).status_code == 404
