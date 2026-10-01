"""Published websites: the publish API (validation, uniqueness, ownership) and
serving at <app>/v/<name> and on custom domains."""

import re
import uuid

import pytest

from tests.helpers import mutation, needs_db, pull_all, running_app, sign_in

pytestmark = needs_db

V = "/v/farm"  # the test site's address on the app host


def get(client, path, **kw):
    """A request to the published test site, at its /v/ address."""
    return client.get(V + path, **kw)


@pytest.fixture
def client():
    with running_app() as c:
        yield c


def new_id() -> str:
    return str(uuid.uuid4())


def push(client, *mutations):
    r = client.post("/api/sync/push", json={"mutations": list(mutations)})
    assert r.status_code == 200, r.text
    statuses = [x["status"] for x in r.json()["results"]]
    assert set(statuses) <= {"applied"}, r.json()
    return statuses


def work_root(client) -> str:
    data = pull_all(client)
    return next(w for w in data["workspaces"] if w["name"] == "Work")["root_page_id"]


def page(client, parent, title, **extra):
    pid = new_id()
    push(client, mutation("page", pid, {"parent_id": parent, "title": title, "position": extra.pop("position", 1),
                                        **extra}))
    return pid


def block(client, on_page, type_, text="", position=1, **props):
    bid = new_id()
    push(client, mutation("block", bid, {"page_id": on_page, "type": type_, "text": text, "props": props,
                                         "position": position}))
    return bid


def publish(client, page_id, **body):
    body.setdefault("slug", "farm")
    body.setdefault("template", "minimal")
    body.setdefault("enabled", True)
    body.setdefault("options", {})
    return client.put(f"/api/pages/{page_id}/site", json=body)


def farm(client) -> dict:
    """Signed in, a small site: Farm / Chickens / Breeds, Eggs, a trashed page."""
    sign_in(client)
    root = work_root(client)
    ids = {"root": root}
    ids["farm"] = page(client, root, "Farm", icon="🐔")
    ids["chickens"] = page(client, ids["farm"], "Chickens", position=1)
    ids["breeds"] = page(client, ids["chickens"], "Breeds")
    ids["eggs"] = page(client, ids["farm"], "Eggs & Prices", position=2)
    ids["outside"] = page(client, root, "Private notes")
    block(client, ids["farm"], "paragraph", "Welcome to the **farm**.", 1)
    block(client, ids["farm"], "paragraph", f"See [our hens](/p/{ids['chickens']}) and [secrets](/p/{ids['outside']}).", 2)
    block(client, ids["breeds"], "heading_1", "Vorwerk")
    r = publish(client, ids["farm"])
    assert r.status_code == 200, r.text
    ids["site"] = r.json()
    return ids


# --- The publish API -----------------------------------------------------------


def test_templates_are_listed(client):
    r = client.get("/api/sites/templates")
    assert r.status_code == 200
    assert [t["id"] for t in r.json()] == ["minimal", "docs", "blog", "landing"]
    assert all(t["name"] and t["description"] for t in r.json())


def test_publish_needs_sign_in(client):
    pid = new_id()
    assert client.get(f"/api/pages/{pid}/site").status_code == 401
    assert client.put(f"/api/pages/{pid}/site", json={"slug": "x"}).status_code == 401
    assert client.delete(f"/api/pages/{pid}/site").status_code == 401
    assert client.get("/api/sites").status_code == 401
    assert client.get("/api/sites/check", params={"slug": "x"}).status_code == 401


def test_site_object(client):
    ids = farm(client)
    site = ids["site"]
    assert site["page_id"] == ids["farm"] and site["slug"] == "farm" and site["enabled"] is True
    assert site["url"] == "http://testserver/v/farm"  # BASE_URL in tests
    assert site["custom_url"] is None and site["preview_url"] == "/v/farm/"
    assert site["dns"] == {"type": "A", "name": None, "value": None}
    assert site["options"] == {"show_header": True, "show_nav": True}
    assert client.get(f"/api/pages/{ids['farm']}/site").json() == site
    assert client.get("/api/sites").json() == [site]
    assert client.get(f"/api/pages/{ids['eggs']}/site").status_code == 404


def test_update_keeps_one_site_per_page(client):
    ids = farm(client)
    r = publish(client, ids["farm"], slug="Sonnenhof", custom_domain="HTTPS://Www.Example.org/",
                template="docs", enabled=False,
                options={"title": " Sonnenhof ", "description": "Eggs.", "footer": "", "show_header": False,
                         "show_nav": False, "accent": "#C2410C", "unknown": 1})
    assert r.status_code == 200, r.text
    site = r.json()
    assert site["id"] == ids["site"]["id"]
    assert site["slug"] == "sonnenhof" and site["custom_domain"] == "www.example.org"
    assert site["custom_url"] == "http://www.example.org" and site["dns"]["name"] == "www.example.org"
    assert site["options"] == {"title": "Sonnenhof", "description": "Eggs.", "show_header": False, "show_nav": False,
                               "accent": "#c2410c"}
    assert len(client.get("/api/sites").json()) == 1
    # Leaving the name out keeps the current one.
    assert publish(client, ids["farm"], slug=None).json()["slug"] == "sonnenhof"


@pytest.mark.parametrize("body, status", [
    ({"slug": "-farm"}, 422),
    ({"slug": "farm-"}, 422),
    ({"slug": "fa_rm"}, 422),
    ({"slug": "fa/rm"}, 422),
    ({"slug": "a" * 64}, 422),
    ({"template": "fancy"}, 422),
    ({"custom_domain": "not a domain"}, 422),
    ({"custom_domain": "localhost"}, 422),
    ({"custom_domain": "1.2.3.4"}, 422),
    ({"options": {"accent": "red"}}, 422),
    ({"options": {"show_nav": "yes"}}, 422),
    ({"options": {"show_header": 0}}, 422),
    ({"options": {"title": 5}}, 422),
    ({"options": {"footer": "x" * 501}}, 422),
])
def test_publish_validation(client, body, status):
    sign_in(client)
    pid = page(client, work_root(client), "Farm")
    r = publish(client, pid, **body)
    assert r.status_code == status, (body, r.text)
    assert r.json()["detail"]


def test_addresses_are_unique_across_accounts(client):
    ids = farm(client)
    assert publish(client, ids["farm"], custom_domain="farm.example").status_code == 200

    client.cookies.clear()
    sign_in(client, "other@example.com")
    mine = page(client, work_root(client), "Other farm")
    assert publish(client, mine, slug="farm").status_code == 409
    assert publish(client, mine, slug="farm2", custom_domain="farm.example").status_code == 409
    r = client.get("/api/sites/check", params={"slug": "farm", "domain": "farm.example", "page_id": mine})
    assert r.json()["slug_ok"] is False and r.json()["domain_ok"] is False and "/v/farm" in r.json()["detail"]
    r = client.get("/api/sites/check", params={"slug": "farm2", "domain": "www.farm.example"})
    assert r.json() == {"slug_ok": True, "domain_ok": True, "detail": None,
                        "base_url": "http://testserver", "public_ip": None}
    assert publish(client, mine, slug="farm2").status_code == 200


def test_check_does_not_count_the_own_page(client):
    ids = farm(client)
    r = client.get("/api/sites/check", params={"slug": "farm", "page_id": ids["farm"]}).json()
    assert r["slug_ok"] is True and r["suggestion"] == "farm"
    r = client.get("/api/sites/check", params={"slug": "Not Valid"}).json()
    assert r["slug_ok"] is False and "lowercase letters" in r["detail"]


def test_default_name_comes_from_the_title(client):
    sign_in(client)
    root = work_root(client)
    a = page(client, root, "Hühnerfarm Sonnenhof")
    b = page(client, root, "Hühnerfarm Sonnenhof")
    docs = page(client, root, "Docs")
    assert client.get("/api/sites/check", params={"page_id": a}).json()["suggestion"] == "huehnerfarm-sonnenhof"
    assert publish(client, a, slug=None).json()["slug"] == "huehnerfarm-sonnenhof"
    assert publish(client, b, slug="").json()["slug"] == "huehnerfarm-sonnenhof-2"
    assert publish(client, docs, slug=None).json()["slug"] == "docs"  # paths reserve no names


def test_only_the_owner_manages_a_site(client):
    ids = farm(client)
    client.cookies.clear()
    sign_in(client, "mallory@example.com")
    assert client.get(f"/api/pages/{ids['farm']}/site").status_code == 404
    assert publish(client, ids["farm"], slug="stolen").status_code == 404
    assert client.delete(f"/api/pages/{ids['farm']}/site").status_code == 404
    assert client.get("/api/sites").json() == []
    assert get(client, "/").status_code == 200  # still published


def test_trashed_page_cannot_be_published(client):
    sign_in(client)
    pid = page(client, work_root(client), "Gone")
    push(client, mutation("page", pid, action="delete"))
    assert publish(client, pid).status_code == 409


# --- Serving -----------------------------------------------------------------------


def test_site_served_at_its_v_address(client):
    farm(client)
    r = get(client, "/")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    html = r.text
    assert "<h1 class=\"page-title\">Farm</h1>" in html
    assert "Welcome to the <strong>farm</strong>." in html
    assert '<meta name="description" content="Welcome to the farm.">' in html
    assert '<link rel="canonical" href="http://testserver/v/farm/">' in html
    assert "Made with meerpad" in html and 'href="https://meerpad.com"' in html
    assert '<img src="data:image/png;base64,' in html  # the meerkat, inline so custom domains get it too
    assert "noindex" not in html
    assert r.headers["cache-control"] == "public, max-age=60"
    assert "script-src 'nonce-" in r.headers["content-security-policy"]
    assert "<script" not in html  # no mermaid, no equations: no JavaScript at all
    # Signed out, it is the same public website.
    client.cookies.clear()
    assert get(client, "/").status_code == 200
    assert client.get("/v/FARM/").status_code == 200
    assert client.get("/v/farm", follow_redirects=False).headers["location"] == "/v/farm/"
    assert client.get("/v/nothing/").status_code == 404
    # Subdomains are gone; unknown hosts get nothing.
    assert client.get("/", headers={"host": "farm.meerpad.com"}).status_code == 404
    assert client.get("/", headers={"host": "unknown.example"}).status_code == 404
    # The app itself is untouched.
    assert client.get("/api/sites/templates").status_code == 200


def test_custom_domain_and_www(client):
    ids = farm(client)
    publish(client, ids["farm"], custom_domain="sonnenhof.example")
    for host in ("sonnenhof.example", "www.sonnenhof.example"):
        r = client.get("/chickens", headers={"host": host})
        assert r.status_code == 200 and "Chickens" in r.text
    # Search engines are pointed at the custom domain.
    assert '<link rel="canonical" href="http://sonnenhof.example/chickens">' in get(client, "/chickens").text


def test_paths_follow_the_tree(client):
    ids = farm(client)
    page(client, ids["farm"], "Chickens", position=3)  # same title: gets -2
    assert "Breeds" in get(client, "/chickens/breeds").text
    assert "Eggs &amp; Prices" in get(client, "/eggs-prices").text
    r = get(client, "/chickens-2")
    assert r.status_code == 200 and "Chickens" in r.text
    assert "Breeds" not in r.text  # the twin has no children
    r = get(client, "/chickens/", follow_redirects=False)
    assert r.status_code == 301 and r.headers["location"] == "/v/farm/chickens"
    r = get(client, "/Chickens", follow_redirects=False)
    assert r.status_code == 301 and r.headers["location"] == "/v/farm/chickens"
    r = get(client, "/nope")
    assert r.status_code == 404 and "This page could not be found" in r.text and "Back to Farm" in r.text
    assert client.post(V + "/").status_code == 405


def test_trashed_pages_are_not_served(client):
    ids = farm(client)
    push(client, mutation("page", ids["chickens"], action="delete"))
    assert get(client, "/chickens").status_code == 404
    assert get(client, "/chickens/breeds").status_code == 404  # under a trashed page
    assert "/chickens" not in get(client, "/sitemap.xml").text
    # The link to it is now plain text.
    html = get(client, "/").text
    assert "our hens" in html and 'href="/v/farm/chickens"' not in html
    push(client, mutation("page", ids["chickens"], {"deleted": False}))
    assert get(client, "/chickens/breeds").status_code == 200
    # Trashing the site's own page takes the whole site down.
    push(client, mutation("page", ids["farm"], action="delete"))
    r = get(client, "/")
    assert r.status_code == 404 and "No site is published" in r.text


def test_internal_links_map_to_site_paths(client):
    ids = farm(client)
    html = get(client, "/").text
    assert '<a href="/v/farm/chickens">our hens</a>' in html
    # A page outside the site keeps its words and loses its link (and its id).
    assert "secrets" in html and ids["outside"] not in html
    # Subpages the content does not link to still get a card.
    assert 'href="/v/farm/eggs-prices"' in html


def test_files_only_for_pages_of_the_site(client):
    ids = farm(client)
    up = client.post("/api/files", files={"file": ("hen.png", b"\x89PNG fake", "image/png")},
                     data={"page_id": ids["chickens"]}).json()
    other = client.post("/api/files", files={"file": ("secret.png", b"\x89PNG top secret", "image/png")},
                        data={"page_id": ids["outside"]}).json()
    block(client, ids["chickens"], "image", "Frieda", 5, file_id=up["id"])
    block(client, ids["chickens"], "image", "Leak", 6, file_id=other["id"])
    html = get(client, "/chickens").text
    assert f'src="/v/farm/_files/{up["id"]}/hen.png"' in html
    assert other["id"] not in html
    r = get(client, f"/_files/{up['id']}/hen.png")
    assert r.status_code == 200 and r.content == b"\x89PNG fake"
    assert r.headers["cache-control"] == "public, max-age=3600"
    assert get(client, f"/_files/{other['id']}/secret.png").status_code == 404
    assert get(client, "/_files/../../etc/passwd").status_code == 404
    # Trashing the page hides its files too.
    push(client, mutation("page", ids["chickens"], action="delete"))
    assert get(client, f"/_files/{up['id']}/hen.png").status_code == 404


def test_sitemap_robots_favicon(client):
    ids = farm(client)
    sm = get(client, "/sitemap.xml")
    assert sm.status_code == 200 and sm.headers["content-type"].startswith("application/xml")
    for path in ("/", "/chickens", "/chickens/breeds", "/eggs-prices"):
        assert f"<loc>http://testserver/v/farm{path}</loc>" in sm.text
    assert "private-notes" not in sm.text and ids["outside"] not in sm.text
    robots = get(client, "/robots.txt").text
    assert "Allow: /" in robots and "Sitemap: http://testserver/v/farm/sitemap.xml" in robots
    # Behind Coolify's TLS proxy the printed URLs are https.
    proxied = get(client, "/sitemap.xml", headers={"x-forwarded-proto": "https"}).text
    assert "<loc>https://testserver/v/farm/chickens</loc>" in proxied
    icon = get(client, "/favicon.svg")
    assert icon.headers["content-type"].startswith("image/svg+xml") and "🐔" in icon.text


def test_database_rows_are_pages(client):
    ids = farm(client)
    schema = {
        "properties": [
            {"id": "title", "name": "Entry", "type": "title"},
            {"id": "p_n", "name": "Eggs", "type": "number"},
            {"id": "p_s", "name": "Secret", "type": "text"},
        ],
        "views": [{"id": "v", "name": "All", "type": "table", "hidden": ["p_s"],
                   "sort": [{"property": "p_n", "direction": "desc"}]}],
    }
    diary = page(client, ids["farm"], "Diary", kind="database", schema=schema, position=5)
    page(client, diary, "Monday", props={"p_n": 3, "p_s": "hush"}, position=1)
    page(client, diary, "Tuesday", props={"p_n": 9}, position=2)
    block(client, ids["farm"], "database", "", 9, page_id=diary)
    html = get(client, "/").text
    assert html.index("Tuesday") < html.index("Monday")  # the view's sort
    assert '<a class="row-link" href="/v/farm/diary/monday">Monday</a>' in html and "hush" not in html
    row = get(client, "/diary/monday")
    assert row.status_code == 200 and "Eggs" in row.text and "hush" not in row.text
    assert "Monday" in get(client, "/diary").text


@pytest.mark.parametrize("template", ["minimal", "docs", "blog", "landing"])
def test_every_template_renders(client, template):
    ids = farm(client)
    block(client, ids["chickens"], "code", "graph LR\n A-->B", 3, language="mermaid")
    block(client, ids["chickens"], "equation", "x^2", 4)
    publish(client, ids["farm"], template=template, options={"accent": "#0f766e", "footer": "[Imprint](https://x.example)"})
    for path in ("/", "/chickens", "/chickens/breeds", "/eggs-prices"):
        r = get(client, path)
        assert r.status_code == 200, (template, path)
        assert "--accent: #0f766e" in r.text and '<a href="https://x.example"' in r.text
    html = get(client, "/chickens").text
    nonce = get(client, "/chickens").headers["content-security-policy"].split("'nonce-")[1].split("'")[0]
    assert "mermaid" in html and "katex" in html and "nonce=" in html and nonce
    root = get(client, "/").text
    assert 'href="/v/farm/chickens"' in root
    # Plain text, also when the landing hero takes the first paragraph.
    assert '<meta name="description" content="Welcome to the farm.">' in root
    assert get(client, "/nope").status_code == 404


HEADERS = {"minimal": "topbar", "docs": "docs-top", "blog": "blog-top", "landing": "land-nav"}


@pytest.mark.parametrize("template", list(HEADERS))
def test_header_can_be_hidden(client, template):
    ids = farm(client)
    header = f'<header class="{HEADERS[template]}">'
    no_header = re.compile(r'<body class="[^"]*\bno-header\b')
    publish(client, ids["farm"], template=template)
    html = get(client, "/").text
    assert header in html and 'class="brand"' in html and not no_header.search(html)

    publish(client, ids["farm"], template=template, options={"show_header": False})
    for path in ("/", "/chickens", "/chickens/breeds"):
        html = get(client, path).text
        assert 'class="brand"' not in html and no_header.search(html), (template, path)
        # Docs keeps a bar on phones, for the button that opens the sidebar.
        assert (header in html) == (template == "docs"), (template, path)
    # A subpage one level down still links back to the start.
    assert 'href="/v/farm/"' in get(client, "/chickens").text
    if template == "docs":
        publish(client, ids["farm"], template=template, options={"show_header": False, "show_nav": False})
        assert "docs-top" not in get(client, "/chickens").text.split("</style>", 1)[1]


def test_switched_off_site_is_a_preview_for_its_owner(client):
    ids = farm(client)
    publish(client, ids["farm"], enabled=False, custom_domain="sonnenhof.example")
    r = get(client, "/")
    assert r.status_code == 200
    assert '<a href="/v/farm/chickens">our hens</a>' in r.text
    assert '<meta name="robots" content="noindex, nofollow">' in r.text
    assert r.headers["cache-control"] == "private, no-cache"
    assert "Breeds" in get(client, "/chickens/breeds").text
    assert "Disallow: /" in get(client, "/robots.txt").text
    assert get(client, "/nope").status_code == 404
    # Nobody else sees it, at either address.
    assert client.get("/", headers={"host": "sonnenhof.example"}).status_code == 404
    client.cookies.clear()
    assert get(client, "/").status_code == 404


def test_unpublish(client):
    ids = farm(client)
    assert client.delete(f"/api/pages/{ids['farm']}/site").json() == {"ok": True}
    assert get(client, "/").status_code == 404
    assert client.get(f"/api/pages/{ids['farm']}/site").status_code == 404
    assert client.delete(f"/api/pages/{ids['farm']}/site").status_code == 404
    # The address is free again.
    assert client.get("/api/sites/check", params={"slug": "farm"}).json()["slug_ok"] is True
