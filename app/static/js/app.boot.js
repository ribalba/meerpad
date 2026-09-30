/* Boot: who is signed in, open their local copy, show it, then sync.

   Local first: the pages on screen come from IndexedDB, so the app opens (and
   works) with no connection at all once it has synced on this device before.
   That is why the user id is remembered in App.local: offline, /api/auth/me
   cannot say who this is, and the local database is named after them. */

window.App = window.App || {};

(async function boot() {
  const bootEl = document.getElementById("boot");
  const bootText = document.getElementById("boot-text");
  const say = (text) => { if (bootText) bootText.textContent = text; };

  function toLogin() {
    const next = location.pathname + location.search + location.hash;
    location.replace(`/login?next=${encodeURIComponent(next)}`);
  }

  // --- 1. who -------------------------------------------------------------------------
  // fetch() rather than App.api: a 401 here is the normal signed-out case, not
  // a lost session worth a toast.
  let me = null;
  const remembered = App.local.get("me");
  if (navigator.onLine) {
    try {
      const resp = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
      if (resp.status === 401) { toLogin(); return; }
      if (resp.ok) {
        me = await resp.json();
        App.local.set("me", { id: me.id, email: me.email, name: me.name || null });
      }
    } catch (e) { /* the network is lying about being online */ }
  }
  if (!me && remembered && remembered.id) me = remembered;
  if (!me) {
    if (navigator.onLine) { toLogin(); return; }
    say("You are offline. Connect to the internet once to sign in on this device.");
    window.addEventListener("online", () => location.reload(), { once: true });
    return;
  }
  App.me = me;

  // --- 2. the local copy -------------------------------------------------------------------
  let memoryOnly = false;
  try {
    await App.db.open(`meerpad-${me.id}`);
    await App.db.getMeta("cursor", 0); // proves the database really opened
  } catch (e) {
    // A private window can refuse IndexedDB; the app still works, just
    // without an offline copy.
    console.warn("IndexedDB unavailable, keeping pages in memory", e);
    App.db.useMemory();
    memoryOnly = true;
  }
  await App.sync.init();
  await App.store.load();
  App.store.configure({ mode: "owner", me, readOnly: false });

  // --- 3. the app ------------------------------------------------------------------------------
  App.shell.init({ mode: "owner" });
  App.sidebar.init(document.getElementById("sidebar"), { mode: "owner" });
  document.getElementById("app").hidden = false;
  if (bootEl) bootEl.remove();

  const hadPages = App.store.workspaces().length > 0;
  if (hadPages) App.nav.route();
  else App.shell.showState({ spinner: true, title: "Loading your pages…", text: "This takes a moment the first time on a new device." });
  // Keyboard first: the page list has the focus from the start (arrows move,
  // Enter opens the page, Escape comes back). Not on a phone, where it would
  // mean opening the drawer over the page.
  if (!App.shell.isNarrow()) requestAnimationFrame(() => App.shell.focusPages());
  if (memoryOnly) App.toast("This browser is not keeping an offline copy (private window?). Everything still syncs.", { duration: 7000 });

  // --- 4. sync -----------------------------------------------------------------------------------
  // start() begins the loop with a flush of its own; flushing here as well
  // just waits for that one (plus a quick second pull) so we know when the
  // first pull is in.
  App.sync.start();
  const first = await App.sync.flush();
  App.shell.markSynced();
  if (!hadPages) {
    if (App.store.workspaces().length) {
      App.sidebar.render();
      App.nav.route();
      if (!App.shell.isNarrow()) requestAnimationFrame(() => App.shell.focusPages());
    } else if (!first.ok) {
      App.shell.showState({
        icon: "cloud-off", title: "Could not load your pages",
        text: navigator.onLine ? "The server did not answer. meerpad will keep trying." : "You are offline. Your pages will load as soon as you are back online.",
        actions: [{ label: "Try again", primary: true, run: () => App.sync.flush() }],
      });
      // The first page to arrive (from the retry or the regular loop) opens.
      const off = App.bus.on("store:change", () => {
        if (!App.store.workspaces().length) return;
        off();
        App.nav.route();
      });
    } else {
      App.shell.showState({
        emoji: "🌱", title: "No workspaces yet", text: "Create one to start writing.",
        actions: [{
          label: "Create a workspace", primary: true,
          run: () => { const { root } = App.store.createWorkspace({ name: "My workspace" }); App.nav.openPage(root.id); },
        }],
      });
    }
  }

  // --- 5. a first start -------------------------------------------------------------------------------
  // A new account is offered the demo workspace, once (app.welcome.js). Only
  // on the word of a fresh /api/auth/me: the copy of `me` kept for offline
  // starts does not know, and must not ask.
  if (first.ok && me.welcomed_at === null) App.welcome.offer();

  // --- 6. offline shell ------------------------------------------------------------------------------
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.debug("service worker not registered", e));
  }
})().catch((e) => {
  console.error("boot failed", e);
  const t = document.getElementById("boot-text");
  if (t) t.textContent = `meerpad could not start: ${e.message}`;
});
