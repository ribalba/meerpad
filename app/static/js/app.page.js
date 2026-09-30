/* The page view: the topbar (sidebar button, breadcrumbs, sync status, Share,
   Publish, favorite, the "…" menu), the cover and icon, and then either the
   block editor (a normal page or a database row) or the database views (a
   database page).

   The editor is mounted once per page and never remounted for a change to the
   page's own row: a title typed in the editor, an icon picked here or a cover
   synced from another device all update the chrome around it in place. Only a
   change that alters what the editor is (trashed or restored, turned into a
   database row) rebuilds the view.

   The share-link view (app.sharepage.js) uses the same module with mode
   "share": its topbar says who shared the page and whether the link can edit,
   and the owner-only controls are left out. */

window.App = window.App || {};

App.page = (() => {
  let view = null;
  let offChange = null;
  const ctx = { mode: "owner", share: null };  // share: { token, mode, owner_name, signed_in, root_page_id }
  const sites = new Map();                      // page id -> site object | null (published state)
  // The published sites' eight (app/render.py GRADIENTS), in their order.
  const GRADIENT_NAMES = ["Sunrise", "Sky", "Lagoon", "Lavender", "Indigo", "Blossom", "Ocean", "Night"];
  const GRADIENTS = GRADIENT_NAMES.length;

  function configure(opts = {}) { Object.assign(ctx, opts); }
  const isShare = () => ctx.mode === "share";
  const current = () => (view ? view.pageId : null);

  // --- lifecycle ---------------------------------------------------------------------
  function show(pageId, { blockId = null, fresh = false } = {}) {
    destroy();
    view = { pageId, blockId, fresh, state: null, editor: null, db: null, el: {}, sig: {} };
    if (!offChange) offChange = App.bus.on("store:change", onStoreChange);
    build();
  }

  function destroy() {
    if (!view) return;
    try { if (view.editor && view.editor.destroy) view.editor.destroy(); } catch (e) { console.error(e); }
    try { if (view.db && view.db.destroy) view.db.destroy(); } catch (e) { console.error(e); }
    if (view.el.props && view.el.props.destroy) view.el.props.destroy();
    if (view.titleTimer) { clearTimeout(view.titleTimer); view.flushTitle && view.flushTitle(); }
    view = null;
  }

  /* Build the view again for the same page, where the reader was. */
  function rebuild() {
    if (!view) return;
    const pageId = view.pageId;
    const top = view.el.scroll ? view.el.scroll.scrollTop : 0;
    show(pageId);
    if (view && view.el.scroll) view.el.scroll.scrollTop = top;
  }

  function onStoreChange(ch) {
    if (!view) return;
    const id = view.pageId;
    if (view.state !== "ready") {
      if (App.store.page(id) && inScope(id)) rebuild();
      return;
    }
    if (!ch.pages.size && !ch.workspaces.size) return;
    refresh();
  }

  /* A share-link visitor only ever sees the shared tree. */
  function inScope(id) {
    if (!isShare() || !ctx.share) return true;
    const root = ctx.share.root_page_id;
    return id === root || App.store.ancestors(id).some((a) => a.id === root);
  }

  // --- building ---------------------------------------------------------------------------
  function build() {
    const host = App.shell.main();
    const id = view.pageId;
    const page = App.store.page(id);
    if (!page || !inScope(id)) {
      if (!App.shell.isSynced()) {
        view.state = "waiting";
        App.shell.showState({ spinner: true, title: "Loading…", text: "Getting this page from the server." });
        const mine = view;
        App.shell.whenSynced().then(() => { if (view === mine && view.state === "waiting") rebuild(); });
      } else {
        view.state = "missing";
        notFound();
      }
      return;
    }
    view.state = "ready";
    view.kind = page.kind;
    view.trashed = App.store.isTrashed(id);
    view.isRow = App.store.isRow(id);
    view.readOnly = App.store.isReadOnly() || view.trashed;

    const root = App.el("div", { class: "page-view" });
    const topbar = buildTopbar(page);
    const scroll = App.el("div", { class: "page-scroll" });
    const container = App.el("div", { class: "page-container" });
    const head = App.el("div", { class: "page-head" });
    const body = App.el("div", { class: "page-body" });
    Object.assign(view.el, { root, topbar, scroll, container, head, body }); // keeps buildTopbar's references
    root.append(topbar);
    if (App.search && App.search.bar) root.append(App.search.bar());
    const banner = buildBanner(page);
    if (banner) root.append(banner);
    root.append(scroll);
    scroll.append(container);
    container.append(head, body);
    host.replaceChildren(root);

    renderCover(page);
    renderHead(page);
    applyOptions(page);
    if (page.kind === "database") mountDatabase(page, body);
    else mountEditor(page, body);
    document.title = App.ui.titleOf(page);
    if (ctx.mode === "owner") loadSite(id);
  }

  /* Cheap, in-place updates for a change elsewhere in the store. */
  function refresh() {
    const id = view.pageId;
    const page = App.store.page(id);
    if (!page || !inScope(id)) { rebuild(); return; }
    const trashed = App.store.isTrashed(id);
    if (page.kind !== view.kind || trashed !== view.trashed || App.store.isRow(id) !== view.isRow) { rebuild(); return; }
    renderCrumbs(page);
    renderFavorite(page);
    renderCover(page);
    renderHead(page);
    applyOptions(page);
    renderDbTitle(page);
    document.title = App.ui.titleOf(page);
  }

  // --- topbar ------------------------------------------------------------------------------
  function buildTopbar(page) {
    const bar = App.el("header", { class: `topbar${isShare() ? " share-topbar" : ""}` });
    const crumbs = App.el("nav", { class: "crumbs", "aria-label": "Breadcrumbs" });
    const actions = App.el("div", { class: "topbar-actions" });
    bar.append(App.shell.sidebarButton(), crumbs, actions);
    view.el.crumbs = crumbs;
    view.el.actions = actions;
    renderCrumbs(page, crumbs);

    if (isShare()) {
      const s = ctx.share || {};
      actions.append(App.el("span", { class: `badge${s.mode === "edit" ? " badge-accent" : ""}`, text: s.mode === "edit" ? "Can edit" : "View only" }));
      if (s.owner_name) actions.append(App.el("span", { class: "share-owner hide-narrow", text: `Shared by ${s.owner_name}` }));
      if (s.mode === "edit") actions.append(App.shell.syncButton());
      actions.append(s.signed_in
        ? App.el("a", { class: "btn btn-small", href: "/", text: "Open meerpad" })
        : App.el("a", { class: "btn btn-small", href: `/login?next=${encodeURIComponent(location.pathname)}`, text: "Sign in" }));
    } else {
      actions.append(App.shell.syncButton());
      const share = App.el("button", { class: "btn-top", type: "button", title: "Share a link to this page" },
        App.el("span", { class: "btn-label", text: "Share" }));
      share.prepend(App.el("span", { class: "only-narrow", html: App.icon("share", 17) }));
      share.addEventListener("click", () => {
        if (App.share) App.share.open(view.pageId, share);
      });
      const publish = App.el("button", { class: "btn-top btn-publish", type: "button", title: "Publish this page as a website" });
      publish.addEventListener("click", () => {
        if (App.publish) App.publish.open(view.pageId);
      });
      view.el.publish = publish;
      renderPublish();
      const fav = App.el("button", { class: "icon-btn", type: "button", html: App.icon("star", 18) });
      fav.addEventListener("click", () => {
        const p = App.store.page(view.pageId);
        if (!p) return;
        App.store.updatePage(p.id, { favorite: !p.favorite });
        App.toast(p.favorite ? "Removed from Favorites" : "Added to Favorites");
      });
      view.el.fav = fav;
      renderFavorite(page);
      actions.append(share, publish, fav);
    }
    const more = App.el("button", { class: "icon-btn", type: "button", title: "Style, export, and more", "aria-label": "More", html: App.icon("dots", 18) });
    more.addEventListener("click", () => moreMenu(more));
    actions.append(more);
    return bar;
  }

  function renderFavorite(page) {
    const fav = view && view.el.fav;
    if (!fav) return;
    const on = Boolean(page.favorite);
    if (view.sig.fav === on) return;
    view.sig.fav = on;
    fav.classList.toggle("fav-on", on);
    fav.title = on ? "Remove from Favorites" : "Add to Favorites";
    fav.setAttribute("aria-label", fav.title);
    fav.setAttribute("aria-pressed", String(on));
    fav.hidden = view.trashed;
  }

  /* Workspace first, then the page's ancestors, then the page. Long chains
     fold their middle into "…", which lists what it hides. */
  function renderCrumbs(page, box = view && view.el.crumbs) {
    if (!box) return;
    const chain = App.store.ancestors(page.id).reverse();
    const items = [];
    if (isShare()) {
      chain.filter((a) => inScope(a.id)).forEach((a) => items.push({ page: a }));
      items.push({ page, current: true });
    } else {
      const ws = App.store.workspace(page.workspace_id);
      const rootId = page.parent_id ? (chain[0] && chain[0].id) : page.id;
      items.push({ ws, rootId, current: !page.parent_id });
      if (page.parent_id) {
        chain.slice(1).forEach((a) => items.push({ page: a }));
        items.push({ page, current: true });
      }
    }
    const sig = JSON.stringify(items.map((it) => it.ws ? [it.ws.id, it.ws.name, App.store.workspaceIcon(it.ws)] : [it.page.id, it.page.title, it.page.icon]));
    if (view.sig.crumbs === sig) return;
    view.sig.crumbs = sig;

    const make = (it) => {
      if (it.ws !== undefined) {
        const ws = it.ws;
        const label = ws ? ws.name || "Untitled" : "Workspace";
        const icon = App.sidebar && ws ? App.sidebar.workspaceIcon(ws) : null;
        if (icon) icon.classList.add("crumb-ws-icon");
        return App.el(it.current ? "span" : "a", { class: "crumb", href: it.current ? null : App.nav.pageHref(it.rootId), title: label },
          icon, App.el("span", { class: "crumb-text", text: label }));
      }
      const p = it.page;
      const icon = App.shell.pageIcon(p, { fallback: false });
      return App.el(it.current ? "span" : "a", { class: `crumb${it.current ? " crumb-current" : ""}`, href: it.current ? null : App.nav.pageHref(p.id), title: App.ui.titleOf(p) },
        icon ? App.el("span", { class: "crumb-icon" }, icon) : null,
        App.el("span", { class: "crumb-text", text: App.ui.titleOf(p) }));
    };
    let shown = items;
    let hidden = [];
    if (items.length > 4) {
      shown = [items[0], null, ...items.slice(-2)];
      hidden = items.slice(1, -2);
    }
    const nodes = [];
    shown.forEach((it, i) => {
      if (i > 0) nodes.push(App.el("span", { class: "crumb-sep", text: "/" }));
      if (it) { nodes.push(make(it)); return; }
      const btn = App.el("button", { class: "crumb crumb-ellipsis", type: "button", text: "…", title: "Show the full path" });
      btn.addEventListener("click", () => App.ui.menu(btn, hidden.map((h) => ({
        label: App.ui.titleOf(h.page),
        ...(h.page.icon && App.files.ref(h.page.icon).kind === "emoji" ? { emoji: h.page.icon } : { icon: "page" }),
        onSelect: () => App.nav.openPage(h.page.id),
      }))));
      nodes.push(btn);
    });
    box.replaceChildren(...nodes);
  }

  // --- published state ----------------------------------------------------------------------
  async function loadSite(pageId) {
    if (sites.has(pageId) || !navigator.onLine) { renderPublish(); return; }
    try {
      const site = await App.api.get(`/api/pages/${encodeURIComponent(pageId)}/site`);
      sites.set(pageId, site && site.enabled !== false ? site : null);
    } catch (e) {
      if (e.status === 404) sites.set(pageId, null);
    }
    if (view && view.pageId === pageId) renderPublish();
  }

  function renderPublish() {
    const btn = view && view.el.publish;
    if (!btn) return;
    const site = sites.get(view.pageId);
    btn.classList.toggle("published", Boolean(site));
    btn.replaceChildren(
      App.el("span", { html: App.icon("globe", 16) }),
      App.el("span", { class: "btn-label", text: site ? "Published" : "Publish" }));
    if (site) btn.append(App.el("span", { class: "dot" }));
    btn.title = site ? `Published at ${site.custom_url || site.url || "the web"}` : "Publish this page as a website";
    btn.hidden = view.trashed;
  }

  App.bus.on("site:changed", ({ pageId, site } = {}) => {
    if (!pageId) return;
    sites.set(pageId, site && site.enabled !== false ? site : null);
    if (view && view.pageId === pageId) renderPublish();
  });

  // --- the "…" menu --------------------------------------------------------------------------
  function setOption(key, value) {
    const p = App.store.page(view.pageId);
    if (!p) return;
    App.store.updatePage(p.id, { options: { ...(p.options || {}), [key]: value } });
  }

  function moreMenu(anchor) {
    const page = App.store.page(view.pageId);
    if (!page) return;
    const opts = page.options || {};
    const editable = !view.readOnly;
    const items = [];
    if (editable) {
      items.push(
        { label: "Small text", icon: "text", checked: Boolean(opts.small_text), onSelect: () => setOption("small_text", !opts.small_text) },
        { label: "Full width", icon: "expand", checked: Boolean(opts.full_width), onSelect: () => setOption("full_width", !opts.full_width) },
        { divider: true });
    }
    if (page.kind !== "database" && view.editor && view.editor.setMarkdownMode && editable) {
      const on = Boolean(view.editor.isMarkdownMode && view.editor.isMarkdownMode());
      items.push({ label: "Edit as Markdown", icon: "markdown", checked: on, onSelect: () => view.editor.setMarkdownMode(!on) });
    }
    items.push({ label: "Copy link", icon: "link", onSelect: () => App.shell.copy(App.shell.absoluteUrl(App.nav.pageHref(page.id)), "Link copied") });
    if (!isShare() && !view.trashed) {
      items.push(
        { label: "Duplicate", icon: "copy", onSelect: () => { const c = App.store.duplicatePage(page.id); if (c) App.nav.openPage(c.id); } },
        { label: "Move to…", icon: "move", disabled: !page.parent_id, onSelect: () => App.shell.movePicker(anchor, page.id) });
    }
    items.push({ divider: true }, { label: "Export Markdown", icon: "download", onSelect: () => exportMarkdown(page) });
    if (!isShare() && !view.trashed) {
      items.push({ label: "Import from Notion", icon: "import", onSelect: () => App.import && App.import.open({ workspaceId: page.workspace_id, parentPageId: page.id }) });
      if (page.parent_id) {
        items.push({ divider: true }, { label: "Move to trash", icon: "trash", danger: true, onSelect: () => App.sidebar.trashWithUndo(page.id) });
      }
    }
    const h = App.ui.menu(anchor, items, { placement: "bottom-end", className: "page-menu" });
    const wrap = h.el.querySelector(".menu-wrap");
    if (editable) wrap.prepend(fontPicker(opts.font || "sans", h));
    wrap.append(App.el("div", { class: "menu-footer" }, ...lastEdited(page)));
    h.reposition();
  }

  /* Notion's three faces, as tiles at the top of the menu. */
  function fontPicker(currentFont, handle) {
    const fonts = [["sans", "Default"], ["serif", "Serif"], ["mono", "Mono"]];
    return App.el("div", { class: "page-menu-fonts", role: "group", "aria-label": "Font" }, fonts.map(([id, label]) =>
      App.el("button", {
        class: `font-tile font-tile-${id}${currentFont === id ? " active" : ""}`, type: "button", title: `${label} font`,
        onclick: () => { setOption("font", id); handle.close(); },
      }, App.el("span", { class: "font-tile-ag", text: "Ag" }), App.el("span", { class: "font-tile-label", text: label }))));
  }

  function lastEdited(page) {
    const when = App.store.lastEdited(page.id) || page.updated_at;
    const me = App.me || App.store.me() || {};
    let who = page.last_edited_by || "";
    if (who && me.email && who.toLowerCase() === me.email.toLowerCase()) who = "you";
    const out = [App.el("div", { text: `Last edited ${App.fmt.ago(when) || "just now"}${who ? ` by ${who}` : ""}` })];
    if (page.created_at) out.push(App.el("div", { text: `Created ${App.fmt.date(page.created_at)}` }));
    return out;
  }

  /* The server's export when there is one to ask (it matches what the Notion
     importer reads); otherwise the editor's own converter, so a share-link
     visitor and an offline owner can export too. */
  async function exportMarkdown(page) {
    const name = `${App.ui.titleOf(page).replace(/[\\/:*?"<>|\n\r\t]+/g, " ").trim().slice(0, 120) || "page"}.md`;
    let text = null;
    if (!isShare() && navigator.onLine) {
      try { text = await App.api.get(`/api/pages/${encodeURIComponent(page.id)}/markdown`); } catch (e) { text = null; }
    }
    if (text === null && App.mdblocks && App.mdblocks.pageToMarkdown) {
      try { text = App.mdblocks.pageToMarkdown(page.id); } catch (e) { text = null; }
    }
    if (typeof text !== "string") { App.toast("Exporting needs a connection right now. Try again when you are online.", { kind: "error" }); return; }
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = App.el("a", { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // --- trash banner -----------------------------------------------------------------------------
  function buildBanner(page) {
    if (!view.trashed || isShare()) return null;
    const ws = App.store.workspace(page.workspace_id);
    const deletedAncestor = page.deleted ? page : App.store.ancestors(page.id).find((a) => a.deleted);
    const bar = App.el("div", { class: "page-banner", role: "status" });
    if (!deletedAncestor && ws && ws.deleted) {
      bar.append(App.el("span", { text: `This page's workspace "${ws.name}" was deleted.` }),
        App.el("button", { class: "btn btn-small", type: "button", text: "Restore workspace", onclick: () => App.store.updateWorkspace(ws.id, { deleted: false }) }));
      return bar;
    }
    const target = deletedAncestor || page;
    bar.append(App.el("span", {
      text: target.id === page.id ? "This page is in the trash." : `This page is inside "${App.ui.titleOf(target)}", which is in the trash.`,
    }));
    bar.append(App.el("button", {
      class: "btn btn-small", type: "button", text: target.id === page.id ? "Restore page" : "Restore it",
      onclick: () => { App.store.restorePage(target.id); App.toast("Restored"); },
    }));
    bar.append(App.el("button", {
      class: "btn btn-small", type: "button", text: "Delete forever",
      onclick: () => purge(target),
    }));
    return bar;
  }

  async function purge(target) {
    const ok = await App.ui.confirm(`"${App.ui.titleOf(target)}" and every page inside it will be deleted for good. This cannot be undone.`, {
      title: "Delete forever?", confirmLabel: "Delete forever", danger: true,
    });
    if (!ok) return;
    const parentId = target.parent_id;
    try {
      await App.sync.flush(); // the server only purges what it knows is in the trash
      await App.store.purgePage(target.id);
      App.toast("Deleted forever");
      const next = parentId && App.store.page(parentId) && !App.store.isTrashed(parentId) ? parentId : App.nav.homeId();
      if (next) App.nav.openPage(next, { replace: true });
    } catch (e) {
      App.toast(e.status === 409 ? "The trash has not synced yet. Try again in a moment." : `Could not delete: ${e.message}`, { kind: "error" });
    }
  }

  // --- cover ------------------------------------------------------------------------------------
  function renderCover(page) {
    const sig = `${page.cover || ""}|${view.readOnly}`;
    if (view.sig.cover === sig) return;
    view.sig.cover = sig;
    if (view.el.cover) { view.el.cover.remove(); view.el.cover = null; }
    view.el.root.classList.toggle("has-cover", Boolean(page.cover));
    if (!page.cover) return;
    const ref = App.files.ref(page.cover);
    const cover = App.el("div", { class: `page-cover${ref.kind === "gradient" ? ` gradient-${Math.abs(ref.n) % GRADIENTS}` : ""}` });
    if (ref.kind === "url") cover.append(App.el("img", { src: ref.url, alt: "", draggable: "false" }));
    if (!view.readOnly) {
      const change = App.el("button", { type: "button", text: "Change cover" });
      change.addEventListener("click", () => coverPicker(change));
      cover.append(App.el("div", { class: "cover-actions" }, change,
        App.el("button", { type: "button", text: "Remove", onclick: () => App.store.updatePage(view.pageId, { cover: null }) })));
    }
    view.el.cover = cover;
    view.el.scroll.prepend(cover);
  }

  /* Change cover: the eight gradients, an uploaded image, or a link. */
  function coverPicker(anchor) {
    const pageId = view.pageId;
    const set = (cover) => { App.store.updatePage(pageId, { cover }); h.close(); };
    const body = App.el("div", { class: "cover-body" });
    const tabs = App.el("div", { class: "cover-tabs" });
    const panes = {
      gallery: () => App.el("div", { class: "cover-grid" }, GRADIENT_NAMES.map((name, n) =>
        App.el("button", { class: `cover-swatch gradient-${n}`, type: "button", title: name, "aria-label": `${name} gradient`, onclick: () => set(`gradient:${n}`) }))),
      upload: () => {
        const input = App.el("input", { type: "file", accept: "image/*", hidden: true });
        const status = App.el("div", { class: "field-help" }, "Wide images (1500 pixels or more) look best.");
        const btn = App.el("button", { class: "btn btn-primary btn-block", type: "button", html: `${App.icon("upload")}<span>Upload an image</span>`, onclick: () => input.click() });
        input.addEventListener("change", async () => {
          const file = input.files[0];
          if (!file) return;
          btn.disabled = true;
          status.textContent = "Uploading…";
          try {
            const res = await App.files.upload(file, { pageId, onProgress: (f) => { status.textContent = `Uploading… ${Math.round(f * 100)}%`; } });
            set(`file:${res.id}`);
          } catch (e) {
            btn.disabled = false;
            status.textContent = e.message;
            status.className = "field-error";
          }
        });
        return App.el("div", { class: "field" }, btn, input, status);
      },
      link: () => {
        const input = App.el("input", { class: "input", type: "url", placeholder: "Paste an image link…" });
        const err = App.el("div", { class: "field-error", hidden: true });
        const submit = () => {
          const v = input.value.trim();
          if (!/^https?:\/\/\S+$/i.test(v)) { err.textContent = "That does not look like a web address (https://…)."; err.hidden = false; return; }
          set(v);
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
        setTimeout(() => input.focus(), 0);
        return App.el("div", {}, App.el("div", { class: "field" }, input, err),
          App.el("div", { class: "btn-row end" }, App.el("button", { class: "btn btn-primary btn-small", type: "button", text: "Use this image", onclick: submit })));
      },
    };
    const labels = { gallery: "Gallery", upload: "Upload", link: "Link" };
    const pick = (name) => {
      tabs.querySelectorAll("button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
      body.replaceChildren(panes[name]());
    };
    Object.keys(panes).forEach((name) => tabs.append(App.el("button", { type: "button", dataset: { tab: name }, text: labels[name], onclick: () => pick(name) })));
    tabs.append(App.el("span", { class: "grow" }), App.el("button", { type: "button", text: "Remove", onclick: () => set(null) }));
    pick("gallery");
    const h = App.ui.popover(anchor, App.el("div", {}, tabs, body), { className: "cover-picker", placement: "bottom-end" });
  }

  // --- icon and the hover controls ------------------------------------------------------------------
  function renderHead(page) {
    const sig = `${page.icon || ""}|${page.cover ? 1 : 0}|${view.readOnly}`;
    if (view.sig.head === sig) return;
    view.sig.head = sig;
    const head = view.el.head;
    head.replaceChildren();
    view.el.root.classList.toggle("has-icon", Boolean(page.icon));
    if (page.icon) {
      const ref = App.files.ref(page.icon);
      const btn = App.el("button", { class: "page-icon", type: "button", title: view.readOnly ? "" : "Change icon", disabled: view.readOnly || null });
      if (ref.kind === "url") btn.append(App.el("img", { src: ref.url, alt: "" }));
      else btn.textContent = ref.text || page.icon;
      if (!view.readOnly) btn.addEventListener("click", () => pickIcon(btn));
      head.append(btn);
    }
    if (view.readOnly) return;
    const controls = App.el("div", { class: `page-controls${view.fresh ? " show" : ""}` });
    if (!page.icon) {
      const add = App.el("button", { class: "link-btn", type: "button", html: `${App.icon("smile")}<span>Add icon</span>` });
      add.addEventListener("click", () => pickIcon(add));
      controls.append(add);
    }
    if (!page.cover) {
      controls.append(App.el("button", {
        class: "link-btn", type: "button", html: `${App.icon("image")}<span>Add cover</span>`,
        onclick: () => App.store.updatePage(view.pageId, { cover: `gradient:${Math.floor(Math.random() * GRADIENTS)}` }),
      }));
    }
    if (controls.childNodes.length) head.append(controls);
  }

  function pickIcon(anchor) {
    const pageId = view.pageId;
    const page = App.store.page(pageId);
    App.ui.emojiPicker(anchor, {
      onPick: (emoji) => App.store.updatePage(pageId, { icon: emoji }),
      onRemove: page && page.icon ? () => App.store.updatePage(pageId, { icon: null }) : undefined,
      onUpload: async (file) => {
        try {
          const res = await App.files.upload(file, { pageId });
          App.store.updatePage(pageId, { icon: `file:${res.id}` });
        } catch (e) {
          App.toast(e.message, { kind: "error" });
        }
      },
    });
  }

  function applyOptions(page) {
    const o = page.options || {};
    const c = view.el.container;
    c.classList.toggle("page-full-width", Boolean(o.full_width));
    c.classList.toggle("font-serif", o.font === "serif");
    c.classList.toggle("font-mono", o.font === "mono");
    c.classList.toggle("small-text", Boolean(o.small_text));
    c.classList.toggle("page-database", page.kind === "database");
  }

  // --- content --------------------------------------------------------------------------------------
  function mountEditor(page, body) {
    const host = App.el("div", { class: "page-editor" });
    body.append(host);
    const header = view.isRow && App.database && App.database.propertiesPanel
      ? App.database.propertiesPanel(page.id, { readOnly: view.readOnly })
      : null;
    view.el.props = header;
    if (App.editor && App.editor.mount) {
      try {
        view.editor = App.editor.mount(host, { pageId: page.id, readOnly: view.readOnly, header, autofocus: Boolean(view.fresh) });
      } catch (e) {
        console.error("editor failed to mount", e);
        view.editor = null;
      }
    }
    if (!view.editor) fallbackContent(page, host, header);
    // (A fresh page's title gets the focus from the editor's own autofocus.)
    const blockId = view.blockId;
    if (view.editor && blockId) setTimeout(() => scrollToBlock(blockId), 30);
  }

  /* Without the editor (a failed script load): the page's text, read-only,
     rather than nothing. */
  function fallbackContent(page, host, header) {
    host.classList.add("editor-missing");
    host.append(App.el("h1", { class: "fallback-title", text: App.ui.titleOf(page) }));
    if (header) host.append(header);
    const walk = (nodes, depth) => nodes.forEach((n) => {
      if (n.block.text) host.append(App.el("p", { style: depth ? `margin-left:${depth * 1.5}em` : null, text: n.block.text }));
      walk(n.children, depth + 1);
    });
    walk(App.store.blockTree(page.id), 0);
    if (!App.store.blocks(page.id).length) host.append(App.el("p", { class: "muted", text: "This page is empty." }));
  }

  function mountDatabase(page, body) {
    const title = App.el("h1", { class: "db-page-title", "data-placeholder": "Untitled", spellcheck: "true" });
    title.textContent = page.title || "";
    view.sig.dbTitle = page.title || "";
    if (!view.readOnly) {
      title.contentEditable = "plaintext-only";
      // Older engines without plaintext-only fall back to true plus the paste
      // handler below, which keeps pasted formatting out.
      if (title.contentEditable !== "plaintext-only") title.contentEditable = "true";
      const pageId = page.id;
      const save = () => {
        if (!view || view.pageId !== pageId) return;
        view.titleTimer = null;
        const value = title.textContent.replace(/\s+/g, " ").trim();
        view.sig.dbTitle = value;
        if (value !== (App.store.page(pageId) || {}).title) App.store.updatePage(pageId, { title: value });
      };
      view.flushTitle = save;
      title.addEventListener("input", () => { clearTimeout(view.titleTimer); view.titleTimer = setTimeout(save, 350); });
      title.addEventListener("blur", () => { clearTimeout(view.titleTimer); save(); });
      title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } });
      title.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = (e.clipboardData.getData("text/plain") || "").replace(/\s+/g, " ");
        document.execCommand("insertText", false, text);
      });
    }
    view.el.dbTitle = title;
    const host = App.el("div", { class: "page-db" });
    body.append(title, host);
    if (App.database && App.database.mount) {
      try { view.db = App.database.mount(host, { pageId: page.id, readOnly: view.readOnly }); } catch (e) { console.error("database view failed", e); }
    }
    if (!view.db) host.append(App.el("p", { class: "muted", text: "The database view could not be loaded." }));
    if (view.fresh && !view.readOnly) setTimeout(() => title.focus(), 0);
  }

  function renderDbTitle(page) {
    const t = view.el.dbTitle;
    if (!t || document.activeElement === t) return;
    const value = page.title || "";
    if (view.sig.dbTitle === value) return;
    view.sig.dbTitle = value;
    t.textContent = value;
  }

  function scrollToBlock(blockId) {
    if (view && view.editor && view.editor.scrollToBlock) view.editor.scrollToBlock(blockId);
  }

  // --- not found ------------------------------------------------------------------------------------
  function notFound() {
    document.title = "Page not found";
    if (isShare()) {
      App.shell.showState({
        icon: "search", title: "This page is not part of the shared page",
        text: "It may have been moved or deleted, or it lives outside what this link shares.",
        actions: [{ label: "Back to the shared page", primary: true, run: () => App.nav.openPage(ctx.share.root_page_id) }],
      });
      return;
    }
    App.shell.showState({
      icon: "search", title: "Page not found",
      text: "It may have been deleted for good, or it belongs to a different account.",
      actions: [{ label: "Go to your workspace", primary: true, run: () => { const id = App.nav.homeId(); if (id) App.nav.openPage(id, { replace: true }); } }],
    });
  }

  return {
    configure, show, current, destroy, scrollToBlock,
    editor: () => (view ? view.editor : null),
    site: (pageId) => sites.get(pageId),
  };
})();
