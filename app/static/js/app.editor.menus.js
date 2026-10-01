/* The editor's menus: the slash menu, the block menu behind the drag handle
   ("Turn into", colours, duplicate, move, delete), links (Ctrl/Cmd+K and
   `[[`), the choice offered after pasting a link, and small pickers (code
   language, callout icon).

   All of them are App.ui menus and popovers. The ones that open while typing
   (slash, paste) leave the caret in the block: the menu is told not to take
   focus, and the block forwards the arrow keys and Enter to it (handle.key),
   so the text after the `/` stays the query and Escape leaves it as typed. */

(() => {
  const E = App.editor;
  const { h, caret, readText, KINDS, COLORS } = E;
  const P = E.Editor.prototype;

  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  const mod = (k) => (MAC ? `⌘${k}` : `Ctrl+${k}`);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const titleOf = (p) => (App.ui && App.ui.titleOf ? App.ui.titleOf(p) : (p && p.title) || "Untitled");
  // A page title inside `[...]` must not end the link text early.
  const linkLabel = (s) => String(s || "").replace(/[[\]\n]+/g, " ").trim() || "Untitled";

  // The caret as an anchor for App.ui, with a fallback to the block.
  function caretAnchor(el) {
    const r = caret.rect();
    if (r && (r.width || r.height || r.top)) return { left: r.left, right: r.left, top: r.top, bottom: r.bottom, width: 0, height: r.height };
    return el && el._text ? el._text.getBoundingClientRect() : null;
  }

  /* An App.ui.menu that leaves focus where it is. The menu focuses itself on
     the next tick; shadowing focus() on its element turns that into nothing,
     and preventing mousedown keeps a click from moving focus either. */
  P.menuInPlace = function (anchor, items, opts = {}) {
    const handle = App.ui.menu(anchor, items, opts);
    handle.el.focus = () => {};
    handle.el.addEventListener("mousedown", (e) => { if (!e.target.closest("input")) e.preventDefault(); });
    this.menu = handle;
    return handle;
  };

  // --- the slash menu -----------------------------------------------------------
  function slashItems() {
    const kind = (type, extra = {}) => ({
      label: KINDS[type].label, icon: KINDS[type].icon, description: KINDS[type].desc,
      keywords: KINDS[type].keywords, run: { type, ...extra },
    });
    return [
      { heading: "Basic blocks" },
      kind("paragraph"), kind("heading_1"), kind("heading_2"), kind("heading_3"),
      kind("to_do"), kind("bulleted_list"), kind("numbered_list"), kind("toggle"),
      kind("quote"), kind("callout"), kind("divider"),
      { heading: "Media" },
      kind("image"), kind("file"), kind("bookmark"), kind("embed"),
      { heading: "Layout" },
      { label: "2 columns", icon: "columns", description: "Two blocks side by side, like a picture and its text",
        keywords: "columns two 2 side by side next to layout grid", run: { type: "grid", props: { columns: 2 } } },
      { label: "3 columns", icon: "columns-3", description: "Three blocks side by side",
        keywords: "columns three 3 side by side next to layout grid", run: { type: "grid", props: { columns: 3 } } },
      kind("grid", { props: { columns: 2, rows: 2 } }),
      { heading: "Advanced" },
      kind("code"),
      { label: "Mermaid diagram", icon: "share", description: "Flowcharts and diagrams from text",
        keywords: "mermaid diagram chart flowchart graph sequence", run: { type: "code", props: { language: "mermaid" } } },
      kind("equation"), kind("table"),
      { heading: "Pages" },
      kind("page"),
      { label: "Link to page", icon: "link", description: "Link to an existing page", keywords: "link page mention reference", run: { action: "link-page" } },
      kind("database"),
      { label: "Gantt chart", icon: "db-gantt", description: "Tasks on a timeline, from start to end date",
        keywords: "gantt timeline chart schedule project plan roadmap database", run: { type: "database", props: { preset: "gantt" } } },
      { heading: "Actions" },
      { label: "Duplicate", icon: "copy", hint: mod("D"), keywords: "duplicate copy clone", run: { action: "duplicate" } },
      { label: "Move to", icon: "move", keywords: "move page", run: { action: "move" } },
      { label: "Delete", icon: "trash", danger: true, keywords: "delete remove", run: { action: "delete" } },
    ];
  }

  P.openSlash = function (el, start) {
    const state = { el, start, query: "" };
    const items = slashItems().map((it) => (it.run ? { ...it, onSelect: () => this.slashPick(state, it.run) } : it));
    const handle = this.menuInPlace(caretAnchor(el), items, {
      className: "slash-menu",
      emptyText: "No results",
      onClose: () => { if (this.slash === state) this.slash = null; },
    });
    state.handle = handle;
    this.slash = state;
  };

  // Called after every input while the menu is open: the text after the `/`
  // filters it; deleting the `/` or running out of matches closes it.
  P.updateSlash = function (el, text, off) {
    const s = this.slash;
    if (!s) return;
    if (s.el !== el || off <= s.start || text[s.start] !== "/") { s.handle.close(); return; }
    const q = text.slice(s.start + 1, off);
    if (q.includes("\n")) { s.handle.close(); return; }
    s.query = q;
    const n = s.handle.filter(q);
    if (!n && (/\s$/.test(q) || q.length > 24)) s.handle.close();
  };

  P.slashPick = function (state, run) {
    const el = state.el;
    if (!el.isConnected || !el._text) return;
    // The `/query` goes; what remains decides between converting this block
    // and inserting a new one below it.
    const text = readText(el._text);
    let end = state.start + 1 + state.query.length;
    if (text.slice(state.start, end) !== `/${state.query}`) end = Math.min(text.length, state.start + 1);
    const rest = text.slice(0, state.start) + text.slice(end);
    this.setText(el, rest, state.start);
    this.commitText(el, rest);
    if (run.action) this.blockAction(el, run.action, state.start);
    else this.insertKind(el, run.type, run.props || {});
  };

  P.blockAction = function (el, action, at) {
    const id = el.dataset.id;
    if (action === "duplicate") {
      const [copy] = this.duplicate([id]);
      if (copy) this.focusBlock(copy.id, at);
    } else if (action === "delete") {
      this.deleteBlocks([id]);
    } else if (action === "move") {
      this.moveToPicker([id], caretAnchor(el));
    } else if (action === "link-page") {
      App.ui.pagePicker(caretAnchor(el), {
        placeholder: "Link to page…",
        exclude: new Set([this.pageId]),
        onPick: (p) => this.insertKind(el, "page", { page_id: p.id }),
        onClose: () => setTimeout(() => { if (el.isConnected && document.activeElement === document.body) this.focusBlock(id, at); }, 0),
      });
    }
  };

  // A fallback database schema (DESIGN §4) for when app.db views are not
  // loaded: a title, one select, and a table view.
  function defaultSchema() {
    if (App.database && App.database.defaultSchema) return App.database.defaultSchema();
    const rid = () => Math.random().toString(36).slice(2, 10);
    return {
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: `p_${rid()}`, name: "Tags", type: "multi_select", options: [] },
      ],
      views: [{ id: `v_${rid()}`, name: "Table", type: "table" }],
    };
  }

  /* A block of `type` in place of `el` (when its text is empty) or right
     after it, then the caret (or selection) where that kind wants it. */
  P.insertKind = function (el, type, props = {}) {
    const id = el.dataset.id;
    const b = App.store.block(id);
    if (!b) return;
    const empty = !readText(el._text || document.createElement("div")) && E.TEXT.has(b.type);
    let targetId = id;
    let newPage = null;
    const make = (t, p, text = "") => {
      if (empty) {
        const merged = E.TEXT.has(t) ? { ...this.propsFor(b.props, t), ...p } : { ...p };
        this.update(id, { type: t, text, props: merged });
        targetId = id;
      } else {
        targetId = this.create({ parentId: b.parent_id, after: id, type: t, text, props: { ...this.newProps(t), ...p } }).id;
      }
    };
    let follow = null;
    this.op(`Insert ${type}`, () => {
      if (type === "page") {
        if (props.page_id) make("page", { page_id: props.page_id });
        else {
          newPage = App.store.createPage({ parentId: this.pageId, title: "" });
          make("page", { page_id: newPage.id });
        }
      } else if (type === "database") {
        const gantt = props.preset === "gantt" && App.database && App.database.ganttSchema;
        newPage = App.store.createPage({ parentId: this.pageId, title: "", kind: "database", schema: gantt ? App.database.ganttSchema() : defaultSchema() });
        make("database", { page_id: newPage.id });
      } else if (type === "table") {
        make("table", { rows: [["", "", ""], ["", "", ""], ["", "", ""]], header_row: true, header_col: false, ...props });
      } else if (type === "divider") {
        make("divider", {});
        follow = this.create({ parentId: b.parent_id, after: targetId, type: "paragraph" });
      } else if (type === "grid") {
        // Cells with a line each to type in; `rows` is only how many to start
        // with. A line with blocks nested under it keeps them and gets the
        // grid after it, since a grid holds nothing but cells.
        const columns = App.mdblocks.gridColumns(props);
        if (empty && !App.store.childBlocks(id).length) make("grid", { columns });
        else targetId = this.create({ parentId: b.parent_id, after: id, type: "grid", props: { columns } }).id;
        const n = columns * Math.max(1, Math.min(6, Number(props.rows) || 1));
        for (let k = 0; k < n; k++) {
          const cell = this.newCell(targetId);
          if (!follow) follow = App.store.childBlocks(cell.id)[0];
        }
      } else {
        make(type, props);
      }
    });
    if (type === "toggle") { const t = this.els.get(targetId); if (t) this.setOpen(t, true); }
    const target = this.els.get(targetId);
    if (type === "page" && newPage) {
      if (App.nav && App.nav.openPage) App.nav.openPage(newPage.id);
      else this.selectBlocks([targetId]);
    } else if (follow) {
      this.focusBlock(follow.id, "start");
    } else if (E.TEXT.has(type)) {
      this.focusBlock(targetId, empty ? 0 : "start");
    } else {
      this.selectBlocks([targetId]);
      if (target && target._activate) target._activate();
    }
  };

  // --- the block menu (drag handle) -----------------------------------------------
  const TURN_INTO = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list", "numbered_list",
    "to_do", "toggle", "quote", "callout", "code", "equation", "page"];

  P.turnIntoItems = function (ids) {
    const types = ids.map((id) => (App.store.block(id) || {}).type);
    return TURN_INTO.map((t) => ({
      label: KINDS[t].label, icon: KINDS[t].icon,
      checked: types.length > 0 && types.every((x) => x === t),
      onSelect: () => { App.ui.closeAll(); this.turnInto(ids, t); },
    }));
  };

  P.colorItems = function (ids) {
    const current = ids.length === 1 ? ((App.store.block(ids[0]) || {}).props || {}).color || "" : null;
    const swatch = (cls) => `<span class="color-swatch${cls ? ` ${cls}` : ""}">A</span>`;
    const pick = (c) => () => { App.ui.closeAll(); this.setColor(ids, c); };
    return [
      { heading: "Text color" },
      { label: "Default", icon: "palette", iconHtml: swatch(""), checked: current === "", onSelect: pick(null) },
      ...COLORS.map((c) => ({ label: cap(c), icon: "palette", iconHtml: swatch(`c-${c}`), checked: current === c, onSelect: pick(c) })),
      { heading: "Background" },
      ...COLORS.map((c) => ({ label: `${cap(c)} background`, icon: "palette", iconHtml: swatch(`bg-${c}`), checked: current === `${c}_bg`, onSelect: pick(`${c}_bg`) })),
    ];
  };

  P.openBlockMenu = function (anchor, ids) {
    ids = this.topLevel(ids);
    if (!ids.length || this.readOnly) return;
    const types = ids.map((id) => (App.store.block(id) || {}).type);
    const items = [];
    if (types.every((t) => E.TEXT.has(t))) items.push({ label: "Turn into", icon: "wand", submenu: this.turnIntoItems(ids) });
    if (ids.length === 1 && types[0] === "grid") items.push(...this.gridMenuItems(ids[0]), { divider: true });
    items.push({ label: "Color", icon: "palette", submenu: this.colorItems(ids) });
    items.push({ divider: true });
    items.push({ label: "Duplicate", icon: "copy", hint: mod("D"), onSelect: () => { const c = this.duplicate(ids); if (c.length) this.selectBlocks(c.map((b) => b.id)); } });
    if (ids.length === 1) items.push({ label: "Copy link to block", icon: "link", onSelect: () => this.copyBlockLink(ids[0]) });
    items.push({ label: "Move to", icon: "move", onSelect: () => this.moveToPicker(ids, anchor) });
    items.push({ divider: true });
    items.push({ label: "Delete", icon: "trash", danger: true, hint: "Del", onSelect: () => this.deleteBlocks(ids) });
    this.menu = App.ui.menu(anchor, items, { className: "block-menu" });
  };

  P.copyBlockLink = function (id) {
    // The shell's pageHref takes the block as a #fragment and openPage
    // scrolls to it; without the shell, the same shape by hand.
    const href = App.nav && App.nav.pageHref ? App.nav.pageHref(this.pageId, id) : `/p/${this.pageId}#${id}`;
    const url = new URL(href, location.href).href;
    const done = () => App.toast("Link to block copied");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => App.toast(url));
    else App.toast(url);
  };

  P.moveToPicker = function (ids, anchor) {
    App.ui.pagePicker(anchor, {
      placeholder: "Move to page…",
      exclude: new Set([this.pageId]),
      filter: (p) => p.kind !== "database",
      onPick: (p) => {
        const list = this.topLevel(ids);
        this.clearSelection();
        this.op("Move to page", () => list.forEach((id) => this.move(id, { pageId: p.id, parentId: null })));
        App.toast(`Moved to ${titleOf(p)}`, App.nav && App.nav.openPage ? { action: { label: "Open", run: () => App.nav.openPage(p.id) } } : {});
      },
    });
  };

  // --- links: Ctrl/Cmd+K ------------------------------------------------------------
  const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;

  // What was typed into the link field, as an address (or null).
  function asUrl(s) {
    const v = String(s || "").trim();
    if (!v || /\s/.test(v)) return null;
    if (/^(https?:\/\/|mailto:)/i.test(v)) return v;
    if (/^\/p\/[A-Za-z0-9-]+$/.test(v)) return v;
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return `mailto:${v}`;
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(v)) return `https://${v}`;
    return null;
  }

  P.openLinkPopover = function (el) {
    const t = el._text;
    if (!t) return;
    const text = readText(t);
    const sel = caret.get(t) || { start: text.length, end: text.length };
    // Inside an existing link: edit or remove that one.
    let existing = null;
    for (const m of text.matchAll(LINK_RE)) {
      if (sel.start >= m.index && sel.end <= m.index + m[0].length) { existing = { at: m.index, src: m[0], label: m[1], url: m[2] }; break; }
    }
    const selected = text.slice(sel.start, sel.end);
    const anchor = caretAnchor(el);
    const wrap = h("div", "link-pop");
    const input = h("input", "input link-input");
    input.type = "text";
    input.placeholder = "Paste a link or search pages";
    if (existing) input.value = existing.url;
    const list = h("div", "menu link-results");
    wrap.append(input, list);
    let done = false;
    let active = 0;
    let options = [];
    const pop = App.ui.popover(anchor, wrap, {
      className: "popover-menu popover-link",
      onClose: () => {
        if (done) return;
        setTimeout(() => { if (el.isConnected && !el.contains(document.activeElement)) { t.focus({ preventScroll: true }); caret.set(t, sel.start, sel.end); } }, 0);
      },
    });
    this.menu = pop;

    const apply = (url, title) => {
      done = true;
      pop.close();
      const cur = readText(t);
      let next, at;
      if (existing && cur.slice(existing.at, existing.at + existing.src.length) === existing.src) {
        const link = `[${existing.label}](${url})`;
        next = cur.slice(0, existing.at) + link + cur.slice(existing.at + existing.src.length);
        at = existing.at + link.length;
      } else {
        const label = linkLabel(selected || title || url);
        const link = `[${label}](${url})`;
        next = cur.slice(0, sel.start) + link + cur.slice(sel.end);
        at = sel.start + link.length;
      }
      this.replaceText(el, next, at);
    };
    const unlink = () => {
      done = true;
      pop.close();
      const cur = readText(t);
      if (cur.slice(existing.at, existing.at + existing.src.length) !== existing.src) return;
      const next = cur.slice(0, existing.at) + existing.label + cur.slice(existing.at + existing.src.length);
      this.replaceText(el, next, existing.at + existing.label.length);
    };
    const render = () => {
      const q = input.value.trim();
      options = [];
      const url = asUrl(q);
      if (url) options.push({ label: `Link to ${url}`, icon: "link", run: () => apply(url) });
      if (q && !url) {
        for (const r of App.store.search(q, 8)) {
          if (r.page.id === this.pageId) continue;
          options.push({ label: titleOf(r.page), desc: App.ui.pathOf ? App.ui.pathOf(r.page) : "", icon: r.page.kind === "database" ? "database" : "page",
            emoji: App.files.isGlyph(r.page.icon) ? r.page.icon : null,
            run: () => apply(`/p/${r.page.id}`, titleOf(r.page)) });
        }
      }
      if (existing) options.push({ label: "Remove link", icon: "trash", danger: true, run: unlink });
      list.textContent = "";
      if (!options.length) list.append(h("div", "menu-empty", q ? "No pages found" : "Type a link or a page title"));
      options.forEach((o, i) => {
        const b = h("button", `menu-item${o.danger ? " danger" : ""}${i === active ? " active" : ""}`);
        b.type = "button";
        const ic = h("span", `menu-icon${o.emoji ? " menu-emoji" : ""}`);
        if (o.emoji) ic.append(App.glyph(o.emoji)); else ic.innerHTML = App.icon(o.icon);
        const lab = h("span", "menu-label", o.label);
        if (o.desc) lab.append(h("small", "menu-desc", o.desc));
        b.append(ic, lab);
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => o.run());
        list.append(b);
      });
      pop.reposition();
    };
    input.addEventListener("input", () => { active = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(options.length - 1, active + 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (e.key === "Enter") { e.preventDefault(); if (options[active]) options[active].run(); }
      e.stopPropagation();
    });
    render();
    setTimeout(() => { input.focus(); input.select(); }, 0);
  };

  // --- `[[`: link to a page while typing -----------------------------------------------
  P.openPageLinkPicker = function (el, at) {
    let picked = false;
    const id = el.dataset.id;
    this.menu = App.ui.pagePicker(caretAnchor(el), {
      placeholder: "Link to page…",
      allowCreate: (title) => App.store.createPage({ parentId: this.pageId, title }),
      onPick: (p) => {
        picked = true;
        const t = el._text;
        if (!el.isConnected || !t) return;
        const text = readText(t);
        let i = text.slice(at, at + 2) === "[[" ? at : text.lastIndexOf("[[");
        const cut = i < 0 ? 0 : 2;
        if (i < 0) i = Math.min(at, text.length);
        const link = `[${linkLabel(titleOf(p))}](/p/${p.id})`;
        this.replaceText(el, text.slice(0, i) + link + text.slice(i + cut), i + link.length);
      },
      onClose: () => setTimeout(() => { if (!picked && el.isConnected) this.focusBlock(id, at + 2); }, 0),
    });
  };

  // --- the choice after pasting a link ------------------------------------------------
  const VIDEO = new Set(["youtube", "vimeo", "loom"]);

  P.openPasteMenu = function (el, url, at) {
    const embed = E.embedSrc ? E.embedSrc(url) : null;
    const video = Boolean(embed && VIDEO.has(embed.provider));
    const state = { el, url, at, closed: false };
    const guess = video ? "video" : App.files.kindFromUrl(url);
    const probing = guess === "unknown" && navigator.onLine;
    const handle = this.menuInPlace(caretAnchor(el), this.pasteItems(state, probing ? "checking" : guess, embed), {
      className: "paste-menu",
      onClose: () => { state.closed = true; if (this.pasteMenu === handle) this.pasteMenu = null; },
    });
    state.handle = handle;
    this.pasteMenu = handle;
    if (probing) {
      App.files.probe(url).then((r) => {
        if (state.closed) return;
        const k = r && r.kind;
        const kind = k === "image" ? "image" : k === "pdf" ? "pdf" : (k === "video" || k === "audio" || k === "file") ? "file" : "link";
        handle.setItems(this.pasteItems(state, kind, embed));
      }).catch(() => { if (!state.closed) handle.setItems(this.pasteItems(state, "link", embed)); });
    }
  };

  P.pasteItems = function (state, kind, embed) {
    const keep = { label: "Keep as link", icon: "link", description: "Leave the address as text", onSelect: () => {} };
    const bookmark = { label: "Bookmark", icon: "bookmark", description: "A card with the link", onSelect: () => this.pasteTurn(state, "bookmark", { url: state.url }) };
    const embedIt = { label: "Embed", icon: "embed", description: "Show it inside the page", onSelect: () => this.pasteTurn(state, "embed", { url: state.url }) };
    if (kind === "checking") return [{ label: "Checking link…", icon: "refresh", disabled: true }, keep, bookmark];
    if (kind === "image") {
      return [
        { label: "Download and add image", icon: "download", description: "Keep a copy in meerpad", onSelect: () => this.pasteDownload(state) },
        { label: "Embed image from URL", icon: "image", description: "Show it from where it is", onSelect: () => this.pasteTurn(state, "image", { url: state.url }) },
        keep,
      ];
    }
    if (kind === "pdf" || kind === "file" || kind === "audio") {
      const what = kind === "pdf" ? "PDF" : "file";
      return [
        { label: `Download and add ${what}`, icon: "download", description: "Keep a copy in meerpad", onSelect: () => this.pasteDownload(state) },
        keep, bookmark,
      ];
    }
    if (kind === "video") {
      return [{ label: "Embed video", icon: "embed", description: "Play it inside the page", onSelect: () => this.pasteTurn(state, "embed", { url: state.url }) }, bookmark, keep];
    }
    return [keep, bookmark, ...(embed ? [embedIt] : [])];
  };

  /* The pasted address becomes a block: the whole block when it held nothing
     else, otherwise the address leaves the text and the block goes after. */
  P.pasteTurn = function (state, type, props) {
    const el = state.el;
    const id = el.dataset.id;
    const b = App.store.block(id);
    if (!b || !el.isConnected) return null;
    const text = el._text ? readText(el._text) : "";
    let i = text.slice(state.at, state.at + state.url.length) === state.url ? state.at : text.indexOf(state.url);
    const only = text.trim() === state.url;
    let targetId = id;
    this.op("Paste link", () => {
      if (only) {
        this.update(id, { type, text: "", props });
      } else {
        if (i >= 0) {
          const rest = (text.slice(0, i) + text.slice(i + state.url.length)).replace(/ {2,}/g, " ");
          this.update(id, { text: rest });
        }
        targetId = this.create({ parentId: b.parent_id, after: id, type, props }).id;
      }
    });
    this.selectBlocks([targetId]);
    return targetId;
  };

  P.pasteDownload = function (state) {
    if (!navigator.onLine) { App.toast("Files need a connection"); return; }
    const el = state.el;
    const b = App.store.block(el.dataset.id);
    if (!b) return;
    let host = state.url;
    try { host = new URL(state.url).hostname; } catch (e) { /* keep the url */ }
    const ph = this.placeholder(b.parent_id, b.id, `Downloading from ${host}…`);
    ph.progress(null);
    this.fetchUrl(state.url).then((res) => {
      ph.remove();
      const image = /^image\//.test(res.content_type || "");
      this.pasteTurn(state, image ? "image" : "file", {
        file_id: res.id, name: res.filename || "file", size: res.size, content_type: res.content_type || "",
      });
    }).catch((err) => {
      ph.remove();
      App.toast(err.message || "The download failed", { kind: "error" });
    });
  };

  // --- small pickers -----------------------------------------------------------------
  const LANGS = ["plain", "bash", "c", "cpp", "csharp", "css", "diff", "dockerfile", "go", "graphql", "html", "java",
    "javascript", "json", "kotlin", "latex", "lua", "makefile", "markdown", "mermaid", "nginx", "php", "powershell",
    "python", "r", "ruby", "rust", "scala", "shell", "sql", "swift", "toml", "typescript", "xml", "yaml"];
  const LANG_LABEL = { plain: "Plain text", cpp: "C++", csharp: "C#", javascript: "JavaScript", typescript: "TypeScript",
    graphql: "GraphQL", html: "HTML", css: "CSS", json: "JSON", php: "PHP", sql: "SQL", xml: "XML", yaml: "YAML", toml: "TOML" };
  E.langLabel = (l) => LANG_LABEL[l] || cap(l || "plain");

  P.openLanguageMenu = function (anchor, el) {
    const id = el.dataset.id;
    const cur = ((App.store.block(id) || {}).props || {}).language || "plain";
    const items = LANGS.map((l) => ({ label: E.langLabel(l), checked: l === cur, onSelect: () => this.setProps(id, { language: l }) }));
    this.menu = App.ui.menu(anchor, items, { filter: true, placeholder: "Search languages…", className: "lang-menu" });
  };

  P.openIconPicker = function (anchor, el) {
    const id = el.dataset.id;
    this.menu = App.iconPicker(anchor, { onPick: (icon) => this.setProps(id, { icon }) });
  };
})();
