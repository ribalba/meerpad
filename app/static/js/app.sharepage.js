/* The share-link view: /s/<token> and /s/<token>/<page id>.

   A visitor gets the same editor and database views as the owner, on a copy
   of the shared tree kept in memory only (App.db.useMemory): their browser is
   not where someone else's pages should end up stored, and closing the tab
   leaves nothing behind. The sync loop runs against /api/share/<token>/…,
   which scopes every pull to the shared page and what is below it, and
   refuses pushes from a view link.

   The link can be turned off or replaced while the page is open; the next
   failed sync notices and the view says so. */

window.App = window.App || {};

(async function sharePage() {
  const m = /^\/s\/([^/]+)(?:\/([^/]+))?\/?$/.exec(location.pathname);
  const token = m ? decodeURIComponent(m[1]) : "";
  const say = (text) => { const t = document.getElementById("boot-text"); if (t) t.textContent = text; };

  /* The friendly dead end: turned off, replaced, or never existed. */
  function deadLink() {
    document.title = "This link does not work anymore";
    const bootEl = document.getElementById("boot");
    if (bootEl) bootEl.remove();
    document.getElementById("app").hidden = true;
    const old = document.querySelector(".dead-link");
    if (old) old.remove();
    document.body.append(App.el("div", { class: "dead-link" },
      App.el("div", { class: "empty-state" },
        App.el("img", { src: "/static/img/logo.png", alt: "" }),
        App.el("h2", { text: "This link does not work anymore" }),
        App.el("p", { text: "The person who shared it may have turned it off or replaced it with a new one. Ask them for a fresh link." }),
        App.el("div", { class: "btn-row" }, App.el("a", { class: "btn btn-primary", href: "/", text: "Go to meerpad" })))));
  }

  async function fetchInfo() {
    const resp = await fetch(`/api/share/${encodeURIComponent(token)}`, { credentials: "same-origin", cache: "no-store" });
    if (resp.status === 404 || resp.status === 403 || resp.status === 410) return { dead: true };
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  if (!token) { deadLink(); return; }
  let info;
  try {
    info = await fetchInfo();
  } catch (e) {
    say(navigator.onLine ? "Could not reach meerpad. Retrying…" : "You are offline. The shared page opens when you are back online.");
    const retry = () => location.reload();
    window.addEventListener("online", retry, { once: true });
    setTimeout(retry, 8000);
    return;
  }
  if (info.dead) { deadLink(); return; }

  const rootId = info.root_page_id;
  const readOnly = info.mode !== "edit";

  // --- navigation within the share ------------------------------------------------------
  // Replaces the owner's App.nav from app.shell.js. Content links written as
  // /p/<id> (DESIGN §3) are honoured too, and resolve inside the share.
  const base = `/s/${encodeURIComponent(token)}`;
  let current = null;
  const ID = "([0-9a-zA-Z-]{8,64})";
  const SHARE_RE = new RegExp(`^/s/[^/]+(?:/${ID})?/?$`);
  const PAGE_RE = new RegExp(`^/p/${ID}/?$`);

  App.nav = {
    pageHref: (id, blockId) => `${base}${id && id !== rootId ? `/${encodeURIComponent(id)}` : ""}${blockId ? `#${encodeURIComponent(blockId)}` : ""}`,
    current: () => current,
    homeId: () => rootId,
    parse(pathname, hash = "") {
      const blockId = (hash || "").replace(/^#/, "") || null;
      const s = SHARE_RE.exec(pathname || "");
      if (s && pathname.startsWith(base)) return { pageId: s[1] || rootId, blockId };
      const p = PAGE_RE.exec(pathname || "");
      if (p) return { pageId: p[1], blockId };
      return null;
    },
    openPage(id, { blockId = null, replace = false, fresh = false } = {}) {
      if (!id) return;
      const href = App.nav.pageHref(id, blockId);
      if (location.pathname + location.hash !== href) {
        if (replace) history.replaceState({ pageId: id }, "", href);
        else history.pushState({ pageId: id }, "", href);
      }
      show(id, { blockId, fresh });
    },
    route() {
      const hit = App.nav.parse(location.pathname, location.hash) || { pageId: rootId };
      show(hit.pageId, { blockId: hit.blockId });
      return true;
    },
  };

  function show(id, { blockId = null, fresh = false } = {}) {
    const same = current === id && App.page.current() === id;
    current = id;
    App.sidebar.setActive(id);
    if (same) { if (blockId) App.page.scrollToBlock(blockId); }
    else App.page.show(id, { blockId, fresh });
    if (App.shell.isNarrow()) App.shell.closeDrawer();
  }
  window.addEventListener("popstate", () => App.nav.route());

  // --- the in-memory copy and the sync loop ------------------------------------------------
  App.db.useMemory();
  App.files.shareToken = token;
  App.sync.configure({
    push: `/api/share/${encodeURIComponent(token)}/push`,
    pull: `/api/share/${encodeURIComponent(token)}/pull`,
    readOnly,
    pollMs: 8000,
  });
  await App.sync.init();
  await App.store.load();
  App.store.configure({ mode: info.mode, readOnly, shareRootId: rootId, me: null });
  App.page.configure({ mode: "share", share: { ...info, token } });

  App.shell.init({ mode: "share" });
  App.sidebar.init(document.getElementById("sidebar"), { mode: "share", shareRootId: rootId, readOnly });
  const appEl = document.getElementById("app");
  appEl.hidden = false;
  const bootEl = document.getElementById("boot");
  if (bootEl) bootEl.remove();
  App.shell.showState({ spinner: true, title: "Loading the shared page…" });

  /* The tree only earns its space when there is more than one page. */
  function updateTree() {
    const hasSubpages = App.store.page(rootId) && App.store.page(rootId).kind !== "database" && App.store.children(rootId).length > 0;
    appEl.classList.toggle("no-tree", !hasSubpages);
  }
  App.bus.on("store:change", (ch) => { if (ch.pages.size) updateTree(); });

  // A sync that fails with a status (not a lost connection) may mean the link
  // was switched off: ask the share endpoint, and show the dead end if so.
  let checking = false;
  App.bus.on("sync:status", async (s) => {
    if (!s.lastError || s.busy || checking || !navigator.onLine) return;
    checking = true;
    try {
      const again = await fetchInfo();
      if (again.dead) deadLink();
    } catch (e) { /* the server is having a moment; the loop retries */ }
    checking = false;
  });

  App.sync.start();
  await App.sync.flush();
  App.shell.markSynced();
  updateTree();
  App.nav.route();
})().catch((e) => {
  console.error("share view failed", e);
  const t = document.getElementById("boot-text");
  if (t) t.textContent = `The shared page could not open: ${e.message}`;
});
