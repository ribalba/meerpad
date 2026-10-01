/* Service worker: the app opens offline, without ever serving stale data.

   meerato's worker, adapted. The pages themselves never come from here: they
   live in IndexedDB and reach the server through the sync API, which this
   worker leaves alone. What it keeps is the shell (the HTML, CSS and scripts
   that run the app) and file contents (images in pages), so that a laptop on
   a train opens meerpad and shows the pictures too.

   Strategy:
     - App navigations (/, /app, /p/<id>): the app shell. /app and /p/<id> are
       STALE-WHILE-REVALIDATE: the cached shell paints at once (even offline or
       on a cold worker), and a background fetch refreshes it so a new release
       lands on the next load. Every one of those URLs serves the same
       index.html, so they share the one cache entry, "/app".
       "/" is NETWORK-FIRST instead: signed out, the server answers it with
       the landing page, which must never end up cached as the app. Offline it
       falls back to the shell.
     - /api/files/<id>: CACHE-FIRST. A file id's content never changes, so a
       cached copy is always right, and pictures stay visible offline. Share-link
       visitors' requests (?share=) are not cached: someone else's files should
       not be stored in their browser.
     - Other same-origin GETs (static assets, small API reads): NETWORK-FIRST,
       falling back to the cache when offline.
     - Never touched: anything but GET, the sync and share APIs, sign-in, share
       pages (/s/…), published sites (/v/…), and other hosts.

   Bump VERSION whenever the precache list changes, to evict old caches. */

const VERSION = "meerpad-v6";

// The local shell: small, so blocking install on it is fast and safe. Missing
// entries (a module not deployed yet) are skipped rather than failing install.
const SHELL = [
  "/app",
  "/static/css/app.css",
  "/static/css/editor.css",
  "/static/js/app.theme.js",
  "/static/js/app.core.js",
  "/static/js/app.icons.js",
  "/static/js/app.ui.js",
  "/static/js/app.db.js",
  "/static/js/app.sync.js",
  "/static/js/app.store.js",
  "/static/js/app.markdown.js",
  "/static/js/app.highlight.js",
  "/static/vendor/highlight/highlight.min.js",
  "/static/js/app.mdblocks.js",
  "/static/js/app.editor.js",
  "/static/js/app.editor.menus.js",
  "/static/js/app.editor.media.js",
  "/static/js/app.editor.grid.js",
  "/static/js/app.editor.input.js",
  "/static/js/app.shell.js",
  "/static/js/app.sidebar.js",
  "/static/js/app.page.js",
  "/static/js/app.database.js",
  "/static/js/app.search.js",
  "/static/js/app.share.js",
  "/static/js/app.publish.js",
  "/static/js/app.import.js",
  "/static/js/app.settings.js",
  "/static/js/app.welcome.js",
  "/static/js/app.trash.js",
  "/static/js/app.history.js",
  "/static/js/app.boot.js",
  "/static/img/logo.png",
  "/static/img/favicon-32.png",
  "/static/img/favicon-64.png",
  "/static/img/favicon-180.png",
  "/manifest.webmanifest",
];

const SHELL_KEY = "/app";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Let the browser start the navigation's network request while the
    // worker boots; the stale-while-revalidate refresh uses it.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("meerpad-") && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Worth keeping: a complete, same-origin, successful answer. A 206 (a video
   seeking) cannot be stored, and an error page must not replace a good copy. */
const cacheable = (resp) => resp && resp.ok && resp.status === 200 && resp.type === "basic";

function put(key, resp) {
  if (!cacheable(resp)) return;
  const copy = resp.clone();
  caches.open(VERSION).then((c) => c.put(key, copy)).catch(() => {});
}

const isShellPath = (p) => p === "/app" || /^\/p\/[^/]+\/?$/.test(p);

function untouched(url) {
  const p = url.pathname;
  return p.startsWith("/api/sync/") || p.startsWith("/api/share/") || p.startsWith("/api/auth/")
    || p === "/login" || p.startsWith("/s/") || p.startsWith("/v/") || p === "/sw.js";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // writes go straight to the network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (untouched(url)) return;

  if (request.mode === "navigate") {
    if (isShellPath(url.pathname)) { event.respondWith(shellFirst(event)); return; }
    if (url.pathname === "/") { event.respondWith(networkThenShell(event)); return; }
    return; // other pages (published sites, 404s): the network's
  }

  if (url.pathname.startsWith("/api/files/")) {
    if (url.searchParams.has("share") || request.headers.has("range")) return;
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

/* The app shell, from the cache at once; refreshed in the background. */
async function shellFirst(event) {
  const cached = await caches.match(SHELL_KEY);
  const refresh = (async () => {
    try {
      const resp = (await event.preloadResponse) || (await fetch(event.request));
      if (resp && resp.ok && (resp.headers.get("content-type") || "").includes("text/html")) put(SHELL_KEY, resp);
      return resp;
    } catch (e) {
      return null;
    }
  })();
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || Response.error();
}

/* "/": the network decides (landing page or app); offline, the shell. */
async function networkThenShell(event) {
  try {
    const resp = (await event.preloadResponse) || (await fetch(event.request));
    if (resp) return resp;
  } catch (e) { /* offline */ }
  return (await caches.match(SHELL_KEY)) || Response.error();
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  put(request, resp);
  return resp;
}

async function networkFirst(request) {
  try {
    const resp = await fetch(request);
    const cc = resp.headers.get("cache-control") || "";
    if (!cc.includes("no-store")) put(request, resp);
    return resp;
  } catch (e) {
    const cached = await caches.match(request);
    return cached || Response.error();
  }
}
