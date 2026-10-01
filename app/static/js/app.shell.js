/* The app shell: the layout around the page, navigation (App.nav), the sync
   status indicator, global keys, and what happens when the session is lost.

   Two front ends share it: the signed-in app (index.html) and the share-link
   view (share.html). Everything here works for both; the share view replaces
   App.nav with its own (its URLs are /s/<token>/<page id>) after this file
   has loaded. The sidebar and the page view are their own modules
   (app.sidebar.js, app.page.js); this file only arranges them. */

window.App = window.App || {};

App.shell = (() => {
  let appEl = null;
  let mainEl = null;
  let syncBtn = null;
  let syncState = { online: navigator.onLine, busy: false, pending: 0, parked: 0, lastOk: null, lastError: null };
  let authLost = false;
  let authLostAt = 0;
  let lastAuthToast = 0;
  let synced = false;               // the first pull after boot has finished
  const syncedWaiters = [];
  const MIN_W = 200;
  const MAX_W = 480;
  const DEFAULT_W = 236;

  const narrowQuery = window.matchMedia("(max-width: 800px)");
  const isNarrow = () => narrowQuery.matches;

  function init({ mode = "owner" } = {}) {
    appEl = App.$("#app");
    mainEl = App.$("#main");
    applyWidth(App.local.get("sidebar.width", DEFAULT_W));
    appEl.classList.toggle("sidebar-collapsed", Boolean(App.local.get("sidebar.collapsed", false)));
    const scrim = App.$("#scrim");
    if (scrim) scrim.addEventListener("click", closeDrawer);
    bindKeys(mode);
    bindLinks();
    App.bus.on("sync:status", (s) => {
      syncState = s;
      // Signed back in (another tab, or the cookie came back): a sync that
      // succeeded after the loss clears the warning.
      if (authLost && s.lastOk && s.lastOk.getTime() > authLostAt) authLost = false;
      renderSync();
    });
    App.bus.on("auth:lost", onAuthLost);
    App.sync.status().then((s) => { syncState = s; renderSync(); }).catch(() => {});
    // The label says "3 min ago" in its tooltip; keep that honest.
    setInterval(renderSync, 30000);
  }

  // --- sidebar: collapse, drawer, width ---------------------------------------------
  function applyWidth(w) {
    const width = Math.max(MIN_W, Math.min(MAX_W, Number(w) || DEFAULT_W));
    document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
    return width;
  }

  function setCollapsed(on) {
    appEl.classList.toggle("sidebar-collapsed", on);
    App.local.set("sidebar.collapsed", on);
    App.bus.emit("sidebar:toggle", { collapsed: on });
  }

  /* One key and one button for both layouts: a column on a desktop, a drawer
     on a phone. */
  function toggleSidebar() {
    if (isNarrow()) {
      if (document.body.classList.contains("drawer-open")) closeDrawer();
      else openDrawer();
    } else {
      setCollapsed(!appEl.classList.contains("sidebar-collapsed"));
    }
  }
  function openDrawer() { document.body.classList.add("drawer-open"); }
  function closeDrawer() { document.body.classList.remove("drawer-open"); }

  /* Drag the sidebar's right edge. Pointer events rather than HTML drag and
     drop: there is nothing being dropped, only a width being chosen. */
  function attachResizer(sidebarEl) {
    const handle = App.el("div", { class: "sb-resizer", title: "Drag to resize, double-click to reset", "aria-hidden": "true" });
    sidebarEl.append(handle);
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      appEl.classList.add("resizing");
      const left = sidebarEl.getBoundingClientRect().left;
      let width = null;
      const move = (ev) => { width = applyWidth(ev.clientX - left); };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        appEl.classList.remove("resizing");
        if (width) App.local.set("sidebar.width", width);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => App.local.set("sidebar.width", applyWidth(DEFAULT_W)));
  }

  /* The button that brings the sidebar back: shown by CSS only when the
     sidebar is collapsed, or always on a phone. */
  function sidebarButton() {
    return App.el("button", {
      class: "icon-btn sb-open", type: "button", title: "Show sidebar (Ctrl+\\)", "aria-label": "Show sidebar",
      html: App.icon("menu", 18), onclick: () => (isNarrow() ? openDrawer() : setCollapsed(false)),
    });
  }

  // --- keyboard focus: the page list and the page ---------------------------------------
  /* The page list takes the keyboard (on the open page's row). Opens the
     sidebar first when it is folded away or, on a phone, a closed drawer. */
  function focusPages() {
    if (!App.sidebar || !App.sidebar.focus) return false;
    if (isNarrow()) openDrawer();
    else if (appEl.classList.contains("sidebar-collapsed")) setCollapsed(false);
    return App.sidebar.focus();
  }

  /* The open page takes the keyboard: the editor where the cursor last was,
     or the page itself (a database, a page still loading). */
  function focusPage() {
    if (isNarrow()) closeDrawer();
    const ed = App.page && App.page.editor ? App.page.editor() : null;
    if (ed && ed.focusDefault) { ed.focusDefault(); return true; }
    const target = mainEl && mainEl.querySelector(".page-container, .empty-state");
    if (!target) return false;
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    return true;
  }

  // --- the main area ------------------------------------------------------------------
  function main() { return mainEl; }

  /* A full-height state in the main area: "Loading your pages…", "Page not
     found", offline on first run. Keeps the topbar's sidebar button so a phone
     can still reach the tree. */
  function showState({ icon = null, emoji = null, title = "", text = "", spinner = false, actions = [] } = {}) {
    const box = App.el("div", { class: "empty-state" });
    if (spinner) box.append(App.el("div", { class: "spinner spinner-large" }));
    else if (emoji) box.append(App.el("div", { class: "empty-icon", text: emoji }));
    else if (icon) box.append(App.el("div", { class: "empty-icon", html: App.icon(icon, 36) }));
    if (title) box.append(App.el("h2", { text: title }));
    if (text) box.append(App.el("p", { text }));
    if (actions.length) {
      box.append(App.el("div", { class: "btn-row" }, actions.map((a) => App.el("button", {
        class: `btn${a.primary ? " btn-primary" : ""}`, type: "button", text: a.label, onclick: a.run,
      }))));
    }
    const view = App.el("div", { class: "page-view state-view" },
      App.el("header", { class: "topbar" }, sidebarButton(), App.el("div", { class: "crumbs" }), syncButton()),
      App.el("div", { class: "page-scroll" }, box));
    mainEl.replaceChildren(view);
    return view;
  }

  // --- the first pull ------------------------------------------------------------------
  function markSynced() {
    if (synced) return;
    synced = true;
    syncedWaiters.splice(0).forEach((fn) => fn());
    App.bus.emit("sync:first");
  }
  const whenSynced = () => (synced ? Promise.resolve() : new Promise((r) => syncedWaiters.push(r)));

  // --- sync status ---------------------------------------------------------------------
  function syncButton() {
    if (!syncBtn) {
      syncBtn = App.el("button", { class: "sync", type: "button", onclick: onSyncClick },
        App.el("span", { class: "sync-dot" }), App.el("span", { class: "sync-label" }));
      renderSync();
    }
    return syncBtn;
  }

  function describeSync() {
    const s = syncState;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (authLost) return { cls: "parked", label: "Signed out", title: "Your session ended. Sign in again to sync; your changes are kept on this device." };
    if (s.parked) return { cls: "parked", label: `${plural(s.parked, "change", "changes")} could not sync`, title: "Click to see what went wrong" };
    if (!s.online) {
      return {
        cls: "offline",
        label: s.pending ? `Offline, ${s.pending} pending` : "Offline",
        title: "You are offline. Changes are saved on this device and sync when you are back online.",
      };
    }
    if (s.busy) return { cls: "busy", label: "Syncing…", title: "Syncing with the server" };
    if (s.pending) return { cls: "pending", label: "Saving…", title: `${plural(s.pending, "change", "changes")} waiting to sync` };
    if (s.lastError) return { cls: "offline", label: "Sync paused", title: `The server said: ${s.lastError}` };
    return { cls: "", label: "Saved", title: s.lastOk ? `Everything is synced (${App.fmt.ago(s.lastOk.toISOString())})` : "Everything is saved on this device" };
  }

  function renderSync() {
    if (!syncBtn) return;
    const d = describeSync();
    syncBtn.className = `sync${d.cls ? ` ${d.cls}` : ""}`;
    syncBtn.querySelector(".sync-label").textContent = d.label;
    syncBtn.title = d.title;
    syncBtn.setAttribute("aria-label", `Sync status: ${d.label}`);
  }

  function onSyncClick() {
    if (authLost) { signIn(); return; }
    if (syncState.parked) { showParked(); return; }
    if (App.settings && App.store.mode() === "owner") { App.settings.open("sync"); return; }
    App.sync.flush();
  }

  /* The changes the server refused three times. Each says what it touched and
     why it was refused; the user can try again (after fixing whatever it was)
     or give up on them. */
  async function showParked() {
    const ops = await App.sync.parkedOps();
    const describe = (op) => {
      if (op.entity === "workspace") {
        const w = App.store.workspace(op.id);
        return `Workspace "${w ? w.name : "unknown"}"`;
      }
      if (op.entity === "page") {
        const p = App.store.page(op.id);
        return `Page "${p ? App.ui.titleOf(p) : "unknown"}"`;
      }
      const b = App.store.block(op.id);
      const p = b ? App.store.page(b.page_id) : null;
      return p ? `A block in "${App.ui.titleOf(p)}"` : "A block";
    };
    const list = App.el("ul", { class: "parked-list" }, ops.map((op) => App.el("li", { class: "parked-item" },
      App.el("div", { class: "parked-what", text: describe(op) }),
      App.el("div", { class: "parked-why", text: op.last_error || "The server refused this change." }),
      App.el("div", { class: "parked-meta", text: `Changed: ${Object.keys(op.data || {}).join(", ") || "nothing"} · ${App.fmt.ago(op.updated_at)}` }))));
    const body = App.el("div", {},
      App.el("p", { text: ops.length
        ? "The server refused these changes several times, so they were set aside. The rest of your work keeps syncing."
        : "Nothing is waiting. Everything synced." }),
      ops.length ? list : null,
      ops.length ? App.el("p", { class: "field-help", text: "Retry sends them again. Discard stops sending them; this device keeps showing them until you re-download everything in Settings, Sync." }) : null);
    App.ui.modal({
      title: ops.length ? `${ops.length} ${ops.length === 1 ? "change" : "changes"} could not sync` : "Sync",
      body,
      actions: ops.length ? [
        { label: "Discard", danger: false, onClick: async () => {
          const ok = await App.ui.confirm("Stop sending these changes to the server? They stay visible on this device until you re-download everything.", { title: "Discard changes?", confirmLabel: "Discard", danger: true });
          if (ok) { await App.sync.discardParked(); App.toast("Discarded"); }
        } },
        { label: "Retry", primary: true, onClick: async () => { await App.sync.retryParked(); } },
      ] : [{ label: "Close", primary: true }],
    });
  }

  // --- session --------------------------------------------------------------------------
  function signIn() {
    const next = location.pathname + location.search + location.hash;
    location.href = `/login?next=${encodeURIComponent(next)}`;
  }

  /* The session cookie expired or was revoked. Nothing local is thrown away:
     the queue stays in IndexedDB and goes out once the user is back. */
  function onAuthLost() {
    if (App.store.mode() !== "owner") return;
    authLost = true;
    authLostAt = Date.now();
    renderSync();
    if (Date.now() - lastAuthToast < 60000) return;
    lastAuthToast = Date.now();
    App.toast("You were signed out. Your changes are kept on this device.", {
      kind: "warning", duration: 15000, action: { label: "Sign in", run: signIn },
    });
  }

  // --- keys --------------------------------------------------------------------------------
  const isEditable = (el) => Boolean(el && el.closest
    && (el.isContentEditable || el.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")));

  function bindKeys(mode) {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("drawer-open")) { closeDrawer(); return; }
      // Escape anywhere in the page (that nothing closer claimed: a menu, a
      // dialog, a cell being edited, the editor's own text) goes back to the
      // page list. Keyboard navigation: Enter goes in, Escape comes out.
      if (e.key === "Escape" && !e.defaultPrevented && mainEl && mainEl.contains(e.target)
          && !document.querySelector(".modal-backdrop, .popover")
          && !(e.target.closest && e.target.closest(".filter-region"))) {
        if (focusPages()) e.preventDefault();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      // The editor handles its own keys first (Ctrl/Cmd+K makes a link of
      // the selected text there); what it claimed is not ours.
      if (!mod || e.repeat || e.defaultPrevented) return;
      const key = (e.key || "").toLowerCase();
      const inEditorSelection = key === "k" && e.target && e.target.isContentEditable
        && !(window.getSelection() || { isCollapsed: true }).isCollapsed;
      // e.code as well: on a Mac, Option+N types "˜", and on many European
      // layouts the backslash needs AltGr.
      if (key === "s" && !e.altKey && !e.shiftKey) {
        e.preventDefault(); // not the browser's "Save page as"
        saveNow();
      } else if ((key === "k" || key === "p") && !e.altKey && !e.shiftKey) {
        if (App.search && !inEditorSelection) { e.preventDefault(); App.search.open(); }
      } else if (key === "\\" || e.code === "Backslash") {
        e.preventDefault();
        toggleSidebar();
      } else if ((key === "n" && !e.altKey && !e.shiftKey) || (e.altKey && e.code === "KeyN")) {
        // Browsers keep Ctrl/Cmd+N for a new window and never deliver it
        // here, so Alt+N stays; the desktop app gets the plain key.
        if (mode === "owner" && App.nav.newPage) { e.preventDefault(); App.nav.newPage(); }
      } else if (!isEditable(e.target) && !document.querySelector(".modal-backdrop")) {
        // Inside a text field the browser (or the editor) owns undo.
        if (key === "z" && !e.altKey) {
          e.preventDefault();
          if (e.shiftKey) App.store.redo(); else App.store.undo();
        } else if (key === "y" && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          App.store.redo();
        }
      }
    });
    narrowQuery.addEventListener("change", () => closeDrawer());
  }

  /* Ctrl/Cmd+S. Every change saves and syncs on its own; this does it now:
     the text still waiting for its debounce goes to the store, the queue to
     the server, and a toast says how that went. */
  async function saveNow() {
    if (App.store.isReadOnly()) return;
    if (App.page && App.page.flush) App.page.flush();
    const r = await App.sync.flush();
    if (r && r.ok === false) {
      App.toast(navigator.onLine
        ? "Could not reach the server. Your changes are kept and sync later."
        : "You are offline. Your changes sync when you are back online.", { kind: "warning" });
    } else if (r && r.parked) {
      App.toast(`${r.parked} ${r.parked === 1 ? "change" : "changes"} could not sync. Click the status to see why.`, { kind: "warning" });
    } else {
      App.toast("Saved", { kind: "ok", duration: 1500 });
    }
  }

  /* Plain clicks on links to pages open them in place; modified clicks (new
     tab, new window) are left to the browser, which is why the tree and the
     breadcrumbs are real links. */
  function bindLinks() {
    document.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      let url;
      try { url = new URL(a.getAttribute("href"), location.href); } catch (err) { return; }
      if (url.origin !== location.origin || !App.nav || !App.nav.parse) return;
      const hit = App.nav.parse(url.pathname, url.hash);
      if (!hit) return;
      e.preventDefault();
      App.nav.openPage(hit.pageId, { blockId: hit.blockId });
    });
  }

  // --- small shared helpers ------------------------------------------------------------------
  /* Copy text, with the old execCommand path for browsers (and insecure
     origins) without the async clipboard. */
  async function copy(text, message = "Copied") {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = App.el("textarea", { style: "position:fixed;top:-200px;left:0;opacity:0", readonly: true });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      ta.remove();
    }
    if (ok) { if (message) App.toast(message); return true; }
    App.ui.prompt("Your browser did not allow copying. Select the text and copy it yourself:", { title: "Copy", value: text, confirmLabel: "Done" });
    return false;
  }

  const absoluteUrl = (path) => `${location.origin}${path}`;

  /* A page's icon for lists (sidebar, breadcrumbs, search, trash): its emoji
     or Tabler icon, its image, or a page or database glyph. */
  function pageIcon(page, { size = 16, fallback = true } = {}) {
    const ref = page && page.icon ? App.files.ref(page.icon) : null;
    if (App.files.isGlyph(ref)) return App.glyph(ref, "pi pi-emoji");
    if (ref && ref.kind === "url") return App.el("img", { class: "pi pi-img", src: ref.url, alt: "", loading: "lazy", draggable: "false" });
    if (!fallback) return null;
    return App.el("span", { class: "pi pi-svg", html: App.icon(page && page.kind === "database" ? "database" : "page", size) });
  }

  /* Every live page below `id` (and `id` itself): what a move must not target. */
  function subtreeIds(id) {
    const out = new Set([id]);
    const stack = [id];
    while (stack.length) {
      for (const c of App.store.children(stack.pop())) {
        if (!out.has(c.id)) { out.add(c.id); stack.push(c.id); }
      }
    }
    return out;
  }

  /* "Move to…": the workspaces' top levels first (the only way to move a page
     to another workspace's top), then pages by search. */
  function movePicker(anchor, pageId, { onMoved } = {}) {
    const page = App.store.page(pageId);
    if (!page) return null;
    const exclude = subtreeIds(pageId);
    const move = (target) => {
      try {
        App.store.movePage(pageId, { parentId: target.id });
        const ws = App.store.workspace(target.workspace_id);
        App.toast(`Moved to ${target.parent_id ? App.ui.titleOf(target) : (ws ? ws.name : "workspace")}`);
        if (onMoved) onMoved(target);
      } catch (e) {
        App.toast(e.message, { kind: "error" });
      }
    };
    const pageItem = (p) => ({
      label: App.ui.titleOf(p),
      description: App.ui.pathOf(p),
      ...(App.files.isGlyph(p.icon) ? { emoji: p.icon } : { icon: p.kind === "database" ? "database" : "page" }),
      disabled: p.id === page.parent_id,
      onSelect: () => move(p),
    });
    const build = (q) => {
      const items = [];
      const f = q.trim().toLowerCase();
      const roots = App.store.workspaces().map((w) => ({ w, root: App.store.rootPage(w.id) }))
        .filter(({ w, root }) => root && !exclude.has(root.id) && (!f || w.name.toLowerCase().includes(f)));
      if (roots.length) {
        items.push({ heading: "Workspaces" });
        for (const { w, root } of roots) {
          items.push({
            label: w.name, description: "Top level", ...(App.files.isGlyph(w.icon) ? { emoji: w.icon } : { icon: "home" }),
            disabled: page.parent_id === root.id, onSelect: () => move(root),
          });
        }
      }
      const pages = (f ? App.store.search(q, 40).map((r) => r.page) : App.store.recent(20))
        .filter((p) => p.parent_id && !exclude.has(p.id) && !App.store.isTrashed(p.id));
      if (pages.length) {
        items.push({ heading: f ? "Pages" : "Recent pages" });
        pages.forEach((p) => items.push(pageItem(p)));
      }
      return items;
    };
    const h = App.ui.menu(anchor, build(""), { filter: true, placeholder: "Move page to…", className: "page-picker", emptyText: "No matching pages" });
    const input = h.el.querySelector(".menu-filter");
    input.addEventListener("input", () => h.setItems(build(input.value)), true);
    return h;
  }

  return {
    init, main, showState, attachResizer, sidebarButton, toggleSidebar, openDrawer, closeDrawer, setCollapsed, isNarrow,
    focusPages, focusPage,
    syncButton, showParked, markSynced, whenSynced, isSynced: () => synced, signIn,
    copy, absoluteUrl, pageIcon, subtreeIds, movePicker, isEditable,
  };
})();

/* Navigation for the signed-in app: /p/<page id>, with an optional
   #<block id> for a link to a place in the page. */
App.nav = (() => {
  let current = null;
  const PAGE_RE = /^\/p\/([0-9a-zA-Z-]{8,64})\/?$/;

  function parse(pathname, hash = "") {
    const m = PAGE_RE.exec(pathname || "");
    if (!m) return null;
    const blockId = (hash || "").replace(/^#/, "") || null;
    return { pageId: m[1], blockId };
  }

  const pageHref = (id, blockId) => `/p/${encodeURIComponent(id)}${blockId ? `#${encodeURIComponent(blockId)}` : ""}`;

  /* Open a page. `replace` rewrites the current history entry (redirects,
     fixing up "/"); `fresh` means it was just created, so the title gets the
     focus. */
  function openPage(id, { blockId = null, replace = false, fresh = false } = {}) {
    if (!id) return;
    const href = pageHref(id, blockId);
    const same = current === id;
    if (location.pathname + location.hash !== href) {
      if (replace) history.replaceState({ pageId: id, blockId }, "", href);
      else history.pushState({ pageId: id, blockId }, "", href);
    }
    show(id, { blockId, fresh, same });
  }

  function show(id, { blockId = null, fresh = false, same = false } = {}) {
    current = id;
    const page = App.store.page(id);
    if (page && !App.store.isTrashed(id)) App.local.set("lastPage", id);
    if (App.sidebar) App.sidebar.setActive(id);
    if (same && App.page.current() === id) {
      if (blockId) App.page.scrollToBlock(blockId);
    } else {
      App.page.show(id, { blockId, fresh });
    }
    if (App.shell.isNarrow()) App.shell.closeDrawer();
    App.bus.emit("nav:change", { pageId: id });
  }

  /* Where "/" and "/app" land: the last page visited on this device if it is
     still around, else the current workspace's home. */
  function homeId() {
    const last = App.local.get("lastPage");
    if (last && App.store.page(last) && !App.store.isTrashed(last)) return last;
    const wsId = App.local.get("workspace");
    const ws = (wsId && App.store.workspace(wsId) && !App.store.workspace(wsId).deleted) ? App.store.workspace(wsId) : App.store.workspaces()[0];
    const root = ws ? App.store.rootPage(ws.id) : null;
    return root ? root.id : null;
  }

  /* Render whatever the address bar says. */
  function route() {
    const hit = parse(location.pathname, location.hash);
    if (hit) { show(hit.pageId, { blockId: hit.blockId }); return true; }
    const id = homeId();
    if (id) { openPage(id, { replace: true }); return true; }
    return false;
  }

  window.addEventListener("popstate", () => route());

  /* A new page at the top of the current workspace (Ctrl+Alt+N), or under
     `parentId`. A database starts from `schema` (a preset such as
     App.database.ganttSchema()) or else the default one. */
  function newPage({ parentId = null, kind = "page", schema = null } = {}) {
    let parent = parentId;
    if (!parent) {
      const wsId = App.sidebar ? App.sidebar.workspaceId() : null;
      const root = wsId ? App.store.rootPage(wsId) : null;
      parent = root ? root.id : null;
    }
    if (!parent) return null;
    const extra = kind === "database" && App.database ? { kind: "database", schema: schema || App.database.defaultSchema() } : {};
    const page = App.store.createPage({ parentId: parent, title: "", ...extra });
    if (App.sidebar) App.sidebar.expand(parent);
    openPage(page.id, { fresh: true });
    return page;
  }

  return { openPage, pageHref, current: () => current, parse, route, homeId, newPage };
})();
