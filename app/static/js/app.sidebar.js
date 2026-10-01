/* The sidebar, laid out like every meer* app (meerpic's, meercal's, meerail's):
   the brand and a few icon buttons on top, one big blue action ("New page",
   meercal's "Create"), then sections with small capital headings (Favorites,
   Workspaces, the current workspace's pages, Library), and the keyboard
   shortcuts folded at the foot with the version under them.

   The tree is rebuilt from the store on every page or workspace change (one
   rebuild per animation frame at most): a few hundred rows cost less than
   keeping a second, incremental copy of the tree in step with sync. What is
   not in the store is kept here: which rows are expanded (per browser, in
   App.local) and which workspace is showing.

   The share-link view uses the same module with mode "share": the tree is the
   shared page and what is below it, with no workspaces, favorites or trash. */

window.App = window.App || {};

App.sidebar = (() => {
  let el = null;
  let mode = "owner";          // "owner" | "share"
  let shareRootId = null;
  let readOnly = false;
  let wsId = null;
  let activeId = null;
  let busy = null;             // "rename" | "drag": rebuilding now would pull the rug
  let dirty = false;
  let scheduled = false;
  let revealPending = false;
  let dragId = null;
  const expanded = new Set(App.local.get("sidebar.expanded", []));

  function init(host, opts = {}) {
    el = host;
    mode = opts.mode || "owner";
    shareRootId = opts.shareRootId || null;
    readOnly = Boolean(opts.readOnly);
    if (mode === "owner") {
      const saved = App.local.get("workspace");
      wsId = saved && liveWorkspace(saved) ? saved : null;
    } else if (shareRootId) {
      expanded.add(shareRootId);
    }
    App.bus.on("store:change", (ch) => { if (ch.pages.size || ch.workspaces.size) schedule(); });
    el.addEventListener("keydown", onKeyDown);
    render();
    if (App.shell && App.shell.attachResizer) App.shell.attachResizer(el);
  }

  const liveWorkspace = (id) => { const w = App.store.workspace(id); return w && !w.deleted ? w : null; };

  function currentWorkspace() {
    let w = wsId ? liveWorkspace(wsId) : null;
    if (!w) {
      w = App.store.workspaces()[0] || null;
      wsId = w ? w.id : null;
    }
    return w;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (busy) { dirty = true; return; }
      render();
    });
  }

  function settle() {
    busy = null;
    if (dirty) { dirty = false; render(); }
  }

  const saveExpanded = () => App.local.set("sidebar.expanded", [...expanded].slice(-500));

  // --- public: which page and workspace -------------------------------------------------
  function setWorkspace(id) {
    if (!liveWorkspace(id)) return;
    if (id !== wsId) {
      wsId = id;
      App.local.set("workspace", id);
      App.bus.emit("workspace:change", { workspaceId: id });
    }
    schedule();
  }

  /* The opened page: highlighted, its ancestors expanded, scrolled into view,
     and its workspace shown (the sidebar follows the page, not the other way
     round). */
  function setActive(pageId) {
    activeId = pageId;
    const page = App.store.page(pageId);
    if (page) {
      if (mode === "owner" && page.workspace_id !== wsId && liveWorkspace(page.workspace_id)) {
        wsId = page.workspace_id;
        App.local.set("workspace", wsId);
        App.bus.emit("workspace:change", { workspaceId: wsId });
      }
      let changed = false;
      for (const a of App.store.ancestors(pageId)) {
        if (a.parent_id && !expanded.has(a.id)) { expanded.add(a.id); changed = true; }
        if (mode === "share" && a.id === shareRootId && !expanded.has(a.id)) { expanded.add(a.id); changed = true; }
      }
      if (changed) saveExpanded();
    }
    revealPending = true;
    schedule();
  }

  function expand(pageId) {
    if (!expanded.has(pageId)) { expanded.add(pageId); saveExpanded(); schedule(); }
  }

  // --- rendering ------------------------------------------------------------------------
  function render() {
    if (!el) return;
    const scroller = el.querySelector(".sb-scroll");
    const scrollTop = scroller ? scroller.scrollTop : 0;
    const resizer = el.querySelector(".sb-resizer");
    // The list is rebuilt on every change (a sync every few seconds): a row
    // that had the keyboard gets it back, found again by its key.
    const had = el.contains(document.activeElement) && document.activeElement.dataset
      ? document.activeElement.dataset.key : null;
    const parts = mode === "owner" ? ownerParts() : shareParts();
    el.replaceChildren(...parts);
    if (resizer) el.append(resizer);
    const sc = el.querySelector(".sb-scroll");
    if (sc) sc.scrollTop = scrollTop;
    if (had) {
      const again = el.querySelector(`[data-key="${CSS.escape(had)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
    if (revealPending) {
      revealPending = false;
      const row = el.querySelector(".tree-row.active");
      if (row) row.scrollIntoView({ block: "nearest" });
    }
  }

  function ownerParts() {
    const ws = currentWorkspace();
    const root = ws ? App.store.rootPage(ws.id) : null;
    const top = toolbar();
    const create = App.el("div", { class: "sb-create" },
      App.el("button", {
        class: "create-btn", type: "button", title: `New page (${key("Alt+N")})`, disabled: !root,
        onclick: () => root && App.nav.newPage({ parentId: root.id }),
      }, App.el("span", { html: App.icon("plus", 18) }), App.el("span", { text: "New page" })));

    const tree = App.el("nav", { class: "nav-tree sb-scroll", "aria-label": "Pages" });
    const favs = App.store.favorites();
    if (favs.length) {
      tree.append(section("Favorites"));
      favs.forEach((p) => tree.append(node(p, 0, "fav:", !readOnly)));
    }
    tree.append(workspacesSection(ws));
    if (ws && root) tree.append(...workspaceSection(ws, root));
    else tree.append(App.el("div", { class: "nav-empty", text: "No workspace yet" }));
    tree.append(section("Library"),
      navRow("import", "Import from Notion", () => App.import && App.import.open({ workspaceId: ws && ws.id, parentPageId: root && root.id }), null, { key: "lib:import" }),
      navRow("trash", "Trash", () => App.trash && App.trash.open(), App.store.trash().length || null, { key: "lib:trash" }));
    return [top, create, tree, shortcutBox()];
  }

  function shareParts() {
    const root = App.store.page(shareRootId);
    const tree = App.el("nav", { class: "nav-tree sb-scroll", "aria-label": "Pages" });
    if (root) tree.append(section("Shared with you"), node(root, 0, "", !readOnly, { isShareRoot: true }));
    return [toolbar(), tree, shortcutBox()];
  }

  /* The top row: brand, then sync, search and settings, then the button that
     folds the sidebar away. */
  function toolbar() {
    const brand = mode === "owner"
      ? App.el("span", { class: "brand" }, App.el("img", { class: "brand-logo", src: "/static/img/logo.png", alt: "" }), "meerpad")
      : App.el("a", { class: "brand", href: "/", title: "meerpad" }, App.el("img", { class: "brand-logo", src: "/static/img/logo.png", alt: "" }), "meerpad");
    // meerpic's two rows: the brand with the sync button, then the quieter
    // tools right-aligned under it.
    const bar = App.el("div", { class: "sidebar-toolbar" }, brand);
    if (mode === "owner" || !readOnly) bar.append(syncIconButton());
    const tools = App.el("div", { class: "sidebar-tools" }, App.el("button", {
      class: "icon-btn", type: "button", title: `Search (${key("K")})`, "aria-label": "Search",
      html: App.icon("search", 17),
      // Keeps the focus in a search bar that is showing, so the click hides
      // it rather than the bar hiding itself on blur and this showing it again.
      onmousedown: (e) => e.preventDefault(),
      onclick: () => App.search && App.search.toggle(),
    }));
    if (mode === "owner") {
      tools.append(App.el("button", {
        class: "icon-btn", type: "button", title: "Settings", "aria-label": "Settings",
        html: App.icon("settings", 17), onclick: () => App.settings && App.settings.open(),
      }));
    }
    tools.append(App.el("button", {
      class: "icon-btn sb-collapse", type: "button", title: `Hide sidebar (${key("\\")})`, "aria-label": "Hide sidebar",
      html: App.icon("sidebar", 17), onclick: () => App.shell.toggleSidebar(),
    }));
    const frag = document.createDocumentFragment();
    frag.append(bar, tools);
    return frag;
  }

  // meerpic's sync button: the glyph turns while a sync runs. Kept across
  // renders, so a spin in progress does not restart on every rebuild.
  let syncBtn = null;
  function syncIconButton() {
    if (!syncBtn) {
      // A sync usually takes a few milliseconds, far too short to see, so a
      // click always turns the glyph at least once. And it only ever stops on a
      // whole turn (animationiteration), never snapping back from an angle.
      let busy = false;
      let clickedAt = 0;
      const wanted = () => busy || Date.now() - clickedAt < 1000;
      const settle = () => { if (!wanted()) syncBtn.classList.remove("spin"); };
      syncBtn = App.el("button", {
        class: "icon-btn", id: "btn-sync", type: "button", title: "Sync now", "aria-label": "Sync now",
        html: App.icon("refresh", 17),
        onclick: async () => {
          clickedAt = Date.now();
          syncBtn.classList.add("spin");
          const r = await App.sync.flush();
          if (r && r.ok === false && !r.busy) {
            App.toast(navigator.onLine
              ? "Could not reach the server. Your changes are kept and sync later."
              : "You are offline. Your changes sync when you are back online.", { kind: "warning" });
          } else if (r && r.parked) {
            App.toast(`${r.parked} ${r.parked === 1 ? "change" : "changes"} could not sync. Click the status to see why.`, { kind: "warning" });
          }
        },
      });
      syncBtn.addEventListener("animationiteration", settle);
      // The background syncs every few seconds stay still, unless one takes
      // long enough (a big pull) to be worth showing.
      let slow = null;
      App.bus.on("sync:status", (st) => {
        busy = Boolean(st.busy);
        clearTimeout(slow);
        if (busy) slow = setTimeout(() => { if (busy) syncBtn.classList.add("spin"); }, 400);
      });
    }
    return syncBtn;
  }

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const key = (k) => `${isMac ? "⌘" : "Ctrl+"}${k}`;

  /* A small-capitals heading, with an optional link-style control on the right
     (meerpic's "Refresh from iCloud"). */
  function section(label, link = null) {
    const head = App.el("div", { class: "tree-section" }, App.el("span", { class: "tree-section-label", text: label }));
    if (link) head.append(App.el("button", { class: "tree-link", type: "button", text: link.label, title: link.title || link.label, onclick: link.run }));
    return head;
  }

  /* One line in a list: icon, name, and a count on the right. */
  function navRow(icon, label, run, count = null, { active = false, iconEl = null, key = null } = {}) {
    return App.el("button", { class: `nav-row${active ? " active" : ""}`, type: "button", onclick: run, dataset: key ? { key } : null },
      iconEl || App.el("span", { class: "nav-icon", html: App.icon(icon, 16) }),
      App.el("span", { class: "nav-name", text: label }),
      count !== null && count !== undefined ? App.el("span", { class: "nav-count", text: String(count) }) : null);
  }

  // A workspace's colour dot when it has no emoji: meerail's account dots and
  // meercal's calendar dots, picked from the name so it never changes.
  const DOTS = ["#1d6ff2", "#e8590c", "#2f9e44", "#ae3ec9", "#d6336c", "#0c8599", "#f59f00", "#5c7cfa"];
  function dotColor(name) {
    let h = 0;
    for (const ch of String(name || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return DOTS[h % DOTS.length];
  }

  function workspacesSection(current) {
    const frag = document.createDocumentFragment();
    frag.append(section("Workspaces", { label: "New", title: "New workspace", run: newWorkspace }));
    const counts = App.store.pageCounts();
    for (const w of App.store.workspaces()) {
      const icon = App.store.workspaceIcon(w);
      const ref = icon ? App.files.ref(icon) : null;
      const iconEl = App.files.isGlyph(ref)
        ? App.el("span", { class: "nav-icon nav-emoji" }, App.glyph(ref))
        : ref && ref.kind === "url"
          ? App.el("span", { class: "nav-icon nav-img" }, App.el("img", { src: ref.url, alt: "", referrerpolicy: "no-referrer" }))
          : App.el("span", { class: "nav-icon" }, App.el("span", { class: "ws-dot", style: `background: ${dotColor(w.name)}` }));
      const row = navRow(null, w.name || "Untitled", () => openWorkspace(w.id), counts[w.id] || 0,
        { active: current && w.id === current.id, iconEl, key: `ws:${w.id}` });
      row.title = `Open ${w.name || "the workspace"}`;
      frag.append(row);
    }
    return frag;
  }

  /* The keyboard sheet at the foot, as in every meer* app: folded to its
     heading with a click (remembered), the first rows shown and "N more" for
     the rest, the version underneath. */
  const SHORTCUTS = [
    [key("K"), "Search"],
    [key("S"), "Save now"],
    ["↑ ↓", "Move in the page list"],
    ["Enter", "Open the page"],
    ["Esc", "Back to the page list"],
    ["→ ←", "Open, close a branch"],
    ["/", "Insert a block"],
    ["[[", "Link to a page"],
    // A browser keeps Ctrl/Cmd+N for itself; only the desktop app gets it.
    [key(window.meerpadDesktop ? "N" : "Alt+N"), "New page"],
    [key("Z"), "Undo"],
    ["Space", "Show the page, stay in the list"],
    ["Shift+↑ ↓", "Select blocks"],
    [key("\\"), "Hide the sidebar"],
    ["Tab", "Indent the block"],
    [key("B"), "Bold"],
    [key("I"), "Italic"],
    [key("E"), "Inline code"],
    [key("Shift+H"), "Highlight"],
    [key("K"), "Link (text selected)"],
    [key("D"), "Duplicate the block"],
    ["Shift+Enter", "Line break"],
    ["# ", "Heading"],
    ["- ", "Bulleted list"],
    ["[] ", "To-do"],
    ["```", "Code block"],
  ];
  let version = App.local.get("version", "");
  function shortcutBox() {
    const box = App.el("div", { class: `shortcut-box${App.local.get("shortcuts.collapsed", false) ? " collapsed" : ""}` });
    const head = App.el("button", { class: "shortcut-head", type: "button", title: "Show or hide the shortcuts" },
      App.el("span", { text: "Shortcuts" }),
      App.el("span", { class: "shortcut-glyph", html: App.icon("chevron-down", 13) }));
    head.addEventListener("click", () => {
      const on = !box.classList.contains("collapsed");
      box.classList.toggle("collapsed", on);
      App.local.set("shortcuts.collapsed", on);
    });
    const body = App.el("div", { class: "shortcut-body" });
    const rows = mode === "owner" ? SHORTCUTS : SHORTCUTS.filter(([, what]) => what !== "New page");
    rows.forEach(([k, what]) => body.append(App.el("div", { class: "shortcut-row" }, App.el("kbd", { text: k }), App.el("span", { text: what }))));
    const hiddenCount = Math.max(0, rows.length - 9);
    if (hiddenCount) {
      const more = App.el("button", { class: "shortcut-more", type: "button", text: `${hiddenCount} more` });
      more.addEventListener("click", () => {
        const open = box.classList.toggle("open");
        more.textContent = open ? "Fewer" : `${hiddenCount} more`;
      });
      body.append(more);
    }
    const ver = App.el("div", { class: "version-line", text: version ? `meerpad ${version}` : "meerpad" });
    body.append(ver);
    if (!version) {
      App.api.get("/api/version").then((v) => {
        version = v.version;
        App.local.set("version", version);
        ver.textContent = `meerpad ${version}`;
      }).catch(() => {});
    }
    box.append(head, body);
    return box;
  }

  function workspaceIcon(ws) {
    const icon = App.store.workspaceIcon(ws);
    if (icon) {
      const ref = App.files.ref(icon);
      if (ref.kind === "url") return App.el("span", { class: "ws-icon" }, App.el("img", { src: ref.url, alt: "" }));
      return App.el("span", { class: "ws-icon" }, App.glyph(ref) || icon);
    }
    const letter = ((ws && ws.name) || "?").trim().charAt(0).toUpperCase() || "?";
    return App.el("span", { class: "ws-icon letter", text: letter });
  }

  function openWorkspace(id) {
    setWorkspace(id);
    const root = App.store.rootPage(id);
    if (root) App.nav.openPage(root.id);
  }

  async function newWorkspace() {
    const name = await App.ui.prompt("", { title: "New workspace", placeholder: "Workspace name, for example Farm", confirmLabel: "Create" });
    if (!name || !name.trim()) return;
    const { workspace, root } = App.store.createWorkspace({ name: name.trim() });
    setWorkspace(workspace.id);
    App.nav.openPage(root.id);
  }

  /* The current workspace: its name as the section heading (open its home page
     from there, or add a page or database), then its page tree. */
  function workspaceSection(ws, root) {
    const heading = App.el("div", { class: `tree-section tree-section-ws${activeId === root.id ? " active" : ""}` },
      App.el("button", {
        class: "tree-section-label", type: "button", text: ws.name || "Untitled", title: `Open ${ws.name || "the workspace"} home`,
        onclick: () => App.nav.openPage(root.id),
      }),
      App.el("button", {
        class: "tree-link", type: "button", title: "Add a page or database", "aria-label": "Add a page",
        html: App.icon("plus", 14),
        onclick: (e) => App.ui.menu(e.currentTarget, [
          { label: "New page", icon: "page", onSelect: () => App.nav.newPage({ parentId: root.id }) },
          { label: "New database", icon: "database", onSelect: () => App.nav.newPage({ parentId: root.id, kind: "database" }) },
          App.database && App.database.ganttSchema
            ? { label: "New Gantt chart", icon: "db-gantt", onSelect: () => App.nav.newPage({ parentId: root.id, kind: "database", schema: App.database.ganttSchema() }) }
            : null,
        ].filter(Boolean)),
      }));
    // Dropping on the heading moves a page to the top level.
    heading.addEventListener("dragover", (e) => {
      if (!dragId || !canDrop(dragId, root, "inside")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      heading.classList.add("drop-inside");
    });
    heading.addEventListener("dragleave", () => heading.classList.remove("drop-inside"));
    heading.addEventListener("drop", (e) => {
      heading.classList.remove("drop-inside");
      if (!dragId) return;
      e.preventDefault();
      doMove(dragId, root, "inside");
    });
    const out = [heading];
    const kids = treeChildren(root);
    kids.forEach((p) => out.push(node(p, 0, "", !readOnly)));
    if (!kids.length) out.push(App.el("div", { class: "nav-empty", text: "No pages yet" }));
    return out;
  }

  /* Child pages shown in the tree: a database's children are its rows, which
     live in the database view, not here. */
  const treeChildren = (page) => (page.kind === "database" ? [] : App.store.children(page.id));

  /* One page and, if expanded, its subtree. `prefix` separates the expand
     state of a page shown twice (in Favorites and in the tree). */
  function node(page, depth, prefix, editable, { isShareRoot = false } = {}) {
    const key = prefix + page.id;
    const kids = treeChildren(page);
    const canExpand = page.kind !== "database";
    const open = canExpand && expanded.has(key);
    const wrap = App.el("div", { class: `tree-node${open ? " open" : ""}`, dataset: { id: page.id } });
    const href = App.nav.pageHref(page.id);
    const row = App.el("a", {
      class: `tree-row${activeId === page.id ? " active" : ""}`, href, draggable: editable && !isShareRoot ? "true" : "false",
      style: `padding-left: ${6 + depth * 14}px`, title: App.ui.titleOf(page), dataset: { key, id: page.id },
    });
    const lead = App.el("span", { class: `tree-lead${canExpand ? " has-toggle" : ""}` },
      App.el("span", { class: "tree-icon" }, App.shell.pageIcon(page, { size: 16 })));
    if (canExpand) {
      lead.append(App.el("button", {
        class: "tree-toggle", type: "button", tabindex: "-1", "aria-label": open ? "Collapse" : "Expand",
        html: App.icon("chevron-right", 14),
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggle(key); },
      }));
    }
    const title = App.el("span", { class: `tree-title${page.title && page.title.trim() ? "" : " untitled"}`, text: App.ui.titleOf(page) });
    row.append(lead, title);
    if (editable) {
      const actions = App.el("span", { class: "tree-actions" },
        App.el("button", {
          class: "icon-btn tree-more", type: "button", title: "Delete, duplicate, and more", "aria-label": "More actions",
          html: App.icon("dots", 16),
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); rowMenu(e.currentTarget, page, row, { isShareRoot }); },
        }),
        page.kind !== "database" ? App.el("button", {
          class: "icon-btn tree-add", type: "button", title: "Add a page inside", "aria-label": "Add a page inside",
          html: App.icon("plus", 16),
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); addChild(page, prefix); },
        }) : null);
      row.append(actions);
    }
    row.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab: the browser's
      e.preventDefault();
      if (busy === "rename") return;
      App.nav.openPage(page.id);
    });
    if (editable && !isShareRoot) bindDrag(row, page, prefix);
    if (editable) bindDrop(row, page, prefix);
    wrap.append(row);
    if (open) {
      const box = App.el("div", { class: "tree-children" });
      if (kids.length) kids.forEach((c) => box.append(node(c, depth + 1, prefix, editable)));
      else box.append(App.el("div", { class: "nav-empty", style: `padding-left: ${32 + depth * 14}px`, text: "No pages inside" }));
      wrap.append(box);
    }
    return wrap;
  }

  function toggle(key) {
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    saveExpanded();
    render();
  }

  function addChild(page, prefix = "") {
    const child = App.store.createPage({ parentId: page.id, title: "" });
    expanded.add(prefix + page.id);
    saveExpanded();
    App.nav.openPage(child.id, { fresh: true });
  }

  // --- row menu ----------------------------------------------------------------------------
  function rowMenu(anchor, page, row, { isShareRoot = false } = {}) {
    row.classList.add("menu-open");
    const items = [
      { label: "Rename", icon: "text", onSelect: () => startRename(page, row) },
    ];
    if (mode === "owner") {
      items.push({
        label: page.favorite ? "Remove from Favorites" : "Add to Favorites", icon: "star",
        onSelect: () => App.store.updatePage(page.id, { favorite: !page.favorite }),
      });
    }
    items.push(
      { label: "Duplicate", icon: "copy", onSelect: () => { const c = App.store.duplicatePage(page.id); if (c) App.nav.openPage(c.id); } },
      { label: "Copy link", icon: "link", onSelect: () => App.shell.copy(App.shell.absoluteUrl(App.nav.pageHref(page.id)), "Link copied") },
      { label: "Open in new tab", icon: "external", onSelect: () => window.open(App.nav.pageHref(page.id), "_blank") },
    );
    if (mode === "owner") {
      // Anchored to the row: the "…" button hides again once the menu closes.
      items.push({ label: "Move to…", icon: "move", onSelect: () => App.shell.movePicker(row, page.id) });
    }
    if (!isShareRoot) {
      items.push({ divider: true }, {
        label: "Delete", icon: "trash", danger: true,
        onSelect: () => trashWithUndo(page.id),
      });
    }
    App.ui.menu(anchor, items, { onClose: () => row.classList.remove("menu-open") });
  }

  /* Move to the trash, with the undo right there in the toast. If the page is
     open (or an ancestor of the open page), go to its parent. */
  function trashWithUndo(pageId) {
    const page = App.store.page(pageId);
    if (!page) return;
    const openId = App.nav.current();
    const openInside = openId && (openId === pageId || App.store.ancestors(openId).some((a) => a.id === pageId));
    App.store.trashPage(pageId);
    App.toast(`Moved "${App.ui.titleOf(page)}" to the trash`, {
      action: { label: "Undo", run: () => App.store.restorePage(pageId) },
      duration: 6000,
    });
    if (openInside && page.parent_id) App.nav.openPage(page.parent_id, { replace: true });
  }

  function startRename(page, row) {
    const titleEl = row.querySelector(".tree-title");
    if (!titleEl) return;
    busy = "rename";
    row.draggable = false;
    const input = App.el("input", { class: "tree-rename", type: "text", value: page.title || "", placeholder: "Untitled", "aria-label": "Page title" });
    titleEl.replaceWith(input);
    const actions = row.querySelector(".tree-actions");
    if (actions) actions.hidden = true;
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.replace(/\s+/g, " ").trim();
      if (save && value !== (page.title || "")) App.store.updatePage(page.id, { title: value });
      busy = null;
      dirty = false;
      render();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  // --- drag and drop ------------------------------------------------------------------------
  /* The upper third of a row drops before it, the lower third after it, the
     middle inside it. Never into itself or its own subtree, and never inside a
     database (a page dropped there would silently become a row). */
  function zoneOf(e, row) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    return y < 0.3 ? "before" : y > 0.7 ? "after" : "inside";
  }

  function canDrop(id, target, zone) {
    if (!id || !target) return false;
    if (id === target.id) return false;
    if (App.store.ancestors(target.id).some((a) => a.id === id)) return false;
    if (zone === "inside" && target.kind === "database") return false;
    if (zone !== "inside" && !target.parent_id) return false; // beside a root: no
    if (mode === "share" && zone !== "inside" && target.id === shareRootId) return false;
    return true;
  }

  function bindDrag(row, page) {
    row.addEventListener("dragstart", (e) => {
      if (busy) { e.preventDefault(); return; }
      dragId = page.id;
      busy = "drag";
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("text/x-meerpad-page", page.id);
      e.dataTransfer.setData("text/uri-list", App.shell.absoluteUrl(App.nav.pageHref(page.id)));
      e.dataTransfer.setData("text/plain", App.ui.titleOf(page));
      requestAnimationFrame(() => row.classList.add("dragging"));
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      clearDropMarks();
      dragId = null;
      settle();
    });
  }

  function clearDropMarks() {
    if (!el) return;
    el.querySelectorAll(".drop-before, .drop-after, .drop-inside").forEach((n) => n.classList.remove("drop-before", "drop-after", "drop-inside"));
  }

  function bindDrop(row, page, prefix) {
    if (prefix) return; // Favorites mirror pages from anywhere: no drop targets there
    row.addEventListener("dragover", (e) => {
      if (!dragId) return;
      const zone = zoneOf(e, row);
      if (!canDrop(dragId, page, zone)) { clearDropMarks(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!row.classList.contains(`drop-${zone}`)) {
        clearDropMarks();
        row.classList.add(`drop-${zone}`);
      }
    });
    row.addEventListener("dragleave", (e) => {
      if (!row.contains(e.relatedTarget)) row.classList.remove("drop-before", "drop-after", "drop-inside");
    });
    row.addEventListener("drop", (e) => {
      if (!dragId) return;
      const zone = zoneOf(e, row);
      clearDropMarks();
      if (!canDrop(dragId, page, zone)) return;
      e.preventDefault();
      doMove(dragId, page, zone);
    });
  }

  function doMove(id, target, zone) {
    try {
      if (zone === "inside") {
        App.store.movePage(id, { parentId: target.id });
        if (target.parent_id || mode === "share") { expanded.add(target.id); saveExpanded(); }
      } else if (zone === "before") {
        App.store.movePage(id, { parentId: target.parent_id, before: target.id });
      } else {
        App.store.movePage(id, { parentId: target.parent_id, after: target.id });
      }
    } catch (err) {
      App.toast(err.message, { kind: "error" });
    }
  }

  // --- the keyboard -----------------------------------------------------------------------
  /* Every row in the list, top to bottom: favourites, workspaces, the page
     tree, the library. The keyboard walks them like one list. */
  const rows = () => [...el.querySelectorAll(".nav-row, .tree-row")].filter((r) => r.offsetParent !== null);

  function focusRow(row) {
    if (!row) return false;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
    return true;
  }

  /* Give the list the keyboard, on the open page's row in the tree (not its
     copy under Favorites), else the first row. */
  function focus(pageId = activeId) {
    if (!el) return false;
    if (busy === "rename") return false;
    const all = rows();
    const own = pageId ? all.find((r) => r.classList.contains("tree-row") && r.dataset.key === pageId)
      || all.find((r) => r.dataset.id === pageId) : null;
    return focusRow(own || all.find((r) => r.classList.contains("active")) || all[0]);
  }

  /* ↑↓ (or j k) move, → ← (or l h) open and close a branch or step in and out
     of it, Home End jump, Enter opens the page and gives it the keyboard,
     Space opens it and keeps the keyboard here. */
  function onKeyDown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.key || !(t.classList.contains("nav-row") || t.classList.contains("tree-row"))) return;
    const all = rows();
    const i = all.indexOf(t);
    const move = (to) => { e.preventDefault(); focusRow(all[Math.max(0, Math.min(all.length - 1, to))]); };
    const k = e.key;
    if (k === "ArrowDown" || k === "j") return move(i + 1);
    if (k === "ArrowUp" || k === "k") return move(i - 1);
    if (k === "Home") return move(0);
    if (k === "End") return move(all.length - 1);
    if (!t.classList.contains("tree-row")) {
      // A workspace, Import or Trash: Enter and Space press the button (a
      // workspace then shows its pages here, and the keyboard stays).
      return;
    }
    const pageId = t.dataset.id;
    const key = t.dataset.key;
    const nodeEl = t.parentElement;
    const canOpen = Boolean(t.querySelector(".tree-toggle"));
    if (k === "ArrowRight" || k === "l") {
      e.preventDefault();
      if (canOpen && !expanded.has(key)) { expanded.add(key); saveExpanded(); render(); return; }
      const child = nodeEl.querySelector(":scope > .tree-children .tree-row");
      if (child) focusRow(child);
      return;
    }
    if (k === "ArrowLeft" || k === "h") {
      e.preventDefault();
      if (expanded.has(key) && canOpen) { expanded.delete(key); saveExpanded(); render(); return; }
      const parentNode = nodeEl.parentElement && nodeEl.parentElement.closest(".tree-node");
      if (parentNode) focusRow(parentNode.querySelector(":scope > .tree-row"));
      return;
    }
    if (k === "Enter") {
      e.preventDefault();
      App.nav.openPage(pageId);
      // The editor is built synchronously; a page still waiting for its first
      // pull takes the keyboard as the page itself, and Escape still returns.
      if (!App.shell.focusPage()) requestAnimationFrame(() => App.shell.focusPage());
      return;
    }
    if (k === " ") {
      e.preventDefault();
      App.nav.openPage(pageId);
      requestAnimationFrame(() => focus(pageId));
    }
  }

  return {
    init, render, setActive, setWorkspace, expand, trashWithUndo, workspaceIcon, openWorkspace, focus,
    workspaceId: () => (mode === "owner" ? (currentWorkspace() || {}).id || null : null),
    configure({ readOnly: ro } = {}) { if (ro !== undefined) readOnly = ro; schedule(); },
  };
})();
