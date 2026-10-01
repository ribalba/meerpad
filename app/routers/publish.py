"""Publishing a page as a website: the owner's API (docs/DESIGN.md §7 and §9).

Serving the sites themselves is app/sites.py's job. This router manages the
``Site`` rows (one per published page) and adds every site's own address on
the app host, ``/v/<slug>/...``, with every link and file prefixed.

Addresses. Every site gets ``<BASE_URL>/v/<slug>``, where the owner picks the
slug: lowercase letters, digits and inner dashes, unique. A path rather than a
subdomain, because a path needs nothing from DNS or the proxy (a wildcard
subdomain needs both, and Coolify cannot route one). A custom domain is
optional; the owner points its A record at ``PUBLIC_IP`` and adds the domain
to the Coolify service. Nothing here checks DNS: the dialog shows the record
to create, and the site answers on the domain as soon as requests arrive.

Status codes: 422 for a value that can never be valid (bad format, unknown
template), 409 for one that is valid but taken (so the dialog can say "try
another"), 404 for a page that is not the caller's.
"""

import re
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DBSession

from .. import sites
from ..config import get_settings
from ..database import DB
from ..models import Page, Site, utcnow
from ..render import slugify
from ..security import CurrentUser, OptionalUser, new_id
from ..services import PageTree, get_owned_page

settings = get_settings()

router = APIRouter(prefix="/api/sites", tags=["publish"])

# Published sites on the app host: /v/<slug>/...
# main.py includes only ``router`` and ``preview_router``, so the per-page
# endpoints (/api/pages/{id}/site) are attached to this prefix-less router
# at the bottom of the module.
preview_router = APIRouter(tags=["publish"])
page_router = APIRouter(prefix="/api/pages", tags=["publish"])

_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_TLD = re.compile(r"^(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$")
_ACCENT = re.compile(r"^#[0-9a-fA-F]{6}$")
_OPTION_TEXT = {"title": 200, "description": 500, "footer": 500}


class SiteIn(BaseModel):
    # The name in <app>/v/<slug>. Omitted on first publish: the server suggests
    # one from the page title.
    slug: str | None = Field(default=None, max_length=100)
    custom_domain: str | None = Field(default=None, max_length=300)
    template: str = Field(default="minimal", max_length=40)
    enabled: bool = True
    options: dict = Field(default_factory=dict)


# --- Validation ------------------------------------------------------------------


def slug_problem(db: DBSession, slug: str, page_id: str | None = None) -> tuple[int, str] | None:
    """(status, message) when ``slug`` cannot be this page's address."""
    if not slug:
        return 422, "Choose an address"
    if not sites.SLUG_RE.match(slug):
        return 422, "Use lowercase letters, digits and dashes (at most 63), not starting or ending with a dash"
    taken = db.scalars(select(Site).where(Site.slug == slug)).first()
    if taken is not None and taken.page_id != page_id:
        return 409, f"/v/{slug} is already taken, please choose another name"
    return None


def normalize_domain(raw: str | None) -> str:
    """Forgiving about what people paste: "https://Example.com/" is example.com.
    International names are stored in their ASCII (punycode) form, which is
    what arrives in the Host header."""
    d = (raw or "").strip().lower()
    d = re.sub(r"^[a-z][a-z0-9+.-]*://", "", d)
    d = d.split("/", 1)[0].rstrip(".")
    if d and not d.isascii():
        try:
            d = d.encode("idna").decode("ascii")
        except UnicodeError:
            return d
    return d


def domain_problem(db: DBSession, domain: str, page_id: str | None = None) -> tuple[int, str] | None:
    labels = domain.split(".")
    if (len(domain) > 253 or len(labels) < 2 or not all(_LABEL.match(label) for label in labels)
            or not _TLD.match(labels[-1])):
        return 422, "That is not a valid domain name (for example: www.example.com)"
    app = settings.app_host
    if domain in (app, "www." + app):
        return 422, "That is the app's own address"
    taken = db.scalars(select(Site).where(Site.custom_domain == domain)).first()
    if taken is not None and taken.page_id != page_id:
        return 409, "Another site already uses this domain"
    return None


def clean_options(raw: dict) -> dict:
    """``{title?, description?, footer?, show_header, show_nav, accent?}``. Blank
    texts are dropped, unknown keys ignored (forward compatibility), wrong types
    refused."""
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="options must be an object")
    out: dict = {}
    for key, limit in _OPTION_TEXT.items():
        v = raw.get(key)
        if v is None:
            continue
        if not isinstance(v, str):
            raise HTTPException(status_code=422, detail=f"options.{key} must be text")
        v = v.strip()
        if len(v) > limit:
            raise HTTPException(status_code=422, detail=f"options.{key} is too long (at most {limit} characters)")
        if v:
            out[key] = v
    for key in ("show_header", "show_nav"):
        v = raw.get(key, True)
        if not isinstance(v, bool):
            raise HTTPException(status_code=422, detail=f"options.{key} must be true or false")
        out[key] = v
    accent = raw.get("accent")
    if accent not in (None, ""):
        if not isinstance(accent, str) or not _ACCENT.match(accent):
            raise HTTPException(status_code=422, detail='options.accent must be a colour like "#2383e2"')
        out["accent"] = accent.lower()
    return out


def suggest_slug(db: DBSession, title: str | None, page_id: str | None = None) -> str:
    """A free name from the page title: "Hühnerfarm" gives "huehnerfarm", then
    "huehnerfarm-2" if that is taken."""
    base = slugify(title, 40).strip("-")
    if not sites.SLUG_RE.match(base or ""):
        base = "site"
    candidate, n = base, 2
    while slug_problem(db, candidate, page_id) is not None and n < 1000:
        candidate, n = f"{base}-{n}", n + 1
    return candidate


def site_out(site: Site) -> dict:
    return {
        "id": site.id,
        "page_id": site.page_id,
        "slug": site.slug,
        "custom_domain": site.custom_domain,
        "template": site.template,
        "enabled": site.enabled,
        "options": site.options or {},
        "url": sites.site_url(site),
        "custom_url": sites.custom_url(site),
        # Same place: a switched-off site is visible there to its owner only.
        "preview_url": sites.site_path(site) + "/",
        "dns": {"type": "A", "name": site.custom_domain, "value": settings.public_ip or None},
    }


def _site_of(db: DBSession, page_id: str) -> Site | None:
    return db.scalars(select(Site).where(Site.page_id == page_id)).first()


# --- /api/sites --------------------------------------------------------------------


@router.get("/templates")
def list_templates() -> list[dict]:
    return sites.TEMPLATES


@router.get("")
def list_sites(db: DB, user: CurrentUser) -> list[dict]:
    rows = db.scalars(select(Site).where(Site.owner_id == user.id).order_by(Site.created_at, Site.id)).all()
    return [site_out(s) for s in rows]


@router.get("/check")
def check(
    db: DB,
    user: CurrentUser,
    slug: Annotated[str | None, Query(max_length=100)] = None,
    domain: Annotated[str | None, Query(max_length=300)] = None,
    page_id: Annotated[str | None, Query(max_length=36)] = None,
) -> dict:
    """Live validation for the publish dialog: is this name still free? With
    ``page_id`` (the page being published) its own current addresses do not
    count as taken, and the answer also carries a ``suggestion`` for the name."""
    page = db.get(Page, page_id) if page_id else None
    if page is not None and page.owner_id != user.id:
        page = None
    pid = page.id if page is not None else None
    details = []
    slug_ok = False
    if slug is not None:
        problem = slug_problem(db, slug.strip().lower(), pid)
        slug_ok = problem is None
        if problem:
            details.append(problem[1])
    domain_ok = True
    if domain:
        problem = domain_problem(db, normalize_domain(domain), pid)
        domain_ok = problem is None
        if problem:
            details.append(problem[1])
    out = {
        "slug_ok": slug_ok,
        "domain_ok": domain_ok,
        "detail": " ".join(details) or None,
        # The dialog shows "<base>/v/<slug>" before anything is published.
        "base_url": settings.base_url.rstrip("/"),
        "public_ip": settings.public_ip or None,
    }
    if page is not None:
        current = _site_of(db, page.id)
        out["suggestion"] = current.slug if current else suggest_slug(db, page.title, page.id)
    return out


# --- /api/pages/{id}/site ------------------------------------------------------------


@page_router.get("/{page_id}/site")
def get_site(page_id: str, db: DB, user: CurrentUser) -> dict:
    page = get_owned_page(db, page_id, user)
    site = _site_of(db, page.id)
    if site is None:
        raise HTTPException(status_code=404, detail="This page is not published")
    return site_out(site)


@page_router.put("/{page_id}/site")
def put_site(page_id: str, payload: SiteIn, db: DB, user: CurrentUser) -> dict:
    """Publish the page, or change its site. Only the owner, and not from the trash."""
    page = get_owned_page(db, page_id, user)
    if PageTree(db, page.workspace_id).is_trashed(page.id):
        raise HTTPException(status_code=409, detail="Restore the page from the trash before publishing it")
    site = _site_of(db, page.id)

    if payload.slug is None or not payload.slug.strip():
        slug = site.slug if site else suggest_slug(db, page.title, page.id)
    else:
        slug = payload.slug.strip().lower()
    problem = slug_problem(db, slug, page.id)
    if problem:
        raise HTTPException(status_code=problem[0], detail=problem[1])

    domain = normalize_domain(payload.custom_domain) or None
    if domain:
        problem = domain_problem(db, domain, page.id)
        if problem:
            raise HTTPException(status_code=problem[0], detail=problem[1])

    if payload.template not in sites.TEMPLATE_IDS:
        raise HTTPException(status_code=422, detail="Unknown template")
    options = clean_options(payload.options)

    if site is None:
        site = Site(id=new_id(), owner_id=user.id, page_id=page.id, slug=slug)
        db.add(site)
    site.slug = slug
    site.custom_domain = domain
    site.template = payload.template
    site.enabled = payload.enabled
    site.options = options
    site.updated_at = utcnow()
    try:
        db.commit()
    except IntegrityError:
        # Two dialogs raced for the same address: the unique index decided.
        db.rollback()
        raise HTTPException(status_code=409, detail="That address was just taken, please choose another")
    return site_out(site)


@page_router.delete("/{page_id}/site")
def delete_site(page_id: str, db: DB, user: CurrentUser) -> dict:
    """Unpublish: the addresses stop answering at once and become free again."""
    page = get_owned_page(db, page_id, user)
    site = _site_of(db, page.id)
    if site is None:
        raise HTTPException(status_code=404, detail="This page is not published")
    db.delete(site)
    db.commit()
    return {"ok": True}


# --- The sites, on the app host ----------------------------------------------------------


def _no_site() -> Response:
    return Response("No site is published at this address.", status_code=404, media_type="text/plain")


@preview_router.api_route("/v/{slug}", methods=["GET", "HEAD"], include_in_schema=False)
def site_root(slug: str) -> Response:
    # Relative links on the site assume the trailing slash of its root.
    return RedirectResponse(f"/v/{slug.lower()}/", status_code=307)


@preview_router.api_route("/v/{slug}/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
def site_page(
    slug: str,
    path: str,
    request: Request,
    db: DB,
    user: OptionalUser,
) -> Response:
    """A published site at its own address. A switched-off site stays visible
    to its owner (that is how you check it before switching it on), marked as
    a preview (not cached, not indexed), and is a 404 for everyone else."""
    site = db.scalars(select(Site).where(Site.slug == slug.lower())).first()
    if site is None:
        return _no_site()
    preview = not site.enabled
    if preview and (user is None or user.id != site.owner_id):
        return _no_site()
    resp = sites.serve(db, request, site, "/" + path, prefix=sites.site_path(site), preview=preview)
    return resp if resp is not None else _no_site()


# Last, so every route above is registered before the copy is taken.
preview_router.include_router(page_router)
