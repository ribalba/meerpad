"""The token API: the page tree, search, pages as Markdown, and pages written from
Markdown, with the API token as ``?token=`` or a Bearer header. Writes go
through the sync engine, so the app pulls them like any other edit."""

import uuid

import pytest

from tests.helpers import mutation, needs_db, pull_all, running_app, sign_in

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
