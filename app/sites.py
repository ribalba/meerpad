"""Published websites: a page and its subpages served as a real website.

A request reaches this module in one of two ways:

* On the app host under ``/v/<slug>/...`` (``routers/publish.py``'s
  ``preview_router``). This is every site's own address, and it needs no DNS
  or proxy setup at all: the app already answers there. Every link and file
  URL then carries that prefix. A site that is switched off stays visible
  there to its owner only, as a preview.
* On a host that is not the app's (``app/main.py``'s middleware calls
  ``dispatch``): a custom domain (exactly, or ``www.`` plus it). Custom
  domains work without any per-domain setup here: the owner points the
  domain's A record at the server and adds it to the Coolify service, whose
  proxy forwards the request with the original Host header.

What a site contains is decided per request from the live page tree, so an
edit, a move, or a trashed page shows up on the site at once (after the short
``Cache-Control`` window). The ``SiteMap`` is that snapshot: every live page
under the site's page (database rows included, since rows are pages), each
with a path built from its title. ``/`` is the site's page itself; below it,
paths nest like the tree (``/chickens/breeds``). A page that is deleted, or
sits under a deleted page, is simply not in the map, so it 404s.

Everything is rendered server-side with Jinja (``app/templates/sites``) from
the HTML ``app/render.py`` produces. JavaScript is only ever added for mermaid
diagrams and equations, and only on pages that have one.

Security notes. Sites are served on the app's own origin under ``/v/``, next
to the session cookie, so user content there must never run script. All content is
escaped by render.py, and every site response also carries a strict CSP:
scripts need a per-response nonce (``'strict-dynamic'`` lets the nonced
mermaid/KaTeX loaders pull in their own chunks), iframes are limited to the
embed allow-list, and forms and ``<base>`` are off. Files are only served if
they belong to a live page of the site, the same rule a share link uses.
"""

import base64
import ipaddress
import re
import secrets
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape as xml_escape

from fastapi import HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from jinja2 import Environment, FileSystemLoader
from markupsafe import Markup
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .config import get_settings
from .database import SessionLocal
from .mdinline import esc, inline_text
from .models import Block, File, Page, Site, Workspace
from .render import (
    EMBED_HOSTS,
    RenderContext,
    build_tree,
    cover_info,
    excerpt,
    first_paragraph,
    icon_html,
    long_date,
    render_blocks,
    render_database,
    render_properties,
    row_date,
    slugify,
    truncate,
)
from .services import PageTree
from .storage import file_response

settings = get_settings()

TEMPLATES = [
    {"id": "minimal", "name": "Minimal",
     "description": "One calm, centered column with breadcrumbs. Lets the writing speak."},
    {"id": "docs", "name": "Docs",
     "description": "Documentation layout: a sidebar with every page, a table of contents, previous and next links."},
    {"id": "blog", "name": "Blog",
     "description": "The home page lists its subpages as posts with cover image, date and excerpt."},
    {"id": "landing", "name": "Landing page",
     "description": "A big hero from the cover, title and first paragraph, with subpages as feature cards."},
]
TEMPLATE_IDS = frozenset(t["id"] for t in TEMPLATES)

# The name in <app>/v/<slug>: lowercase letters, digits and inner dashes.
SLUG_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
DEFAULT_ACCENT = "#2383e2"
MADE_WITH_URL = "https://meerpad.com"

PAGE_CACHE = "public, max-age=60"
FILE_CACHE = "public, max-age=3600"
PREVIEW_CACHE = "private, no-cache"

# Pinned, so a CDN release can never change a published site under its owner.
MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs"
KATEX_CSS = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css"
KATEX_JS = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js"

_env = Environment(
    loader=FileSystemLoader(Path(__file__).resolve().parent / "templates"),
    autoescape=True,
    trim_blocks=True,
    lstrip_blocks=True,
)
# The meerkat in the "Made with meerpad" footer, inlined: on a custom domain every
# path goes to the site, so the app's /static files are out of reach there.
_env.globals["made_with_logo"] = "data:image/png;base64," + base64.b64encode(
    (Path(__file__).resolve().parent / "static" / "img" / "favicon-32.png").read_bytes()
).decode("ascii")


# --- Hosts ---------------------------------------------------------------------


def is_app_host(host: str) -> bool:
    """IP literals, localhost and the app's own host are the app, never a site.
    (A bare IP is how health checks and a fresh server are reached.)"""
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        pass
    return host in {"localhost", "testserver", settings.app_host, "www." + settings.app_host}


def find_site(db: DBSession, host: str) -> Site | None:
    """The site a custom domain serves, enabled or not."""
    host = host.lower().rstrip(".")
    site = db.scalars(select(Site).where(Site.custom_domain == host)).first()
    if site is None and host.startswith("www."):
        site = db.scalars(select(Site).where(Site.custom_domain == host[4:])).first()
    return site


def site_path(site: Site) -> str:
    return f"/v/{site.slug}"


def site_url(site: Site) -> str:
    """The site's address on the app's own host: <base_url>/v/<slug>."""
    return settings.base_url.rstrip("/") + site_path(site)


def custom_url(site: Site) -> str | None:
    # A dev setup on http gets http URLs; production is always https (Coolify's
    # proxy terminates TLS for custom domains too).
    scheme = "http" if settings.base_url.startswith("http:") else "https"
    return f"{scheme}://{site.custom_domain}" if site.custom_domain else None


def canonical_origin(site: Site) -> str:
    """Where search engines should index the site (page paths are appended):
    the custom domain if there is one, else its /v/ address."""
    return custom_url(site) or site_url(site)


# --- The site map --------------------------------------------------------------


def _iso(d: date | datetime | None) -> str:
    return d.isoformat()[:19] if d else ""


@dataclass
class SitePage:
    id: str
    parent_id: str | None
    title: str
    icon: str | None
    cover: str | None
    kind: str
    position: float
    created_at: datetime | None
    updated_at: datetime | None
    path: str = ""
    is_row: bool = False
    children: list[str] = field(default_factory=list)

    @property
    def display_title(self) -> str:
        return self.title.strip() or "Untitled"


class SiteMap:
    """Every live page of one site, with its path. Built per request."""

    def __init__(self, site: Site, root_id: str, pages: dict[str, SitePage]):
        self.site = site
        self.root_id = root_id
        self.pages = pages
        for p in pages.values():
            parent = pages.get(p.parent_id) if p.parent_id else None
            p.is_row = parent is not None and parent.kind == "database"
            if parent is not None and p.id != root_id:
                parent.children.append(p.id)
        for p in pages.values():
            p.children.sort(key=lambda cid: (pages[cid].position, _iso(pages[cid].created_at), cid))
        self.by_path: dict[str, str] = {}
        self._assign_paths()

    @classmethod
    def load(cls, db: DBSession, site: Site) -> "SiteMap | None":
        """None when the site's page is gone, trashed, or in a deleted workspace:
        the site then does not exist at all (plain 404, not a site page)."""
        root = db.get(Page, site.page_id)
        if root is None or root.owner_id != site.owner_id:
            return None
        ws = db.get(Workspace, root.workspace_id)
        if ws is None or ws.deleted:
            return None
        tree = PageTree(db, root.workspace_id)
        if tree.is_trashed(root.id):
            return None
        ids = tree.descendants(root.id, include_deleted=False)
        cols = (Page.id, Page.parent_id, Page.title, Page.icon, Page.cover, Page.kind, Page.position,
                Page.created_at, Page.updated_at)
        pages: dict[str, SitePage] = {}
        for i in range(0, len(ids), 5000):
            for r in db.execute(select(*cols).where(Page.id.in_(ids[i:i + 5000]))).all():
                pages[r.id] = SitePage(
                    id=r.id, parent_id=r.parent_id, title=r.title or "", icon=r.icon, cover=r.cover,
                    kind=r.kind, position=r.position or 0.0, created_at=r.created_at, updated_at=r.updated_at,
                )
        if root.id not in pages:
            return None
        return cls(site, root.id, pages)

    def _assign_paths(self) -> None:
        """Slug paths, breadth first so a parent's path exists before its
        children's. Siblings with the same slug get -2, -3 in position order,
        so the first one keeps the plain address."""
        root = self.pages[self.root_id]
        root.path = "/"
        queue = [root.id]
        while queue:
            parent = self.pages[queue.pop(0)]
            used: set[str] = set()
            for cid in parent.children:
                child = self.pages[cid]
                base = slugify(child.title) or ("untitled" if not child.title.strip() else f"page-{slugify(cid[:8])}")
                slug, n = base, 2
                while slug in used:
                    slug, n = f"{base}-{n}", n + 1
                used.add(slug)
                child.path = parent.path.rstrip("/") + "/" + slug
                queue.append(cid)
        self.by_path = {p.path: p.id for p in self.pages.values() if p.path}

    def ancestors(self, page_id: str) -> list[SitePage]:
        """Root first, the page itself excluded."""
        out, cur = [], self.pages[page_id].parent_id
        while cur is not None and cur in self.pages and page_id != self.root_id:
            out.append(self.pages[cur])
            if cur == self.root_id:
                break
            cur = self.pages[cur].parent_id
        return list(reversed(out))

    def nav_children(self, page_id: str) -> list[SitePage]:
        """Subpages shown as navigation: database rows are reached through
        their database's table, as in the app's sidebar."""
        return [self.pages[c] for c in self.pages[page_id].children if not self.pages[c].is_row]

    def rows(self, database_id: str) -> list[SitePage]:
        return [self.pages[c] for c in self.pages[database_id].children]


class SiteContext(RenderContext):
    """RenderContext for one site: paths from the site map, files only when
    they belong to a page of this site, databases loaded on demand."""

    def __init__(self, db: DBSession, smap: SiteMap, prefix: str):
        super().__init__()
        self.db = db
        self.smap = smap
        self.prefix = prefix
        self._files: dict[str, File | None] = {}
        self._full: dict[str, Page] = {}

    def site_file(self, file_id: str) -> File | None:
        if file_id not in self._files:
            f = db_get_file(self.db, file_id)
            ok = f is not None and f.owner_id == self.smap.site.owner_id and f.page_id in self.smap.pages
            self._files[file_id] = f if ok else None
        return self._files[file_id]

    def file_url(self, file_id: str, name: str | None = None) -> str | None:
        f = self.site_file(file_id)
        return f"{self.prefix}/_files/{f.id}/{quote(f.filename, safe='')}" if f else None

    def page_path(self, page_id: str) -> str | None:
        p = self.smap.pages.get(page_id)
        return self.prefix + p.path if p else None

    def page(self, page_id: str) -> SitePage | None:
        return self.smap.pages.get(page_id)

    def full_pages(self, ids: list[str]) -> dict[str, Page]:
        """Complete Page rows (props, schema, options), fetched once each."""
        missing = [i for i in ids if i not in self._full]
        for i in range(0, len(missing), 2000):
            for p in self.db.scalars(select(Page).where(Page.id.in_(missing[i:i + 2000]))).all():
                self._full[p.id] = p
        return {i: self._full[i] for i in ids if i in self._full}

    def database(self, page_id: str):
        sp = self.smap.pages.get(page_id)
        if sp is None or sp.kind != "database":
            return None
        row_ids = [r.id for r in self.smap.rows(page_id)]
        full = self.full_pages([page_id, *row_ids])
        if page_id not in full:
            return None
        return full[page_id], [full[r] for r in row_ids if r in full]


def db_get_file(db: DBSession, file_id: str) -> File | None:
    if not file_id or len(file_id) > 36:
        return None
    return db.get(File, file_id)


# --- Serving -------------------------------------------------------------------


def dispatch(request: Request, host: str) -> Response | None:
    """Answer a request for a site's host, or None when no enabled site lives
    there (main.py then answers 404). Runs in a threadpool: plain sync code
    with its own database session."""
    with SessionLocal() as db:
        site = find_site(db, host)
        if site is None or not site.enabled:
            return None
        return serve(db, request, site, request.scope.get("path") or "/")


def serve(db: DBSession, request: Request, site: Site, path: str, prefix: str = "",
          preview: bool = False) -> Response | None:
    """One request against one site. ``prefix`` is "" on a custom domain and
    "/v/<slug>" on the app host; ``path`` never includes it. ``preview`` is a
    switched-off site shown to its owner: not cached, not indexed."""
    smap = SiteMap.load(db, site)
    if smap is None:
        return None
    if request.method not in ("GET", "HEAD"):
        return Response("Method not allowed", status_code=405, headers={"Allow": "GET, HEAD"})
    cache = PREVIEW_CACHE if preview else PAGE_CACHE
    path = path or "/"

    if path == "/robots.txt":
        return _robots(request, prefix, preview, cache)
    if path == "/sitemap.xml":
        return _sitemap(request, smap, prefix, cache)
    if path == "/favicon.svg":
        return _favicon(db, smap, prefix, cache)
    if path == "/favicon.ico":
        return RedirectResponse(f"{prefix}/favicon.svg", status_code=301)
    if path.startswith("/_files/"):
        return _file(db, request, smap, path, prefix, preview)

    if len(path) > 1 and path.endswith("/"):
        return RedirectResponse(prefix + path.rstrip("/"), status_code=301)
    page_id = smap.by_path.get(path)
    if page_id is None and path.lower() in smap.by_path:
        return RedirectResponse(prefix + path.lower(), status_code=301)
    if page_id is None:
        return _not_found(db, request, smap, prefix, preview)
    return render_page(db, request, smap, page_id, prefix, preview)


def _headers(cache: str, nonce: str | None = None) -> dict:
    h = {
        "Cache-Control": cache,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
    }
    if nonce is not None:
        h["Content-Security-Policy"] = (
            "default-src 'self'; "
            f"script-src 'nonce-{nonce}' 'strict-dynamic'; "
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "font-src 'self' data: https://cdn.jsdelivr.net; "
            "img-src * data: blob:; media-src *; "
            f"frame-src 'self' {' '.join(EMBED_HOSTS)}; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
        )
    return h


def _origin(request: Request, prefix: str) -> str:
    """scheme://host of this request (for sitemap, robots and og:image URLs).

    main.py's site middleware sits outside ProxyHeadersMiddleware, so on a site
    host the scope still says "http" behind Coolify's TLS proxy. The forwarded
    header is read here directly; it only ever shapes URLs we print."""
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip().lower()
    if proto not in ("http", "https"):
        proto = request.url.scheme
    host = request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}{prefix}"


def _robots(request: Request, prefix: str, preview: bool, cache: str) -> Response:
    if preview:
        body = "User-agent: *\nDisallow: /\n"
    else:
        body = f"User-agent: *\nAllow: /\n\nSitemap: {_origin(request, prefix)}/sitemap.xml\n"
    return Response(body, media_type="text/plain; charset=utf-8", headers=_headers(cache))


def _sitemap(request: Request, smap: SiteMap, prefix: str, cache: str) -> Response:
    origin = _origin(request, prefix)
    urls = []
    for p in sorted(smap.pages.values(), key=lambda p: (p.path.count("/") if p.path != "/" else 0, p.path)):
        lastmod = f"<lastmod>{p.updated_at:%Y-%m-%d}</lastmod>" if p.updated_at else ""
        loc = origin + (p.path if p.path != "/" else "/")
        urls.append(f"  <url><loc>{xml_escape(loc)}</loc>{lastmod}</url>")
    body = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(urls) + "\n</urlset>\n")
    return Response(body, media_type="application/xml", headers=_headers(cache))


def _site_options(site: Site) -> dict:
    o = site.options if isinstance(site.options, dict) else {}
    accent = o.get("accent") if isinstance(o.get("accent"), str) and re.match(r"^#[0-9a-fA-F]{6}$", o["accent"]) else None
    return {
        "title": (o.get("title") or "").strip() if isinstance(o.get("title"), str) else "",
        "description": (o.get("description") or "").strip() if isinstance(o.get("description"), str) else "",
        "footer": (o.get("footer") or "").strip() if isinstance(o.get("footer"), str) else "",
        # The bar along the top with the site's title (and, in most templates,
        # the navigation links). Sites published before the option keep it.
        "show_header": o.get("show_header") is not False,
        "show_nav": o.get("show_nav") is not False,
        "accent": (accent or DEFAULT_ACCENT).lower(),
    }


def _favicon(db: DBSession, smap: SiteMap, prefix: str, cache: str) -> Response:
    """The root page's emoji as an SVG icon, or its first letter on the accent."""
    root = smap.pages[smap.root_id]
    icon = (root.icon or "").strip()
    if icon.startswith("file:") or icon.lower().startswith(("http://", "https://")):
        url = SiteContext(db, smap, prefix).file_url(icon[5:]) if icon.startswith("file:") else icon
        if url and (url.startswith("/") or url.lower().startswith("https://")):
            return RedirectResponse(url, status_code=302, headers={"Cache-Control": cache})
        icon = ""
    if icon and len(icon) <= 16:
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
               f'<text x="50" y="50" dy=".35em" text-anchor="middle" font-size="84">{xml_escape(icon)}</text></svg>')
    else:
        opts = _site_options(smap.site)
        title = opts["title"] or root.title or "m"
        letter = next((ch for ch in title if ch.isalnum()), "m").upper()
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
               f'<rect width="100" height="100" rx="22" fill="{opts["accent"]}"/>'
               '<text x="50" y="50" dy=".35em" text-anchor="middle" font-size="58" font-weight="700" '
               'font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" '
               f'fill="{_ink(opts["accent"])}">{xml_escape(letter)}</text></svg>')
    return Response(svg, media_type="image/svg+xml", headers=_headers(cache))


def _file(db: DBSession, request: Request, smap: SiteMap, path: str, prefix: str, preview: bool) -> Response:
    parts = path.split("/")  # "", "_files", id, name...
    file_id = parts[2] if len(parts) > 2 else ""
    f = SiteContext(db, smap, prefix).site_file(file_id)
    if f is None:
        return _not_found(db, request, smap, prefix, preview)
    try:
        resp = file_response(f)
    except HTTPException:
        return _not_found(db, request, smap, prefix, preview)
    resp.headers["Cache-Control"] = PREVIEW_CACHE if preview else FILE_CACHE
    return resp


# --- Colours -------------------------------------------------------------------


def _rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _ink(hex_color: str) -> str:
    """Readable text colour on top of the accent (WCAG relative luminance)."""
    def lin(c: int) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(c) for c in _rgb(hex_color))
    return "#16161a" if 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 else "#ffffff"


def _mix_white(hex_color: str, amount: float) -> str:
    """A lighter accent for dark mode, where a dark accent would vanish."""
    return "#" + "".join(f"{round(c + (255 - c) * amount):02x}" for c in _rgb(hex_color))


# --- Page rendering ------------------------------------------------------------


def _first_paragraphs(db: DBSession, ids: list[str], limit: int = 180) -> dict[str, str]:
    """An excerpt per page: its first top-level paragraph with words in it."""
    out: dict[str, str] = {}
    if not ids:
        return out
    rows = db.execute(
        select(Block.page_id, Block.text)
        .where(Block.page_id.in_(ids), Block.parent_id.is_(None), Block.deleted.is_(False),
               Block.type == "paragraph", Block.text != "")
        .order_by(Block.page_id, Block.position)
    ).all()
    for pid, text in rows:
        if pid not in out and text.strip():
            out[pid] = truncate(inline_text(text), limit)
    return out


def _count_label(smap: SiteMap, p: SitePage) -> str:
    """What to say about a database that has no text of its own."""
    if p.kind != "database":
        return ""
    n = len(smap.rows(p.id))
    return f"{n} {'entry' if n == 1 else 'entries'}"


def _cards(db: DBSession, ctx: SiteContext, pages: list[SitePage], dates: dict | None = None) -> list[dict]:
    excerpts = _first_paragraphs(db, [p.id for p in pages])
    out = []
    for p in pages:
        when = (dates or {}).get(p.id) or p.created_at
        out.append({
            "id": p.id,
            "title": p.display_title,
            "icon": icon_html(p.icon, ctx, "card-icon"),
            "path": ctx.page_path(p.id),
            "cover": cover_info(p.cover, ctx),
            "excerpt": excerpts.get(p.id) or _count_label(ctx.smap, p),
            "date": long_date(when),
            "date_iso": when.isoformat()[:10] if when else "",
            "kind": p.kind,
        })
    return out


def _blog_posts(db: DBSession, ctx: SiteContext, smap: SiteMap) -> tuple[list[dict], set[str]]:
    """A blog's posts: the root's subpages, plus the rows of databases directly
    under the root (a "Posts" database is how many Notion blogs are built).
    Newest first, by a row's first date property or else creation time."""
    posts: list[SitePage] = []
    dates: dict[str, date | datetime] = {}
    covered: set[str] = set()
    for child in smap.nav_children(smap.root_id):
        covered.add(child.id)
        if child.kind == "database":
            data = ctx.database(child.id)
            if data:
                db_page, rows = data
                for r in rows:
                    posts.append(smap.pages[r.id])
                    d = row_date(db_page, r)
                    if d is not None:
                        dates[r.id] = d
        else:
            posts.append(child)

    # ISO strings sort dates and datetimes (naive or not) together correctly.
    posts.sort(key=lambda p: _iso(dates.get(p.id) or p.created_at), reverse=True)
    return _cards(db, ctx, posts, dates), covered


def _nav_tree(smap: SiteMap, ctx: SiteContext, current: str, open_ids: set[str], depth: int = 0) -> list[dict]:
    def node(p: SitePage, level: int) -> dict:
        kids = smap.nav_children(p.id) if level < 8 else []
        return {
            "title": p.display_title,
            "icon": icon_html(p.icon, ctx, "nav-icon"),
            "path": ctx.page_path(p.id),
            "active": p.id == current,
            "open": p.id in open_ids,
            "children": [node(k, level + 1) for k in kids],
        }
    return [node(p, 1) for p in smap.nav_children(smap.root_id)]


def _flatten(items: list[dict]) -> list[dict]:
    out = []
    for it in items:
        out.append(it)
        out.extend(_flatten(it["children"]))
    return out


def page_classes(options: dict | None) -> str:
    o = options if isinstance(options, dict) else {}
    classes = []
    if o.get("font") in ("serif", "mono"):
        classes.append(f"font-{o['font']}")
    if o.get("full_width") is True:
        classes.append("full-width")
    if o.get("small_text") is True:
        classes.append("small-text")
    return " ".join(classes)


def _base_context(request: Request, smap: SiteMap, ctx: SiteContext, prefix: str, preview: bool) -> dict:
    site = smap.site
    opts = _site_options(site)
    root = smap.pages[smap.root_id]
    accent = opts["accent"]
    top_nav = [
        {"title": p.display_title, "path": ctx.page_path(p.id), "icon": icon_html(p.icon, ctx, "nav-icon"), "id": p.id}
        for p in smap.nav_children(smap.root_id)[:7]
    ] if opts["show_nav"] else []
    return {
        "site": {
            "title": opts["title"] or root.display_title,
            "description": opts["description"],
            # Inline Markdown, so a footer can carry links ("[Imprint](https://...)").
            "footer": Markup(ctx.inline(opts["footer"])) if opts["footer"] else "",
            "show_header": opts["show_header"],
            "show_nav": opts["show_nav"],
            "template": site.template if site.template in TEMPLATE_IDS else "minimal",
            "home": prefix + "/",
            "icon": icon_html(root.icon, ctx, "brand-icon"),
        },
        "theme": {
            "accent": accent,
            "accent_ink": _ink(accent),
            "accent_dark": _mix_white(accent, 0.22),
            "accent_dark_ink": _ink(_mix_white(accent, 0.22)),
        },
        "top_nav": top_nav,
        "favicon": prefix + "/favicon.svg",
        "made_with": MADE_WITH_URL,
        "preview": preview,
        "year": datetime.now(timezone.utc).year,
    }


def render_page(db: DBSession, request: Request, smap: SiteMap, page_id: str, prefix: str,
                preview: bool) -> Response:
    site = smap.site
    ctx = SiteContext(db, smap, prefix)
    sp = smap.pages[page_id]
    full = ctx.full_pages([page_id])[page_id]
    template = site.template if site.template in TEMPLATE_IDS else "minimal"
    is_root = page_id == smap.root_id
    base = _base_context(request, smap, ctx, prefix, preview)

    blocks = db.scalars(select(Block).where(Block.page_id == page_id, Block.deleted.is_(False))).all()
    nodes = build_tree(blocks)
    # Taken before a landing page moves its first paragraph into the hero.
    page_excerpt = excerpt(nodes)

    posts: list[dict] = []
    features: list[dict] = []
    lead = Markup("")
    if template == "blog":
        posts, covered = _blog_posts(db, ctx, smap)
        if is_root:
            ctx.skip_page_ids |= covered
    if template == "landing" and is_root:
        first = first_paragraph(nodes)
        if first is not None:
            lead = Markup(ctx.inline(first.text))
            nodes = [n for n in nodes if n is not first]
        features = _cards(db, ctx, smap.nav_children(page_id))
        ctx.skip_page_ids |= {f["id"] for f in features}

    content = render_blocks(nodes, ctx)
    if sp.kind == "database":
        # A database published as a page: its content, then its table.
        data = ctx.database(page_id)
        if data:
            content = Markup(content + render_database(data[0], data[1], ctx, show_title=False))

    # A database row shows its property values above its content.
    properties = Markup("")
    row_when = None
    if sp.is_row:
        data = ctx.database(sp.parent_id)
        if data:
            properties = render_properties(data[0], full, ctx)
            row_when = row_date(data[0], full)

    # Subpages the content does not already link to get cards at the end, so
    # every page of the site is reachable without the sidebar.
    children = []
    if sp.kind != "database" and not (is_root and template in ("blog", "landing")):
        unlinked = [c for c in smap.nav_children(page_id)
                    if c.id not in ctx.linked_page_ids and c.id not in ctx.skip_page_ids]
        children = _cards(db, ctx, unlinked)

    cover = cover_info(sp.cover, ctx)
    when = row_when or sp.created_at
    if is_root:
        description = base["site"]["description"] or page_excerpt
    else:
        description = page_excerpt or base["site"]["description"]
    if template == "landing" and is_root and not lead and base["site"]["description"]:
        lead = Markup(esc(base["site"]["description"]))

    # Navigation.
    ancestors = smap.ancestors(page_id)
    crumbs = [{"title": a.display_title, "path": ctx.page_path(a.id), "icon": icon_html(a.icon, ctx, "crumb-icon")}
              for a in ancestors]
    nav, prev_link, next_link = [], None, None
    if template == "docs":
        open_ids = {a.id for a in smap.ancestors(page_id)} | {page_id}
        nav = _nav_tree(smap, ctx, page_id if not sp.is_row else (sp.parent_id or page_id), open_ids)
        order = [{"title": smap.pages[smap.root_id].display_title, "path": prefix + "/", "active": is_root}]
        order += _flatten(nav)
        idx = next((i for i, it in enumerate(order) if it["path"] == ctx.page_path(page_id)), None)
        if idx is not None:
            prev_link = order[idx - 1] if idx > 0 else None
            next_link = order[idx + 1] if idx + 1 < len(order) else None
    more_posts = []
    if template == "blog" and not is_root:
        more_posts = [p for p in posts if p["id"] != page_id][:3]

    site_title = base["site"]["title"]
    title = sp.display_title
    canonical = canonical_origin(site) + sp.path
    og_image = None
    if cover and cover["kind"] == "image":
        og_image = cover["url"] if cover["url"].startswith("http") else _origin(request, "") + cover["url"]

    nonce = secrets.token_urlsafe(16)
    context = {
        **base,
        "page": {
            "id": page_id,
            "title": title,
            "icon": icon_html(sp.icon, ctx, "page-icon"),
            "cover": cover,
            "path": ctx.page_path(page_id),
            "is_root": is_root,
            "is_row": sp.is_row,
            "kind": sp.kind,
            "date": long_date(when),
            "date_iso": when.isoformat()[:10] if when else "",
            "updated": long_date(sp.updated_at),
            "classes": page_classes(full.options),
            "properties": properties,
        },
        "content": content,
        "lead": lead,
        "children": children,
        "posts": posts,
        "more_posts": more_posts,
        "features": features,
        "breadcrumbs": crumbs,
        # The top-level page this one sits under, for highlighting the top nav.
        "section": ancestors[1].id if len(ancestors) > 1 else (None if is_root else page_id),
        "root_title": smap.pages[smap.root_id].display_title,
        "nav": nav,
        "prev": prev_link,
        "next": next_link,
        "toc": [h for h in ctx.headings if h["level"] <= 2],
        "meta": {
            "title": site_title if is_root else f"{title} · {site_title}",
            "og_title": site_title if is_root else title,
            "description": truncate(description, 300) if description else "",
            "canonical": canonical,
            "og_type": "website" if is_root else "article",
            "og_image": og_image,
            "noindex": preview,
        },
        "assets": {
            "nonce": nonce,
            "mermaid": ctx.needs_mermaid,
            "math": ctx.needs_math,
            "mermaid_url": MERMAID_URL,
            "katex_css": KATEX_CSS,
            "katex_js": KATEX_JS,
        },
    }
    html = _env.get_template(f"sites/{template}/page.html").render(**context)
    return HTMLResponse(html, headers=_headers(PREVIEW_CACHE if preview else PAGE_CACHE, nonce))


def _not_found(db: DBSession, request: Request, smap: SiteMap, prefix: str, preview: bool) -> Response:
    ctx = SiteContext(db, smap, prefix)
    base = _base_context(request, smap, ctx, prefix, preview)
    nonce = secrets.token_urlsafe(16)
    html = _env.get_template("sites/_404.html").render(
        **base,
        meta={"title": f"Page not found · {base['site']['title']}", "og_title": "Page not found",
              "description": "", "canonical": canonical_origin(smap.site) + "/", "og_type": "website",
              "og_image": None, "noindex": True},
        page={"classes": ""},
        assets={"nonce": nonce, "mermaid": False, "math": False},
    )
    return HTMLResponse(html, status_code=404, headers=_headers("no-cache", nonce))
