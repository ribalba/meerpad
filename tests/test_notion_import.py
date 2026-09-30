"""The Notion importer (app/notion_import.py) and its HTTP job API
(app/routers/imports.py), on a small synthetic export shaped like a real one:
nested pages, a database with ``_all.csv`` plus row pages (one titled with a
"/"), an inline database, an image, a PDF, an ``<aside>``, a table, links
between pages, a folder without its page, and an attachment-only folder."""

import io
import time
import zipfile
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from tests.helpers import needs_db, pull_all, running_app, sign_in

pytestmark = needs_db

HOME = "11111111111111111111111111111111"
ANIMALS = "22222222222222222222222222222222"
TASKS = "33333333333333333333333333333333"
BARN = "44444444444444444444444444444444"
FENCE = "55555555555555555555555555555555"
FEED = "66666666666666666666666666666666"
COOP = "77777777777777777777777777777777"
TEMPLATE = "88888888888888888888888888888888"
INLINE = "99999999999999999999999999999999"
INLINE_DB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CHILD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
HENS = "cccccccccccccccccccccccccccccccc"

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)
PDF = b"%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


def write(path: Path, text: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text, encoding="utf-8")


def build_export(root: Path) -> Path:
    """A miniature of Notion's "Markdown & CSV" export."""
    write(root / f"Farm Home {HOME}.md", f"""# Farm Home

<aside>
💡 Welcome to the farm

</aside>

[Animals](Farm%20Home/Animals%20{ANIMALS}.md)

[Tasks](Farm%20Home/Tasks%20{TASKS}.md)

See [the animals page](Farm%20Home/Animals%20{ANIMALS}.md) and [elsewhere](https://example.com).

| Name | Count |
| --- | --- |
| Hens | 12 |""")
    write(root / "Farm Home" / f"Animals {ANIMALS}.md", f"""# Animals

![Hen photo.png](Animals/hen_photo.png)

[Manual.pdf](Animals/Manual.pdf)

Read [Manual.pdf](Animals/Manual.pdf) first, and [Missing.pdf](Animals/Missing.pdf).

- Chickens
    - Sussex

[Barn](Animals/Barn%20{BARN}.md)""")
    write(root / "Farm Home" / "Animals" / "hen_photo.png", PNG)
    write(root / "Farm Home" / "Animals" / "Manual.pdf", PDF)
    write(root / "Farm Home" / "Animals" / f"Barn {BARN}.md",
          f"# Barn\n\nBack to [Farm Home](../../Farm%20Home%20{HOME}.md).")

    # A database: its page, the _all CSV (with a BOM and an empty row), a
    # shorter plain CSV that must be ignored, and row pages.
    write(root / "Farm Home" / f"Tasks {TASKS}.md",
          f"# Tasks\n\n[Tasks](Tasks%20{TASKS}_all.csv)\n\nfilters: \nStatus\nsort: \nPriority: descending")
    write(root / "Farm Home" / f"Tasks {TASKS}_all.csv",
          "﻿Name,Status,Priority,Done,Due,Estimate,Tags,Link,Contact,Photo\n"
          'Fix fence/gate,Next Up,High,No,"October 24, 2022 9:58 PM",2.5,"outside, urgent",'
          "https://example.com/fence,a@example.com,../Untitled%201234-abcd/logo.png\n"
          'Feed hens,Done,Low,Yes,"October 25, 2022",1,outside,,,\n'
          ",,,,,,,,,\n"
          'Clean coop,Next Up,Medium,No,2022/10/26,3,"inside, urgent",https://example.com/coop,,\n'
          # A title that is a link: the CSV has its URL, the page its text.
          "https://example.com/hens,Next Up,Low,No,,2,outside,https://example.com/hens,,\n"
          "CSV only row,Not Started,Low,No,,4,inside,,,\n")
    write(root / "Farm Home" / f"Tasks {TASKS}.csv", "Name,Status\nFix fence/gate,Next Up\n")
    rows = root / "Farm Home" / "Tasks"
    write(rows / f"Fix fence gate {FENCE}.md",
          "# Fix fence/gate\n\nStatus: Next Up\nPriority: High\nDone: No\n"
          "Photo: ../../../Untitled%201234-abcd/logo.png\n\nUse the **new** posts.")
    write(rows / f"Feed hens {FEED}.md", "# Feed hens\n\nStatus: Done\nDone: Yes\n\n- [x]  Morning\n- [ ]  Evening")
    write(rows / f"Clean coop {COOP}.md", "# Clean coop\n\nStatus: Next Up\nNotes: not a column\n")
    write(rows / f"Template {TEMPLATE}.md", "# Template\n\nStatus: Not Started\n\nSome template body")
    write(rows / f"Hens {HENS}.md", "# Hens\n\nStatus: Next Up\nLink: https://example.com/hens")

    # A page with an inline database (a link line to its CSV).
    write(root / f"Inline {INLINE}.md", f"# Inline\n\nThe list:\n\n[Inline DB](Inline/Inline%20DB%20{INLINE_DB}_all.csv)"
                                        f"\n\n[Ghost](Ghost%20{INLINE}.csv)")
    write(root / "Inline" / f"Inline DB {INLINE_DB}_all.csv", "Name,Qty\nApples,3\nPears,5\n")

    # A folder whose page is missing, and a folder of attachments only.
    write(root / "Orphan Folder" / f"Child {CHILD}.md", "# Child\n\nhello")
    write(root / "Untitled 1234-abcd" / "logo.png", PNG)
    return root


@pytest.fixture
def client():
    with running_app() as c:
        yield c


def account(client) -> tuple[str, str, str]:
    me = sign_in(client)
    data = pull_all(client)
    ws = next(w for w in data["workspaces"] if w["name"] == "Work")
    return me["id"], ws["id"], ws["root_page_id"]


def pages_by_title(db, workspace_id: str) -> dict:
    from app.models import Page

    out = {}
    for p in db.scalars(select(Page).where(Page.workspace_id == workspace_id)).all():
        out.setdefault(p.title, p)
    return out


def blocks_of(db, page_id: str) -> list:
    from app.models import Block

    return db.scalars(select(Block).where(Block.page_id == page_id, Block.parent_id.is_(None))
                      .order_by(Block.position)).all()


def run_import(client, tmp_path, **kw) -> SimpleNamespace:
    from app.notion_import import import_notion

    user_id, ws_id, root = account(client)
    export = build_export(tmp_path / "export")
    stats = import_notion(user_id, ws_id, root, export, **kw)
    return SimpleNamespace(stats=stats, user_id=user_id, ws_id=ws_id, root=root)


def test_import_folder_builds_the_tree(client, tmp_path):
    from app.database import SessionLocal
    from app.models import Block, File, Page
    from app.storage import path_for

    seen = []
    run = run_import(client, tmp_path, progress=seen.append)
    stats, user_id, ws_id, root = run.stats, run.user_id, run.ws_id, run.root
    assert stats["pages"] == 6        # Farm Home, Animals, Barn, Inline, Orphan Folder, Child
    assert stats["databases"] == 2
    assert stats["rows"] == 8         # 4 matched + 1 CSV only + 1 page only; Apples, Pears
    assert stats["files"] == 3        # the photo, the PDF (once), the row's logo
    assert any("Missing.pdf" in w for w in stats["warnings"])
    # A dangling .csv link that carries a page's id is not a link to that page.
    assert any("Ghost" in w for w in stats["warnings"])
    assert seen and seen[-1]["phase"] == "done"

    with SessionLocal() as db:
        pages = pages_by_title(db, ws_id)
        home, animals, barn = pages["Farm Home"], pages["Animals"], pages["Barn"]
        tasks, inline, inline_db = pages["Tasks"], pages["Inline"], pages["Inline DB"]

        # Top level: alphabetical, under the workspace root.
        top = db.scalars(select(Page).where(Page.parent_id == root).order_by(Page.position)).all()
        assert [p.title for p in top] == ["Farm Home", "Inline", "Orphan Folder"]
        assert pages["Child"].parent_id == pages["Orphan Folder"].id
        assert "Untitled 1234-abcd" not in pages
        # Children in the order the parent links them.
        kids = db.scalars(select(Page).where(Page.parent_id == home.id).order_by(Page.position)).all()
        assert [p.title for p in kids] == ["Animals", "Tasks"]
        assert barn.parent_id == animals.id
        assert inline_db.parent_id == inline.id and inline_db.kind == "database"
        every = db.scalars(select(Page).where(Page.workspace_id == ws_id)).all()
        assert all(p.owner_id == user_id and p.rev > 0 for p in every)

        # Farm Home: callout, page block, database block, rewritten links, table.
        b = blocks_of(db, home.id)
        assert [x.type for x in b] == ["callout", "page", "database", "paragraph", "table"]
        assert b[0].text == "Welcome to the farm" and b[0].props == {"icon": "💡"}
        assert b[1].props == {"page_id": animals.id}
        assert b[2].props == {"page_id": tasks.id}
        assert b[3].text == f"See [the animals page](/p/{animals.id}) and [elsewhere](https://example.com)."
        assert b[4].props["rows"] == [["Name", "Count"], ["Hens", "12"]]
        assert [x.position for x in b] == [1.0, 2.0, 3.0, 4.0, 5.0]

        # Animals: image and file blocks, an inline file link, a missing file as text.
        b = blocks_of(db, animals.id)
        assert [x.type for x in b] == ["image", "file", "paragraph", "bulleted_list", "page"]
        photo = db.get(File, b[0].props["file_id"])
        # The original name from the alt text, not the sanitised one on disk.
        assert b[0].text == "" and b[0].props["name"] == "Hen photo.png"
        assert photo.page_id == animals.id and photo.content_type == "image/png"
        assert path_for(photo.stored_name).read_bytes() == PNG
        pdf = db.get(File, b[1].props["file_id"])
        assert b[1].props == {"file_id": pdf.id, "name": "Manual.pdf", "size": len(PDF),
                              "content_type": "application/pdf"}
        assert b[2].text == f"Read [Manual.pdf](/api/files/{pdf.id}/Manual.pdf) first, and Missing.pdf."
        nested = db.scalars(select(Block).where(Block.parent_id == b[3].id)).all()
        assert [(x.type, x.text, x.page_id) for x in nested] == [("bulleted_list", "Sussex", animals.id)]
        assert b[4].props == {"page_id": barn.id}
        assert blocks_of(db, barn.id)[0].text == f"Back to [Farm Home](/p/{home.id})."

        # The inline database.
        b = blocks_of(db, inline.id)
        assert [x.type for x in b] == ["paragraph", "database", "paragraph"]
        assert b[1].props == {"page_id": inline_db.id}
        assert b[2].text == "Ghost"


def test_database_schema_and_rows(client, tmp_path):
    from app.database import SessionLocal
    from app.models import File, Page

    ws_id = run_import(client, tmp_path).ws_id
    with SessionLocal() as db:
        tasks = pages_by_title(db, ws_id)["Tasks"]
        props = {p["name"]: p for p in tasks.schema["properties"]}
        assert tasks.schema["properties"][0] == {"id": "title", "name": "Name", "type": "title"}
        types = {name: p["type"] for name, p in props.items()}
        assert types == {
            "Name": "title", "Status": "select", "Priority": "select", "Done": "checkbox", "Due": "date",
            "Estimate": "number", "Tags": "multi_select", "Link": "url", "Contact": "email", "Photo": "files",
        }
        assert [o["name"] for o in props["Status"]["options"]] == ["Next Up", "Done", "Not Started"]
        assert all(o["color"] and o["id"] for o in props["Status"]["options"])
        assert [o["name"] for o in props["Tags"]["options"]] == ["outside", "urgent", "inside"]
        assert all(p["id"] == "title" or p["id"].startswith("p_") and len(p["id"]) == 10 for p in props.values())
        view = tasks.schema["views"][0]
        assert view["type"] == "table" and view["sort"] == [{"property": props["Priority"]["id"], "direction": "desc"}]

        rows = db.scalars(select(Page).where(Page.parent_id == tasks.id).order_by(Page.position)).all()
        assert [r.title for r in rows] == ["Fix fence/gate", "Feed hens", "Clean coop", "Hens", "CSV only row", "Template"]
        pid = {name: p["id"] for name, p in props.items()}
        fence, feed, coop, hens, csv_only, template = rows
        assert hens.props[pid["Link"]] == "https://example.com/hens" and hens.props[pid["Estimate"]] == 2
        assert fence.props[pid["Status"]] == "Next Up"
        assert fence.props[pid["Priority"]] == "High"
        assert fence.props[pid["Done"]] is False
        assert fence.props[pid["Due"]] == "2022-10-24T21:58"
        assert fence.props[pid["Estimate"]] == 2.5
        assert fence.props[pid["Tags"]] == ["outside", "urgent"]
        assert fence.props[pid["Link"]] == "https://example.com/fence"
        assert fence.props[pid["Contact"]] == "a@example.com"
        [logo] = fence.props[pid["Photo"]]
        assert logo["name"] == "logo.png" and db.get(File, logo["file_id"]).page_id == fence.id
        assert feed.props[pid["Done"]] is True and feed.props[pid["Due"]] == "2022-10-25"
        assert coop.props[pid["Due"]] == "2022-10-26" and coop.props[pid["Estimate"]] == 3
        assert csv_only.props[pid["Status"]] == "Not Started" and csv_only.props[pid["Estimate"]] == 4
        assert template.props == {pid["Status"]: "Not Started"}

        # Key: value lines are properties, not content; the rest is content.
        assert [(b.type, b.text) for b in blocks_of(db, fence.id)] == [("paragraph", "Use the **new** posts.")]
        assert [(b.type, b.props) for b in blocks_of(db, feed.id)] == [
            ("to_do", {"checked": True}), ("to_do", {"checked": False})]
        # "Notes" is not a column, so that line stays text.
        assert [b.text for b in blocks_of(db, coop.id)] == ["Notes: not a column"]
        assert blocks_of(db, csv_only.id) == []

        inline_db = pages_by_title(db, ws_id)["Inline DB"]
        qty = inline_db.schema["properties"][1]
        assert qty["type"] == "number"
        values = [r.props[qty["id"]] for r in db.scalars(
            select(Page).where(Page.parent_id == inline_db.id).order_by(Page.position))]
        assert values == [3, 5]


def test_imported_pages_reach_sync_and_markdown_export(client, tmp_path):
    run_import(client, tmp_path)
    data = pull_all(client)
    titles = {p["title"] for p in data["pages"]}
    assert {"Farm Home", "Animals", "Tasks", "Fix fence/gate"} <= titles
    home = next(p for p in data["pages"] if p["title"] == "Farm Home")
    animals = next(p for p in data["pages"] if p["title"] == "Animals")
    assert sum(1 for b in data["blocks"] if b["page_id"] == home["id"]) == 5

    r = client.get(f"/api/pages/{home['id']}/markdown")
    assert r.status_code == 200
    assert r.text.startswith("# Farm Home\n\n<aside>\n💡 Welcome to the farm\n</aside>\n\n")
    assert f"[Animals](/p/{animals['id']})" in r.text
    assert "| Name | Count |" in r.text

    tasks = next(p for p in data["pages"] if p["title"] == "Tasks")
    md = client.get(f"/api/pages/{tasks['id']}/markdown").text
    assert md.startswith("# Tasks\n\n| Name | Status | Priority | Done | Due |")
    fence = next(p for p in data["pages"] if p["title"] == "Fix fence/gate")
    assert f"| [Fix fence/gate](/p/{fence['id']}) | Next Up | High | No | 2022-10-24T21:58 | 2.5 | outside, urgent |" in md


def test_a_broken_page_is_a_warning_not_an_abort(client, tmp_path, monkeypatch):
    from app import notion_import
    from app.config import get_settings
    from app.database import SessionLocal
    from app.models import File

    real = notion_import.parse_markdown

    def flaky(text):
        if "Chickens" in text:
            raise RuntimeError("boom")
        return real(text)

    monkeypatch.setattr(notion_import, "parse_markdown", flaky)
    uploads = get_settings().upload_dir
    before = {f.name for f in uploads.rglob("*") if f.is_file()}
    run = run_import(client, tmp_path)
    stats, ws_id = run.stats, run.ws_id
    assert any("Animals" in w and "boom" in w for w in stats["warnings"])
    assert stats["pages"] == 6 and stats["rows"] == 8
    with SessionLocal() as db:
        pages = pages_by_title(db, ws_id)
        assert blocks_of(db, pages["Animals"].id) == []          # empty, but there
        assert pages["Barn"].parent_id == pages["Animals"].id    # and its subtree too
        # The rolled-back page's uploads are not counted and left nothing behind.
        assert stats["files"] == 1
        stored = {f.stored_name for f in db.scalars(select(File)).all()}
    assert {f.name for f in uploads.rglob("*") if f.is_file()} - before == stored


def test_zip_of_zips(client, tmp_path):
    from app.database import SessionLocal
    from app.notion_import import import_notion

    user_id, ws_id, root = account(client)
    export = build_export(tmp_path / "export")
    part = tmp_path / "Export-x-Part-1.zip"
    with zipfile.ZipFile(part, "w") as zf:
        for f in export.rglob("*"):
            if f.is_file():
                zf.write(f, "Export-x/" + f.relative_to(export).as_posix())
        zf.writestr("../escape.md", "# Escape")
    outer = tmp_path / "Export-x.zip"
    with zipfile.ZipFile(outer, "w") as zf:
        zf.write(part, part.name)
    stats = import_notion(user_id, ws_id, root, outer)
    assert (stats["pages"], stats["databases"], stats["rows"]) == (6, 2, 8)
    with SessionLocal() as db:
        assert "Escape" not in pages_by_title(db, ws_id)
    assert not (tmp_path / "escape.md").exists()


# --- The HTTP job ---------------------------------------------------------------------


def zipped(export: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for f in export.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(export).as_posix())
    return buf.getvalue()


def wait(client, import_id: str, params=None) -> dict:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        r = client.get(f"/api/import/{import_id}", params=params)
        assert r.status_code == 200, r.text
        if r.json()["status"] in ("done", "error"):
            return r.json()
        time.sleep(0.2)
    raise AssertionError("import did not finish")


def test_upload_endpoint_runs_the_import(client, tmp_path):
    from app.config import get_settings

    _, ws_id, root = account(client)
    body = zipped(build_export(tmp_path / "export"))
    r = client.post("/api/import/notion", data={"workspace_id": "work"},
                    files={"file": ("Export-x.zip", body, "application/zip")})
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["status"] == "queued" and job["workspace_id"] == ws_id and job["parent_page_id"] == root
    assert job["source_name"] == "Export-x.zip"

    done = wait(client, job["id"])
    assert done["status"] == "done", done
    assert done["stats"]["pages"] == 6 and done["stats"]["rows"] == 8 and done["finished_at"]
    assert "heartbeat" not in done["stats"]
    listed = client.get("/api/import").json()
    assert [j["id"] for j in listed] == [job["id"]]
    titles = {p["title"] for p in pull_all(client)["pages"]}
    assert {"Farm Home", "Tasks", "Inline DB"} <= titles
    # The uploaded zip is gone once the job is done.
    assert not list(get_settings().import_dir.glob("upload-*.zip"))


def test_upload_with_api_token_and_parent(client, tmp_path):
    from app.database import SessionLocal
    from app.models import Page

    user_id, ws_id, root = account(client)
    token = client.post("/api/auth/api-token").json()["api_token"]
    target = "00000000-0000-4000-8000-000000000001"
    with SessionLocal() as db:
        db.add(Page(id=target, workspace_id=ws_id, parent_id=root, owner_id=user_id, title="Imports",
                    props={}, options={}, clock={}))
        db.commit()
    client.cookies.clear()
    body = zipped(build_export(tmp_path / "export"))
    r = client.post("/api/import/notion", params={"token": token},
                    data={"workspace": ws_id, "parent_page_id": target},
                    files={"file": ("e.zip", body, "application/zip")})
    assert r.status_code == 200, r.text
    done = wait(client, r.json()["id"], params={"token": token})
    assert done["status"] == "done" and done["parent_page_id"] == target
    with SessionLocal() as db:
        assert pages_by_title(db, ws_id)["Farm Home"].parent_id == target


def test_upload_refusals(client, tmp_path):
    from app.database import SessionLocal
    from app.models import Import, utcnow

    assert client.post("/api/import/notion", files={"file": ("e.zip", b"x")}).status_code == 401
    user_id, ws_id, root = account(client)
    body = zipped(build_export(tmp_path / "export"))
    r = client.post("/api/import/notion", data={"workspace_id": "Nope"}, files={"file": ("e.zip", body)})
    assert r.status_code == 404
    r = client.post("/api/import/notion", data={"workspace_id": ws_id}, files={"file": ("e.txt", b"not a zip")})
    assert r.status_code == 400
    r = client.post("/api/import/notion", data={"workspace_id": ws_id})
    assert r.status_code == 400
    r = client.post("/api/import/notion", data={"workspace_id": ws_id, "parent_page_id": "missing"},
                    files={"file": ("e.zip", body)})
    assert r.status_code == 404

    # One import at a time per account.
    with SessionLocal() as db:
        db.add(Import(id="00000000-0000-4000-8000-0000000000aa", owner_id=user_id, workspace_id=ws_id,
                      parent_page_id=root, status="running", stats={"heartbeat": utcnow().isoformat()}))
        db.commit()
    r = client.post("/api/import/notion", data={"workspace_id": ws_id}, files={"file": ("e.zip", body)})
    assert r.status_code == 409
    # Another account cannot see it.
    client.cookies.clear()
    sign_in(client, "other@example.com")
    assert client.get("/api/import/00000000-0000-4000-8000-0000000000aa").status_code == 404
    assert client.get("/api/import").json() == []


def test_interrupted_imports_are_failed(client):
    from app.database import SessionLocal
    from app.models import Import, utcnow
    from app.routers.imports import resume_pending

    user_id, ws_id, root = account(client)
    with SessionLocal() as db:
        db.add(Import(id="00000000-0000-4000-8000-0000000000b1", owner_id=user_id, workspace_id=ws_id,
                      parent_page_id=root, status="running", stats={"heartbeat": utcnow().isoformat()}))
        db.add(Import(id="00000000-0000-4000-8000-0000000000b2", owner_id=user_id, workspace_id=ws_id,
                      parent_page_id=root, status="done", stats={}))
        db.commit()
    resume_pending()
    job = client.get("/api/import/00000000-0000-4000-8000-0000000000b1").json()
    assert job["status"] == "error" and "restart" in job["error"]
    assert client.get("/api/import/00000000-0000-4000-8000-0000000000b2").json()["status"] == "done"

    # A heartbeat that stopped (a process gone without a restart here) fails on read.
    with SessionLocal() as db:
        db.add(Import(id="00000000-0000-4000-8000-0000000000b3", owner_id=user_id, workspace_id=ws_id,
                      parent_page_id=root, status="running",
                      stats={"heartbeat": (utcnow() - timedelta(minutes=10)).isoformat()}))
        db.commit()
    assert client.get("/api/import/00000000-0000-4000-8000-0000000000b3").json()["status"] == "error"
