"""Files: upload, who may read them, the SSRF guard on fetch, and purging pages."""

import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from tests.helpers import mutation, needs_db, pull_all, running_app, sign_in

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture
def client():
    with running_app() as c:
        yield c


def new_id() -> str:
    return str(uuid.uuid4())


def make_page(client, title="Docs"):
    data = pull_all(client)
    root = next(w for w in data["workspaces"] if w["name"] == "Work")["root_page_id"]
    pid = new_id()
    client.post("/api/sync/push", json={"mutations": [mutation("page", pid, {"parent_id": root, "title": title})]})
    return pid, root


@needs_db
def test_upload_download_and_access(client):
    sign_in(client)
    page, _ = make_page(client)
    r = client.post("/api/files", files={"file": ("hen.png", PNG, "image/png")}, data={"page_id": page})
    assert r.status_code == 200, r.text
    f = r.json()
    assert f["filename"] == "hen.png" and f["size"] == len(PNG) and f["url"] == f"/api/files/{f['id']}/hen.png"

    got = client.get(f["url"])
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["content-type"] == "image/png"
    assert "sandbox" in got.headers["content-security-policy"]
    assert got.headers["x-content-type-options"] == "nosniff"
    assert "attachment" in client.get(f["url"] + "?download=1").headers["content-disposition"]

    # Someone else: 404, with or without a bogus share token.
    owner = dict(client.cookies)
    client.cookies.clear()
    sign_in(client, "stranger@example.com")
    assert client.get(f["url"]).status_code == 404
    assert client.get(f["url"] + "?share=nope").status_code == 404

    # Through a share link covering the page: readable.
    client.cookies.clear()
    client.cookies.update(owner)
    token = client.post(f"/api/pages/{page}/share", json={"kind": "view", "enabled": True}).json()["share_token"]
    client.cookies.clear()
    assert client.get(f"{f['url']}?share={token}").status_code == 200


@needs_db
def test_html_upload_is_not_rendered_inline(client):
    sign_in(client)
    f = client.post("/api/files", files={"file": ("x.html", b"<script>alert(1)</script>", "text/html")}).json()
    r = client.get(f["url"])
    assert "attachment" in r.headers["content-disposition"]
    assert "sandbox" in r.headers["content-security-policy"]


@needs_db
def test_upload_size_limit(client, monkeypatch):
    from app import storage

    sign_in(client)
    monkeypatch.setattr(storage.settings, "max_upload_bytes", 10)
    r = client.post("/api/files", files={"file": ("big.bin", b"x" * 11, "application/octet-stream")})
    assert r.status_code == 413


@needs_db
def test_fetch_refuses_private_addresses(client):
    sign_in(client)
    for url in ("http://127.0.0.1/", "http://localhost:8050/", "http://169.254.169.254/latest/meta-data/",
                "http://[::1]/", "http://10.0.0.1/", "file:///etc/passwd", "ftp://example.com/x", "http://example.com:22/"):
        r = client.post("/api/files/fetch", json={"url": url})
        assert r.status_code == 422, (url, r.text)
    probe = client.get("/api/files/probe", params={"url": "http://127.0.0.1/x.png"}).json()
    assert probe["ok"] is False and probe["kind"] == "image"


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/hen.png")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(PNG)))
        self.end_headers()
        self.wfile.write(PNG)

    def log_message(self, *args):
        pass


@needs_db
def test_fetch_downloads_when_private_is_allowed(client, monkeypatch):
    from app import fetcher

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        monkeypatch.setattr(fetcher.settings, "fetch_allow_private", True)
        sign_in(client)
        page, _ = make_page(client)
        port = server.server_address[1]
        probe = client.get("/api/files/probe", params={"url": f"http://127.0.0.1:{port}/redirect"}).json()
        assert probe["ok"] and probe["kind"] == "image" and probe["filename"] == "hen.png"
        r = client.post("/api/files/fetch", json={"url": f"http://127.0.0.1:{port}/redirect", "page_id": page})
        assert r.status_code == 200, r.text
        f = r.json()
        assert f["filename"] == "hen.png" and f["content_type"] == "image/png"
        assert client.get(f["url"]).content == PNG
    finally:
        server.shutdown()


@needs_db
def test_purge_requires_trash_and_leaves_tombstones(client):
    sign_in(client)
    page, root = make_page(client, "Old")
    child, blk = new_id(), new_id()
    client.post("/api/sync/push", json={"mutations": [
        mutation("page", child, {"parent_id": page, "title": "Older"}),
        mutation("block", blk, {"page_id": child, "type": "paragraph", "text": "bye"}),
    ]})
    f = client.post("/api/files", files={"file": ("a.png", PNG, "image/png")}, data={"page_id": child}).json()
    assert client.delete(f"/api/pages/{page}").status_code == 409
    client.post("/api/sync/push", json={"mutations": [mutation("page", page, action="delete")]})
    cursor = pull_all(client)["cursor"]
    r = client.delete(f"/api/pages/{page}")
    assert r.status_code == 200 and r.json()["purged"] == 2
    delta = pull_all(client, cursor=cursor)
    tomb = {p["id"]: p for p in delta["pages"]}
    assert tomb[page]["options"] == {"purged": True} and tomb[child]["title"] == ""
    assert client.get(f["url"]).status_code == 404
    everything = pull_all(client)
    assert blk not in {b["id"] for b in everything["blocks"]}
    # A root page can never be purged (it cannot be trashed either).
    assert client.delete(f"/api/pages/{root}").status_code == 409


def test_fetch_guard_unit():
    from app.fetcher import FetchError, _check_url

    with pytest.raises(FetchError):
        _check_url("gopher://x")
    with pytest.raises(FetchError):
        _check_url("http://example.com:25/")
    _check_url("https://example.com:8443/a.png")
