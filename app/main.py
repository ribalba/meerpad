"""meerpad-server: the notes app, its sync API, and every published website.

One process answers two kinds of request, told apart by the Host header:

* the app's own host (BASE_URL): the single-page app, its API, share links,
  and every published website under ``/v/<name>`` (routers/publish.py);
* any other host: a custom domain someone pointed at a published website
  (app/sites.py). An unknown host gets a 404.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from . import sites
from .config import get_settings
from .database import init_db
from .routers import auth, files, imports, pages, publish, share, sync
from .security import OptionalUser

settings = get_settings()
logger = logging.getLogger("uvicorn.error")
STATIC_DIR = Path(__file__).resolve().parent / "static"
VERSION = (Path(__file__).resolve().parent.parent / "VERSION").read_text().strip() if (
    Path(__file__).resolve().parent.parent / "VERSION"
).exists() else "dev"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    imports.resume_pending()
    yield


app = FastAPI(title="meerpad", version=VERSION, lifespan=lifespan)


@app.middleware("http")
async def published_sites(request: Request, call_next):
    """Hand any request for a published website's host to app/sites.py."""
    host = (request.headers.get("host") or "").split(":")[0].lower().rstrip(".")
    if host and host != settings.app_host and not sites.is_app_host(host):
        response = await run_in_threadpool(sites.dispatch, request, host)
        if response is not None:
            return response
        return Response("No site is published at this address.", status_code=404, media_type="text/plain")
    return await call_next(request)


# Coolify's Traefik terminates TLS; trust its X-Forwarded-* so request.url and the
# client address are the real ones. Added *after* published_sites on purpose:
# Starlette runs the last-added middleware first, and the site router has to see
# the forwarded scheme (https) when it builds canonical URLs.
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

app.include_router(auth.router)
app.include_router(sync.router)
app.include_router(pages.router)
app.include_router(files.router)
app.include_router(share.router)
app.include_router(publish.router)
app.include_router(publish.preview_router)
app.include_router(imports.router)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/api/version")
def version() -> dict:
    return {"version": VERSION}


class RevalidatingStatic(StaticFiles):
    """Static files the browser must revalidate (ETag) before reuse: an edit to a
    script shows up on the next load, without cache-busting names (meerpic's)."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/static", RevalidatingStatic(directory=STATIC_DIR), name="static")


@app.get("/sw.js")
def service_worker() -> FileResponse:
    # Served from the root so its scope covers the whole app.
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest() -> FileResponse:
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


def _app_shell() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/")
def index(user: OptionalUser) -> Response:
    # Signed in: the app. Otherwise the landing page with the sign-in button.
    if user is None:
        return FileResponse(STATIC_DIR / "landing.html", headers={"Cache-Control": "no-cache"})
    return _app_shell()


@app.get("/app")
def app_entry() -> FileResponse:
    # The installed PWA and the desktop app start here: always the app shell, which
    # works offline and sends a signed-out visitor to /login itself.
    return _app_shell()


@app.get("/p/{page_id}")
def page_entry(page_id: str) -> FileResponse:
    return _app_shell()


@app.get("/login")
def login_page(user: OptionalUser) -> Response:
    if user is not None:
        return RedirectResponse("/", status_code=302)
    return FileResponse(STATIC_DIR / "login.html", headers={"Cache-Control": "no-cache"})


@app.get("/s/{token}")
@app.get("/s/{token}/{page_id}")
def share_entry(token: str, page_id: str | None = None) -> FileResponse:
    # The share page reads the token from the URL client-side.
    return FileResponse(STATIC_DIR / "share.html", headers={"Cache-Control": "no-cache"})


@app.exception_handler(404)
async def not_found(request: Request, exc) -> Response:
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": getattr(exc, "detail", "Not found")}, status_code=404)
    return Response("Not found", status_code=404, media_type="text/plain")
