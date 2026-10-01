/* The block editor: the page title, then the page's blocks, Notion-style.

   Five files make it up, loaded in this order, all extending one Editor class:

     app.editor.js         this file: the DOM model, rendering, keeping the DOM
                           in step with App.store, the caret helpers, the
                           structural edits (split, merge, indent, ...) and the
                           public API;
     app.editor.menus.js   the slash menu, the block menu, links and pickers;
     app.editor.media.js   images, files, bookmarks, embeds, tables, code,
                           equations, page links and inline databases;
     app.editor.grid.js    grids: blocks side by side, in rows and columns;
     app.editor.input.js   keyboard, typing, paste, drag and drop, selection.

   How it holds together:

   * **The store is the truth.** Every edit is a write to App.store, and the
     DOM is brought in line with the store afterwards, by one function
     (refresh). Local edits, undo and changes pulled from another device all
     take that same path, so there is no second, editor-only notion of what a
     page contains. The one exception is the text of the block being typed in:
     its DOM runs ahead of the store by at most one debounce (~300 ms), and a
     change arriving from elsewhere waits until the block is left (see defer).

   * **A block's text is inline Markdown and stays that way.** Text blocks are
     contenteditable="plaintext-only" elements holding meerail's live preview:
     App.markdown.inline(text, {keep: true}), where the markers are real text,
     dimmed. Blocks that are not being edited hide the markers with CSS rather
     than being repainted without them. The DOM of a block is then always the
     same for one text: textContent is the source, a caret offset in the DOM is
     an offset into the text, and clicking into a block leaves the caret on the
     character that was clicked, because nothing was repainted under it.

   * **Typing repaints one block.** Structural edits repaint the sibling lists
     they touched, reusing every block element that survived. */

window.App = window.App || {};

App.editor = (() => {
  // --- block kinds --------------------------------------------------------------
  // Blocks whose content is one editable text (for media, the caption is the
  // text, but those are not "text blocks" for merging and arrow keys).
  const TEXT = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list", "numbered_list",
    "to_do", "toggle", "quote", "callout", "code", "equation"]);
  const LISTS = new Set(["bulleted_list", "numbered_list", "to_do"]);
  // Enter at the end of one of these starts another of the same kind.
  const CONTINUES = new Set(["bulleted_list", "numbered_list", "to_do", "toggle"]);
  // Enter in one of these while it is empty leaves the list (or quote).
  const EXITS = new Set(["bulleted_list", "numbered_list", "to_do", "quote", "toggle", "callout"]);
  const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

  /* Names, icons and one-line descriptions, shared by the slash menu, "Turn
     into" and the block menu. The icon names are App.ICONS keys. */
  const KINDS = {
    paragraph: { label: "Text", icon: "paragraph", desc: "Plain text", keywords: "paragraph plain p" },
    heading_1: { label: "Heading 1", icon: "h1", desc: "Big section heading", keywords: "h1 title #" },
    heading_2: { label: "Heading 2", icon: "h2", desc: "Medium section heading", keywords: "h2 subtitle ##" },
    heading_3: { label: "Heading 3", icon: "h3", desc: "Small section heading", keywords: "h3 ###" },
    to_do: { label: "To-do list", icon: "todo", desc: "Track tasks with a checkbox", keywords: "todo task checkbox check" },
    bulleted_list: { label: "Bulleted list", icon: "bullet", desc: "A simple bulleted list", keywords: "bullet ul unordered list -" },
    numbered_list: { label: "Numbered list", icon: "numbered", desc: "A list with numbering", keywords: "numbered ol ordered list 1." },
    toggle: { label: "Toggle list", icon: "toggle", desc: "Hide and show content inside", keywords: "toggle collapse details" },
    quote: { label: "Quote", icon: "quote", desc: "Capture a quote", keywords: "quote blockquote citation" },
    callout: { label: "Callout", icon: "callout", desc: "Make writing stand out", keywords: "callout note aside info tip" },
    code: { label: "Code", icon: "code", desc: "Capture a code snippet", keywords: "code snippet pre ```" },
    equation: { label: "Equation", icon: "equation", desc: "Display a TeX equation", keywords: "equation math tex latex katex formula" },
    divider: { label: "Divider", icon: "divider", desc: "Visually divide blocks", keywords: "divider hr line rule ---" },
    image: { label: "Image", icon: "image", desc: "Upload or embed with a link", keywords: "image picture photo img" },
    file: { label: "File / PDF", icon: "file", desc: "Upload a file or PDF", keywords: "file pdf attachment upload document" },
    bookmark: { label: "Bookmark", icon: "bookmark", desc: "Save a link as a visual card", keywords: "bookmark link url card" },
    embed: { label: "Embed", icon: "embed", desc: "YouTube, Vimeo, Maps, Figma…", keywords: "embed video youtube vimeo loom maps codepen figma iframe" },
    table: { label: "Table", icon: "table", desc: "A simple table", keywords: "table grid rows columns" },
    grid: { label: "Grid", icon: "grid", desc: "Blocks in rows and columns", keywords: "grid columns rows layout side by side next to" },
    page: { label: "Page", icon: "page", desc: "Embed a sub-page inside this page", keywords: "page subpage new" },
    database: { label: "Database", icon: "database", desc: "An inline database of pages", keywords: "database table board list gallery" },
  };

  // Blocks' renderers: { render(ed, el, block) -> { row, kidsHost?, after? } },
  // and optionally update(ed, el, block) -> true when a change of props was
  // applied to the element in place. The text kinds are here;
  // app.editor.media.js and app.editor.grid.js register the rest.
  const types = {};

  // --- small helpers --------------------------------------------------------------
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  const norm = (s) => String(s).replace(/ /g, " ");
  const propsKey = (p) => JSON.stringify(p || {});
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function colorClass(props) {
    const c = props && props.color;
    if (!c) return "";
    if (c.endsWith("_bg") && COLORS.includes(c.slice(0, -3))) return ` bg-${c.slice(0, -3)}`;
    return COLORS.includes(c) ? ` c-${c}` : "";
  }

  // --- text and caret -------------------------------------------------------------
  // meerail's offset helpers, reduced to one block. A block's DOM is only ever
  // our own markup (spans, a code, a link, and the trailing <br> that gives a
  // final soft break its line), so the source is the textContent. The slow
  // path exists for the moments a browser inserts markup of its own before
  // the repaint that follows every input.
  const BLOCKISH = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6])$/;

  function readText(t) {
    if (!t.querySelector("br, div, p")) return norm(t.textContent);
    let out = "";
    const last = t.lastChild;
    const walk = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeName === "BR") { if (!(c === last || (c.nextSibling === null && node !== t && node === last))) out += "\n"; }
        else if (c.nodeType === 1) {
          if (BLOCKISH.test(c.nodeName) && out && !out.endsWith("\n")) out += "\n";
          walk(c);
        }
      }
    };
    walk(t);
    return norm(out);
  }

  const caret = {
    // The source offset of a DOM point inside the editable `t`.
    offset(t, node, off) {
      const r = document.createRange();
      r.selectNodeContents(t);
      try { r.setEnd(node, off); } catch (e) { return 0; }
      return norm(r.toString()).length;
    },
    // { start, end, collapsed } when the selection lies inside `t`, else null.
    get(t) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (!t.contains(r.startContainer) || !t.contains(r.endContainer)) return null;
      const a = caret.offset(t, r.startContainer, r.startOffset);
      const b = r.collapsed ? a : caret.offset(t, r.endContainer, r.endOffset);
      return { start: Math.min(a, b), end: Math.max(a, b), collapsed: a === b };
    },
    // The DOM point for a source offset: meerail's placeInLine walk.
    point(t, off) {
      const walk = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
      let n, seen = 0, last = null;
      while ((n = walk.nextNode())) {
        if (seen + n.data.length >= off) return [n, Math.max(0, off - seen)];
        seen += n.data.length;
        last = n;
      }
      return last ? [last, last.data.length] : [t, 0];
    },
    set(t, start, end = start) {
      const a = caret.point(t, start);
      const b = end === start ? a : caret.point(t, end);
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
      sel.removeAllRanges();
      sel.addRange(r);
    },
    // The caret's box on screen, for anchoring menus and for arrow keys.
    rect() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(false);
      const rects = r.getClientRects();
      if (rects.length) return rects[rects.length - 1];
      // At an element boundary a collapsed range has no box. The character
      // before it does.
      const node = r.startContainer;
      if (node.nodeType === 3 && r.startOffset > 0) {
        const r2 = document.createRange();
        r2.setStart(node, r.startOffset - 1);
        r2.setEnd(node, r.startOffset);
        const b = r2.getBoundingClientRect();
        if (b.width || b.height) return { left: b.right, right: b.right, top: b.top, bottom: b.bottom, width: 0, height: b.height };
      }
      const host = (node.nodeType === 1 ? node : node.parentElement);
      return host ? host.getBoundingClientRect() : null;
    },
    fromPoint(x, y) {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        return p ? { node: p.offsetNode, offset: p.offset } : null;
      }
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        return r ? { node: r.startContainer, offset: r.startOffset } : null;
      }
      return null;
    },
  };

  // --- toggle state -----------------------------------------------------------------
  // Open or closed is this browser's view of a toggle, not the document's
  // (DESIGN §2), so it lives in App.local: one small map, trimmed so it cannot
  // grow without bound.
  const OPEN_KEY = "editor.toggles";
  function openMap() { return App.local.get(OPEN_KEY, {}) || {}; }
  function isOpen(id) { return Boolean(openMap()[id]); }
  function storeOpen(id, open) {
    const m = openMap();
    if (open) m[id] = 1; else delete m[id];
    const keys = Object.keys(m);
    if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach((k) => delete m[k]);
    App.local.set(OPEN_KEY, m);
  }

  // =====================================================================================
  class Editor {
    constructor(host, opts) {
      this.host = host;
      this.pageId = opts.pageId;
      this.readOnly = Boolean(opts.readOnly);
      this.els = new Map();        // block id -> block element
      this.dirty = new Set();      // block elements with unsaved text
      this.selected = new Set();   // block selection (ids)
      this.removed = [];           // elements taken out during a refresh
      this.offs = [];              // cleanups for destroy()
      this.md = null;              // Markdown mode state
      this.build(opts.header);
      this.renderAll();
      this.wireCore();
      if (this.wireInput) this.wireInput();
    }

    // --- building -------------------------------------------------------------------
    build(header) {
      const root = h("div", `editor${this.readOnly ? " is-readonly" : ""}`);
      root.tabIndex = -1;
      root.dataset.pageId = this.pageId;
      const inner = h("div", "editor-inner");
      const title = h("h1", "editor-title");
      title.dataset.placeholder = "Untitled";
      if (!this.readOnly) {
        title.contentEditable = "plaintext-only";
        title.spellcheck = true;
      }
      const page = App.store.page(this.pageId);
      title.textContent = page ? page.title || "" : "";
      inner.append(title);
      if (header) {
        const wrap = h("div", "editor-header");
        wrap.append(header);
        inner.append(wrap);
      }
      const blocks = h("div", "editor-blocks");
      const tail = h("div", "editor-tail");
      inner.append(blocks, tail);
      root.append(inner);
      this.host.append(root);
      Object.assign(this, { root, inner, titleEl: title, blocksEl: blocks, tailEl: tail });
    }

    renderAll() {
      this.clearSelection();
      for (const el of this.els.values()) this.cleanup(el);
      this.els.clear();
      this.dirty.clear();
      this.blocksEl.textContent = "";
      const frag = document.createDocumentFragment();
      for (const b of App.store.blocks(this.pageId)) frag.append(this.renderBlock(b, null));
      this.blocksEl.append(frag);
      this.afterRootList();
    }

    // A block element and, recursively, its children. Elements that already
    // exist (moved here within one refresh) are reused rather than rebuilt.
    renderBlock(b, parentEl) {
      const el = document.createElement("div");
      el.dataset.id = b.id;
      el._ld = this.ldFor(parentEl);
      this.els.set(b.id, el);
      this.fill(el, b);
      const kids = App.store.childBlocks(b.id);
      for (const k of kids) {
        const existing = this.els.get(k.id);
        if (existing) {
          existing._b.parent = b.id;
          existing._b.position = k.position;
          el._kids.append(existing);
          this.setLd(existing, this.ldFor(el));
        } else {
          el._kids.append(this.renderBlock(k, el));
        }
      }
      return el;
    }

    // (Re)build a block's own content. The children container survives, with
    // the children in it, so changing a parent's type never rebuilds its
    // subtree.
    fill(el, b) {
      this.cleanup(el);
      const kids = el._kids || h("div", "blk-children");
      el.textContent = "";
      el._text = null;
      el.className = `blk blk-${b.type}${colorClass(b.props)}${this.selected.has(b.id) ? " is-selected" : ""}`;
      if (LISTS.has(b.type)) el.dataset.ld = String(el._ld % 3);
      else delete el.dataset.ld;
      el._b = { type: b.type, text: b.text || "", props: propsKey(b.props), parent: b.parent_id || "", position: b.position };
      const def = types[b.type] || types.unknown;
      const out = def.render(this, el, b) || {};
      const row = out.row || h("div");
      row.classList.add("blk-row");
      el.append(row);
      (out.kidsHost || el).append(kids);
      if (out.after) el.append(out.after);
      el._row = row;
      el._kids = kids;
    }

    // Undo whatever a renderer set up outside the element (an inline database,
    // an observer). Renderers register it as el._destroy.
    cleanup(el) {
      if (el._destroy) {
        try { el._destroy(); } catch (e) { console.error(e); }
        el._destroy = null;
      }
    }

    // List nesting depth, for the bullet shape and number style (1. a. i.).
    // It counts list items only: a list inside a toggle starts again at 0.
    ldFor(parentEl) {
      return parentEl && parentEl._b && LISTS.has(parentEl._b.type) ? (parentEl._ld || 0) + 1 : 0;
    }

    setLd(el, ld) {
      if (el._ld === ld) return;
      el._ld = ld;
      if (LISTS.has(el._b.type)) el.dataset.ld = String(ld % 3);
      for (const c of this.childEls(el)) this.setLd(c, this.ldFor(el));
    }

    childEls(el) {
      const out = [];
      if (!el._kids) return out;
      for (let c = el._kids.firstElementChild; c; c = c.nextElementSibling) if (c.dataset.id) out.push(c);
      return out;
    }

    // An editable text for a block (its `text` field). opts: cls, placeholder,
    // plain (no Markdown: code, TeX), role ("caption", "code", "equation").
    textEl(el, b, opts = {}) {
      const t = h("div", `blk-text${opts.cls ? ` ${opts.cls}` : ""}`);
      if (!this.readOnly) {
        t.contentEditable = "plaintext-only";
        t.spellcheck = !opts.plain;
      }
      if (opts.placeholder) t.dataset.placeholder = opts.placeholder;
      if (opts.role) t.dataset.role = opts.role;
      t._plain = Boolean(opts.plain);
      // Code is highlighted in its block's language (app.highlight.js); read
      // through the element so a language change is picked up on repaint.
      if (opts.role === "code") t._lang = () => ((App.store.block(el.dataset.id || b.id) || b).props || {}).language;
      this.paint(t, b.text || "");
      el._text = t;
      return t;
    }

    htmlFor(t, text) {
      let html;
      if (t._plain) html = (t._lang && App.highlight && App.highlight.html(text, t._lang())) || App.esc(text);
      else if (this.readOnly) return App.markdown.inline(text, { keep: false });
      else html = App.markdown.inline(text, { keep: true, anchors: true });
      // A final soft break needs something after it to get a line of its own.
      return text.endsWith("\n") ? `${html}<br>` : html;
    }

    paint(t, text) {
      t.innerHTML = this.htmlFor(t, text);
    }

    // Repaint after an input only when the markup would change, keeping the
    // selection by offset (meerail's sync, for one line).
    repaint(t, text, sel) {
      const html = this.htmlFor(t, text);
      if (t.innerHTML === html) return;
      t.innerHTML = html;
      if (sel && document.activeElement === t) caret.set(t, Math.min(sel.start, text.length), Math.min(sel.end, text.length));
    }

    // Put new text into a block's editable and record it as what the store has.
    setText(el, text, sel) {
      const t = el._text;
      if (!t) return;
      clearTimeout(el._timer);
      el._dirty = false;
      this.dirty.delete(el);
      el._b.text = text;
      this.paint(t, text);
      if (sel !== undefined && sel !== null && document.activeElement === t) {
        const s = typeof sel === "number" ? { start: sel, end: sel } : sel;
        caret.set(t, Math.min(s.start, text.length), Math.min(s.end, text.length));
      }
    }

    // --- saving text ------------------------------------------------------------------
    markDirty(el) {
      el._dirty = true;
      this.dirty.add(el);
      clearTimeout(el._timer);
      el._timer = setTimeout(() => this.saveText(el), 300);
    }

    saveText(el) {
      clearTimeout(el._timer);
      el._timer = null;
      if (!el._dirty) return;
      el._dirty = false;
      this.dirty.delete(el);
      if (!el._text || this.readOnly) return;
      const text = readText(el._text);
      const b = App.store.block(el.dataset.id);
      if (!b || b.deleted) return;
      el._b.text = text;
      if ((b.text || "") !== text) App.store.updateBlock(b.id, { text });
    }

    flushAll() {
      for (const el of [...this.dirty]) this.saveText(el);
      if (this.saveTitle) this.saveTitle();
      if (this.saveCells) this.saveCells();
    }

    // --- keeping the DOM in step with the store ------------------------------------
    /* Bring the blocks with these ids (and the lists they sit in) in line with
       the store. Idempotent: an element whose recorded state matches the store
       is left alone, so the same change can safely arrive twice (from the edit
       that made it and then from the store's batched notification).
       opts.force: apply even to the block being edited (undo, own edits). */
    refresh(ids, opts = {}) {
      const force = Boolean(opts.force);
      const lists = new Set();
      const active = document.activeElement;
      for (const id of ids) {
        const b = App.store.block(id);
        const el = this.els.get(id);
        const here = b && !b.deleted && b.page_id === this.pageId;
        if (!here) {
          if (el) lists.add(el._b.parent);
          continue;
        }
        const parent = b.parent_id || "";
        if (!el) { lists.add(parent); continue; }
        const s = el._b;
        if (s.parent !== parent || s.position !== b.position) { lists.add(s.parent); lists.add(parent); }
        const editing = this.isEditing(el, active);
        if (s.type !== b.type || s.props !== propsKey(b.props)) {
          // A grid takes a new column count in place: rebuilding it would
          // take its cells, and a caret in one of them, out of the page.
          const def = types[b.type];
          if (s.type === b.type && def && def.update && def.update(this, el, b)) { s.props = propsKey(b.props); continue; }
          if (editing && !force) { el._stale = true; continue; }
          this.refill(el, b);
        } else if (s.text !== (b.text || "")) {
          if ((editing || el._dirty) && !force) { this.defer(el); continue; }
          const sel = editing && el._text ? caret.get(el._text) : null;
          this.setText(el, b.text || "", sel);
        }
      }
      for (const key of lists) this.reconcile(key || null);
      this.collect();
    }

    // Focus is in the block's own content (its text, a caption, a table cell),
    // not in one of its children (a callout's children sit inside its row).
    isEditing(el, active = document.activeElement) {
      return Boolean(active && active !== document.body && el._row && el._row.contains(active)
        && !(el._kids && el._kids.contains(active)));
    }

    // Rebuild a block's own content from the store, keeping the caret when
    // the block was being edited.
    refill(el, b) {
      const t = el._text;
      const had = t && document.activeElement === t;
      const sel = had ? caret.get(t) : null;
      const wasEditing = el.classList.contains("is-editing");
      this.fill(el, b);
      for (const c of this.childEls(el)) this.setLd(c, this.ldFor(el));
      if (wasEditing) el.classList.add("is-editing");
      if (had && el._text) {
        el._text.focus({ preventScroll: true });
        if (sel) caret.set(el._text, Math.min(sel.start, readText(el._text).length));
      }
    }

    // Remote text for the block being typed in waits for blur (focusout in
    // app.editor.input.js), and is taken then only if nothing was typed
    // meanwhile. Two people typing into one block at once is last-write-wins
    // per field anyway; this only keeps the caret from being yanked.
    defer(el) {
      if (!el._deferred) el._deferred = { base: el._text ? readText(el._text) : "", dirty: Boolean(el._dirty) };
    }

    applyDeferred(el) {
      const d = el._deferred;
      el._deferred = null;
      const b = App.store.block(el.dataset.id);
      if (d && b && !d.dirty && el._text && readText(el._text) === d.base) {
        this.setText(el, b.text || "");
      } else {
        this.saveText(el);
      }
      if (el._stale && b && !b.deleted) {
        el._stale = false;
        this.refill(el, b);
      }
    }

    // One sibling list against the store: keyed by block id, moving and
    // creating elements as needed, leaving non-block elements (upload
    // placeholders) where they are.
    reconcile(parentId) {
      const parentEl = parentId ? this.els.get(parentId) : null;
      const container = parentId ? parentEl && parentEl._kids : this.blocksEl;
      if (!container) return;
      const rows = parentId ? App.store.childBlocks(parentId) : App.store.blocks(this.pageId);
      const ld = this.ldFor(parentEl);
      let cursor = container.firstElementChild;
      for (const b of rows) {
        if (b.page_id !== this.pageId) continue;
        let el = this.els.get(b.id);
        if (!el) el = this.renderBlock(b, parentEl);
        else {
          el._b.parent = b.parent_id || "";
          el._b.position = b.position;
          this.setLd(el, ld);
        }
        while (cursor && cursor !== el && !cursor.dataset.id) cursor = cursor.nextElementSibling;
        if (cursor === el) cursor = el.nextElementSibling;
        else container.insertBefore(el, cursor);
      }
      while (cursor) {
        const next = cursor.nextElementSibling;
        if (cursor.dataset.id) { cursor.remove(); this.removed.push(cursor); }
        cursor = next;
      }
      if (!parentId) this.afterRootList();
    }

    // Elements taken out and not put back anywhere are gone for good.
    collect() {
      const removed = this.removed;
      this.removed = [];
      for (const el of removed) if (!el.isConnected) this.forget(el);
    }

    forget(el) {
      const all = [el, ...el.querySelectorAll(".blk")];
      for (const x of all) {
        const id = x.dataset.id;
        if (this.els.get(id) === x) this.els.delete(id);
        this.cleanup(x);
        clearTimeout(x._timer);
        this.dirty.delete(x);
        this.selected.delete(id);
      }
    }

    // The first block of an otherwise empty page says what to do.
    afterRootList() {
      const first = this.blocksEl.firstElementChild;
      const only = first && first.dataset.id && !first.nextElementSibling ? first : null;
      if (this._longPh && this._longPh !== (only && only._text)) {
        this._longPh.dataset.placeholder = "Press '/' for commands…";
        this._longPh = null;
      }
      if (only && only._b.type === "paragraph" && only._text) {
        only._text.dataset.placeholder = "Write something, or press '/' for commands…";
        this._longPh = only._text;
      }
    }

    refreshPages(pageIds, opts = {}) {
      if (pageIds.has(this.pageId)) {
        const p = App.store.page(this.pageId);
        if (p && document.activeElement !== this.titleEl && norm(this.titleEl.textContent) !== (p.title || "")) {
          this.titleEl.textContent = p.title || "";
        }
      }
      // Page links and inline databases show their target's live title/icon.
      for (const el of this.blocksEl.querySelectorAll(".blk-page, .blk-database")) {
        const b = App.store.block(el.dataset.id);
        const target = b && b.props && b.props.page_id;
        if (target && pageIds.has(target) && (el._b.type === "page" || opts.force)) this.fill(el, b);
      }
    }

    // --- wiring (the parts that belong to the model, not to input) ----------------
    wireCore() {
      this.offs.push(App.bus.on("store:change", (ch) => this.onStoreChange(ch)));
      this.offs.push(App.bus.on("store:replayed", (ids) => this.onReplayed(ids)));
      const flush = () => { try { this.flushAll(); if (this.md) this.applyMarkdown(); } catch (e) { console.error(e); } };
      window.addEventListener("pagehide", flush);
      this.offs.push(() => window.removeEventListener("pagehide", flush));
      this.wireTitle();
    }

    onStoreChange(ch) {
      if (this.destroyed) return;
      if (this.md) { this.md.stale = true; if (ch.pages && ch.pages.size) this.refreshPages(ch.pages); return; }
      if (ch.pages && ch.pages.size) this.refreshPages(ch.pages);
      if (ch.blocks && ch.blocks.size) this.refresh(ch.blocks, { force: ch.source === "undo" });
    }

    /* After undo/redo: show the result at once (the store's own notification
       comes a microtask later) and put the caret back where the change was. */
    onReplayed(ids) {
      if (this.destroyed || this.md) return;
      const mine = [...ids.blocks].filter((id) => {
        const b = App.store.block(id);
        return b && b.page_id === this.pageId || this.els.has(id);
      });
      if (!mine.length && !ids.pages.has(this.pageId)) return;
      // Where to land if the block the change was about is gone now.
      const first = mine[0];
      const firstEl = first ? this.els.get(first) : null;
      const before = firstEl ? this.prevVisible(firstEl) : null;
      const oldText = firstEl && firstEl._text ? readText(firstEl._text) : null;
      this.refresh(mine, { force: true });
      if (ids.pages.has(this.pageId)) this.refreshPages(new Set([this.pageId]));
      if (!first) return;
      const b = App.store.block(first);
      if (b && !b.deleted && b.page_id === this.pageId && this.els.has(first)) {
        const text = b.text || "";
        let at = text.length;
        if (oldText !== null && oldText !== text) {
          // The caret goes to the end of what changed.
          let p = 0;
          while (p < oldText.length && p < text.length && oldText[p] === text[p]) p++;
          at = text.length >= oldText.length ? p + (text.length - oldText.length) : p;
        }
        this.focusBlock(first, at);
      } else if (before && before.isConnected) {
        this.focusBlock(before.dataset.id, "end");
      }
    }

    // --- the title ------------------------------------------------------------------
    wireTitle() {
      const t = this.titleEl;
      if (this.readOnly) return;
      t.addEventListener("input", () => {
        clearTimeout(this.titleTimer);
        this.titleTimer = setTimeout(() => this.saveTitle(), 300);
      });
      t.addEventListener("blur", () => this.saveTitle());
      t.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          this.saveTitle();
          this.enterFromTitle();
        } else if (e.key === "ArrowDown") {
          const r = caret.rect();
          const box = t.getBoundingClientRect();
          const lh = parseFloat(getComputedStyle(t).lineHeight) || 40;
          if (!r || box.bottom - r.bottom < lh * 0.75) {
            e.preventDefault();
            this.saveTitle();
            this.enterFromTitle(r ? r.left : null);
          }
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
          // The title's own typing undoes natively; everything else is the store's.
          e.stopPropagation();
        }
      });
      t.addEventListener("paste", (e) => {
        e.preventDefault();
        const s = (e.clipboardData.getData("text/plain") || "").replace(/\s*\n\s*/g, " ");
        document.execCommand("insertText", false, s);
      });
    }

    saveTitle() {
      if (this.readOnly) return;
      clearTimeout(this.titleTimer);
      const title = norm(this.titleEl.textContent).replace(/\n/g, " ");
      const p = App.store.page(this.pageId);
      if (p && (p.title || "") !== title) App.store.updatePage(this.pageId, { title });
      // An emptied title keeps a stray <br> in some browsers; :empty needs none.
      if (!title && this.titleEl.firstChild) this.titleEl.textContent = "";
    }

    // Enter or ArrowDown in the title: to the first block, making one if the
    // page has none that can take text.
    enterFromTitle(x) {
      const first = this.blocksEl.firstElementChild;
      if (first && first.dataset.id && this.isTextTarget(first)) {
        if (x != null && this.focusAtX) this.focusAtX(first, x, "first");
        else this.focusBlock(first.dataset.id, "start");
        return;
      }
      const b = this.op("New block", () => this.create({ parentId: null, after: null, type: "paragraph" }));
      this.focusBlock(b.id, "start");
    }

    // --- traversal --------------------------------------------------------------------
    blockOf(node) {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const b = el && el.closest(".blk");
      return b && this.blocksEl.contains(b) ? b : null;
    }

    parentEl(el) {
      const p = el.parentElement && el.parentElement.closest(".blk");
      return p && this.blocksEl.contains(p) ? p : null;
    }

    collapsed(el) { return el.classList.contains("is-collapsed"); }

    firstChildEl(el) {
      if (!el._kids || this.collapsed(el)) return null;
      let c = el._kids.firstElementChild;
      while (c && !c.dataset.id) c = c.nextElementSibling;
      return c;
    }

    lastChildEl(el) {
      if (!el._kids || this.collapsed(el)) return null;
      let c = el._kids.lastElementChild;
      while (c && !c.dataset.id) c = c.previousElementSibling;
      return c;
    }

    // The block above in reading order: the previous sibling's deepest last
    // visible descendant, or the parent.
    prevVisible(el) {
      let p = el.previousElementSibling;
      while (p && !p.dataset.id) p = p.previousElementSibling;
      if (p) {
        let d = this.lastChildEl(p);
        while (d) { p = d; d = this.lastChildEl(p); }
        return p;
      }
      return this.parentEl(el);
    }

    nextVisible(el) {
      const c = this.firstChildEl(el);
      if (c) return c;
      let cur = el;
      while (cur) {
        let n = cur.nextElementSibling;
        while (n && !n.dataset.id) n = n.nextElementSibling;
        if (n) return n;
        cur = this.parentEl(cur);
      }
      return null;
    }

    visibleBlocks() {
      const out = [];
      const walk = (container) => {
        for (let c = container.firstElementChild; c; c = c.nextElementSibling) {
          if (!c.dataset.id) continue;
          out.push(c);
          if (c._kids && !this.collapsed(c)) walk(c._kids);
        }
      };
      walk(this.blocksEl);
      return out;
    }

    // A block the caret can go into: its main text is editable and on screen.
    isTextTarget(el) {
      const t = el && el._text;
      return Boolean(t && TEXT.has(el._b.type) && t.isContentEditable && t.getClientRects().length);
    }

    prevText(el) {
      let p = this.prevVisible(el);
      while (p && !this.isTextTarget(p)) p = this.prevVisible(p);
      return p;
    }

    nextText(el) {
      let n = this.nextVisible(el);
      while (n && !this.isTextTarget(n)) n = this.nextVisible(n);
      return n;
    }

    // Ids with none of their ancestors in the set, in document order.
    topLevel(ids) {
      const set = new Set(ids);
      const out = [];
      for (const id of set) {
        let b = App.store.block(id);
        if (!b) continue;
        let covered = false;
        let p = b.parent_id;
        const seen = new Set();
        while (p && !seen.has(p)) {
          seen.add(p);
          if (set.has(p)) { covered = true; break; }
          const pb = App.store.block(p);
          p = pb && pb.parent_id;
        }
        if (!covered) out.push(id);
      }
      return out.sort((a, b) => {
        const ea = this.els.get(a), eb = this.els.get(b);
        if (!ea || !eb) return 0;
        return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    }

    siblingsOf(b) {
      return b.parent_id ? App.store.childBlocks(b.parent_id) : App.store.blocks(this.pageId);
    }

    // --- grids ------------------------------------------------------------------------
    /* A grid's children are cells, and a cell sits in a grid (DESIGN §2). The
       structural edits keep it so: nothing is indented into a grid or out of
       a cell, merges stop at a cell's edge, and a cell is never selected on
       its own (deleting or moving one would shift every cell after it), its
       grid is. Inside a cell, a block behaves as at the top of the page. */

    // The innermost cell element an element sits in, or null.
    enclosingCell(el) {
      const c = el && el.parentElement && el.parentElement.closest(".blk-grid_cell");
      return c && this.blocksEl.contains(c) ? c : null;
    }

    // In a list nothing can be outdented from: the page's own, or a cell's.
    atTop(b) {
      if (!b.parent_id) return true;
      const p = App.store.block(b.parent_id);
      return Boolean(p && p.type === "grid_cell");
    }

    // A child of a grid: a cell (or a block another client left there). Its
    // place is its grid's layout, so it is not moved by itself.
    inGrid(b) {
      const p = b && b.parent_id ? App.store.block(b.parent_id) : null;
      return Boolean(p && p.type === "grid");
    }

    // Whether Shift+Tab (or moving past the edge) may take a block out of its
    // parent: not out of a cell, and not out of a grid's slots.
    canLeaveParent(b) {
      return Boolean(b && b.parent_id && !this.atTop(b) && !this.inGrid(b));
    }

    // What selecting a block selects: a cell's grid for the cell.
    selectable(id) {
      const b = App.store.block(id);
      const p = b && b.type === "grid_cell" && b.parent_id ? App.store.block(b.parent_id) : null;
      return p && p.type === "grid" ? p.id : id;
    }

    // --- focus and selection ------------------------------------------------------
    openAncestors(el) {
      let p = this.parentEl(el);
      while (p) {
        if (p._b.type === "toggle" && this.collapsed(p)) this.setOpen(p, true);
        p = this.parentEl(p);
      }
    }

    // The editable the caret should go to for a block, switching a rendered
    // equation or diagram into its source view first.
    editableOf(el) {
      if (!el || !el._text || !el._text.isContentEditable) return null;
      if (el._edit) el._edit(true);
      return el._text.getClientRects().length ? el._text : null;
    }

    focusBlock(id, where = "end") {
      const el = this.els.get(id);
      if (!el) return false;
      this.openAncestors(el);
      const t = this.editableOf(el);
      if (!t) { this.selectBlocks([id]); return true; }
      this.clearSelection();
      t.focus({ preventScroll: true });
      const len = readText(t).length;
      const off = where === "start" ? 0 : where === "end" ? len : Math.max(0, Math.min(Number(where) || 0, len));
      caret.set(t, off);
      this.reveal(el);
      return true;
    }

    reveal(el) {
      const r = (el._row || el).getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: "nearest" });
    }

    /* Where to put the cursor when the page is entered from the page list with
       Enter: back where it was when Escape left it (per page, this session),
       else the title of an untitled page, else the start of the first text
       block. Read-only pages get the focus on the page itself, so Escape still
       has somewhere to leave from. */
    focusDefault() {
      const last = lastFocus.get(this.pageId);
      if (this.readOnly || this.md) { this.root.focus({ preventScroll: true }); return; }
      if (last && last.title) { this.focusTitle(); return; }
      if (last && last.id && this.els.has(last.id) && this.focusBlock(last.id, last.offset)) return;
      const p = App.store.page(this.pageId);
      const first = this.blocksEl.firstElementChild;
      if (p && p.title && first && first.dataset.id && this.isTextTarget(first)) this.focusBlock(first.dataset.id, "start");
      else this.focusTitle();
    }

    /* Escape: remember where the cursor is, then hand the focus to the page
       list. False when there is no page list to go to (the caller then does
       what Escape did before). */
    leaveToPages(where) {
      lastFocus.set(this.pageId, where);
      return Boolean(App.shell && App.shell.focusPages && App.shell.focusPages());
    }

    focusTitle() {
      this.titleEl.focus();
      if (this.titleEl.firstChild) {
        const r = document.createRange();
        r.selectNodeContents(this.titleEl);
        r.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }

    selectBlocks(ids, opts = {}) {
      this.clearSelection();
      ids = [...new Set(ids.map((id) => this.selectable(id)))];
      for (const id of ids) {
        const el = this.els.get(id);
        if (!el) continue;
        this.selected.add(id);
        el.classList.add("is-selected");
      }
      this.selAnchor = opts.anchor || ids[0] || null;
      this.selHead = opts.head || ids[ids.length - 1] || null;
      if (!this.selected.size) return;
      if (document.activeElement !== this.root) this.root.focus({ preventScroll: true });
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      const head = this.els.get(this.selHead);
      if (head) this.reveal(head);
    }

    clearSelection() {
      for (const id of this.selected) {
        const el = this.els.get(id);
        if (el) el.classList.remove("is-selected");
      }
      this.selected.clear();
    }

    selectedIds() { return this.topLevel([...this.selected]); }

    setOpen(el, open) {
      storeOpen(el.dataset.id, open);
      el.classList.toggle("is-open", open);
      el.classList.toggle("is-collapsed", !open);
      const btn = el._row && el._row.querySelector(".toggle-btn");
      if (btn) btn.setAttribute("aria-expanded", String(open));
    }

    scrollToBlock(id) {
      const el = this.els.get(id);
      if (!el) return false;
      this.openAncestors(el);
      el.scrollIntoView({ block: "center" });
      el.classList.remove("is-flash");
      void el.offsetWidth; // restart the animation
      el.classList.add("is-flash");
      setTimeout(() => el.classList.remove("is-flash"), 1600);
      return true;
    }

    // --- structural edits ------------------------------------------------------------
    /* Every structural edit runs through op(): pending text is saved first (so
       the edit sees what is on screen), the writes form one undo step, and the
       touched blocks are brought on screen right away rather than a microtask
       later, so the caret can be placed in them. */
    op(label, fn) {
      if (this.readOnly) return null;
      this.flushAll();
      const touched = new Set();
      const outer = this._touched;
      this._touched = touched;
      let result;
      try {
        result = App.store.group(label, fn);
      } finally {
        this._touched = outer;
      }
      if (outer) touched.forEach((id) => outer.add(id));
      else this.refresh(touched, { force: true });
      return result;
    }

    touch(id) { if (this._touched) this._touched.add(id); }

    create(opts) {
      const b = App.store.createBlock({ pageId: this.pageId, ...opts, props: opts.props || {} });
      this.touch(b.id);
      return b;
    }

    update(id, patch) {
      const b = App.store.updateBlock(id, patch);
      this.touch(id);
      return b;
    }

    move(id, opts) {
      App.store.moveBlock(id, opts);
      this.touch(id);
    }

    remove(id) {
      App.store.deleteBlock(id);
      this.touch(id);
    }

    insertTree(nodes, placement) {
      const created = App.store.insertTree(this.pageId, nodes, placement);
      created.forEach((b) => this.touch(b.id));
      return created;
    }

    // A block and its subtree as a node (App.store.insertTree's shape).
    nodeOf(id) {
      const b = App.store.block(id);
      if (!b) return null;
      return {
        type: b.type, text: b.text || "", props: clone(b.props) || {},
        children: App.store.childBlocks(id).map((c) => this.nodeOf(c.id)).filter(Boolean),
      };
    }

    // The props a block takes when it becomes `type`. Unknown props survive
    // (DESIGN §2); only the new kind's defaults are added.
    propsFor(props, type) {
      const p = { ...(props || {}) };
      if (type === "to_do") p.checked = Boolean(p.checked);
      if (type === "callout" && !p.icon) p.icon = "💡";
      if (type === "code" && !p.language) p.language = "plain";
      return p;
    }

    newProps(type) {
      return this.propsFor({}, type);
    }

    /* Enter in a text block. */
    split(el) {
      const id = el.dataset.id;
      const b = App.store.block(id);
      const t = el._text;
      if (!b || !t) return;
      const text = readText(t);
      const sel = caret.get(t) || { start: text.length, end: text.length };
      const before = text.slice(0, sel.start);
      const after = text.slice(sel.end);
      const type = b.type;
      const kids = App.store.childBlocks(id);

      // An empty list item (or quote, toggle, callout) ends the list: out one
      // level first when nested, then into a plain paragraph.
      if (!text && EXITS.has(type)) {
        if (!this.atTop(b)) this.outdent([id]);
        else this.op("Turn into text", () => this.update(id, { type: "paragraph", props: this.propsFor(b.props, "paragraph") }));
        this.focusBlock(id, 0);
        return;
      }
      // At the very start of a non-empty block: a new block opens above, and
      // this one (its id, its children) stays as it is.
      if (sel.start === 0 && sel.end === 0 && text) {
        const nt = CONTINUES.has(type) ? type : "paragraph";
        this.op("New block", () => this.create({ parentId: b.parent_id, before: id, type: nt, props: this.newProps(nt) }));
        this.focusBlock(id, 0);
        return;
      }
      let nt = CONTINUES.has(type) ? type : "paragraph";
      let place;
      const open = type === "toggle" && !this.collapsed(el);
      if (open) {
        // Inside an open toggle the next line is its first child.
        nt = "paragraph";
        place = { parentId: id, after: null };
      } else if (kids.length && type !== "toggle") {
        // A block with children: the new one goes right below, as the first
        // child, rather than after the whole subtree.
        place = { parentId: id, after: null };
      } else {
        place = { parentId: b.parent_id, after: id };
      }
      const created = this.op("New block", () => {
        if (before !== (b.text || "")) this.update(id, { text: before });
        return this.create({ ...place, type: nt, text: after, props: this.newProps(nt) });
      });
      if (created) this.focusBlock(created.id, 0);
    }

    // A new empty paragraph after the block (leaving a code block, a caption).
    exitBlock(el) {
      const b = App.store.block(el.dataset.id);
      if (!b) return;
      const c = this.op("New block", () => this.create({ parentId: b.parent_id, after: b.id, type: "paragraph" }));
      if (c) this.focusBlock(c.id, 0);
    }

    // Move a block's children to its own level, right after it, in order.
    promoteChildren(b) {
      let after = b.id;
      for (const k of App.store.childBlocks(b.id)) {
        this.move(k.id, { parentId: b.parent_id, after });
        after = k.id;
      }
    }

    /* Backspace with the caret at the start of a text block. */
    backspaceAtStart(el) {
      const id = el.dataset.id;
      const b = App.store.block(id);
      const t = el._text;
      if (!b || !t) return;
      const text = readText(t);
      if (b.type === "code" || b.type === "equation") {
        if (!text) {
          this.op("Turn into text", () => this.update(id, { type: "paragraph", props: this.propsFor(b.props, "paragraph") }));
          this.focusBlock(id, 0);
        }
        return;
      }
      if (b.type !== "paragraph") {
        this.op("Turn into text", () => this.update(id, { type: "paragraph", props: this.propsFor(b.props, "paragraph") }));
        this.focusBlock(id, 0);
        return;
      }
      if (!this.atTop(b)) {
        this.outdent([id]);
        this.focusBlock(id, 0);
        return;
      }
      const prev = this.prevVisible(el);
      if (!prev) return;
      if (this.enclosingCell(prev) !== this.enclosingCell(el)) {
        // The block above is across a cell's edge, and merges stop there.
        let sib = el.previousElementSibling;
        while (sib && !sib.dataset.id) sib = sib.previousElementSibling;
        const kids = App.store.childBlocks(id).length;
        if (sib) {
          // A grid right above: selected, as an image would be.
          if (!text && !kids) this.op("Delete", () => this.remove(id));
          this.selectBlocks([sib.dataset.id]);
        } else if (!text && !kids && this.nextVisible(el) && this.enclosingCell(this.nextVisible(el)) === this.enclosingCell(el)) {
          // The first line of a cell, empty, with more below it: it goes.
          const next = this.nextVisible(el);
          this.op("Delete", () => this.remove(id));
          if (this.isTextTarget(next)) this.focusBlock(next.dataset.id, "start");
          else this.selectBlocks([next.dataset.id]);
        }
        return;
      }
      const pb = App.store.block(prev.dataset.id);
      if (this.isTextTarget(prev)) {
        const ptext = readText(prev._text);
        this.op("Merge", () => {
          this.update(pb.id, { text: ptext + text });
          this.promoteChildren(b);
          this.remove(id);
        });
        this.focusBlock(pb.id, ptext.length);
      } else {
        // An image, a divider: select it rather than merge into it. An empty
        // paragraph in front of it goes away on the way.
        if (!text && !App.store.childBlocks(id).length) this.op("Delete", () => this.remove(id));
        this.selectBlocks([pb.id]);
      }
    }

    /* Delete with the caret at the end: the next block's text joins this one. */
    deleteAtEnd(el) {
      const next = this.nextVisible(el);
      if (!next || !this.isTextTarget(next) || this.enclosingCell(next) !== this.enclosingCell(el)) return;
      const id = el.dataset.id;
      const nb = App.store.block(next.dataset.id);
      const text = readText(el._text);
      const ntext = readText(next._text);
      this.op("Merge", () => {
        this.update(id, { text: text + ntext });
        this.promoteChildren(nb);
        this.remove(nb.id);
      });
      this.focusBlock(id, text.length);
    }

    /* Tab: each block goes under its previous sibling, as its last child. */
    indent(ids) {
      ids = this.topLevel(ids);
      this.op("Indent", () => {
        for (const id of ids) {
          const b = App.store.block(id);
          const sibs = this.siblingsOf(b);
          const i = sibs.findIndex((x) => x.id === id);
          if (i <= 0) continue;
          const prev = sibs[i - 1];
          // Nothing goes into a grid but its cells, which stay where they are.
          if (this.inGrid(b) || prev.type === "grid") continue;
          this.move(id, { parentId: prev.id });
          const pel = this.els.get(prev.id);
          if (pel && prev.type === "toggle" && this.collapsed(pel)) this.setOpen(pel, true);
        }
      });
    }

    /* Shift+Tab: out one level, after the parent. The siblings that followed
       come along as children, so the reading order never changes. Done from
       the last block up, so a run of selected siblings keeps its order. */
    outdent(ids) {
      ids = this.topLevel(ids).filter((id) => this.canLeaveParent(App.store.block(id)));
      if (!ids.length) return;
      this.op("Outdent", () => {
        for (const id of [...ids].reverse()) {
          const b = App.store.block(id);
          if (!b || !b.parent_id) continue;
          const parent = App.store.block(b.parent_id);
          const sibs = App.store.childBlocks(parent.id);
          const i = sibs.findIndex((x) => x.id === id);
          for (const f of sibs.slice(i + 1)) this.move(f.id, { parentId: id });
          this.move(id, { parentId: parent.parent_id, after: parent.id });
        }
      });
    }

    /* Ctrl/Cmd+Shift+Up/Down: past the neighbouring sibling, or out of the
       parent at the edge of its children. */
    moveBy(ids, dir) {
      ids = this.topLevel(ids).filter((id) => !this.inGrid(App.store.block(id)));
      if (!ids.length) return;
      const first = App.store.block(ids[0]);
      ids = ids.filter((id) => (App.store.block(id).parent_id || null) === (first.parent_id || null));
      const sibs = this.siblingsOf(first);
      const lo = sibs.findIndex((x) => x.id === ids[0]);
      const hi = sibs.findIndex((x) => x.id === ids[ids.length - 1]);
      // At the edge of a cell the blocks stay in it.
      const parent = this.canLeaveParent(first) ? App.store.block(first.parent_id) : null;
      this.op("Move", () => {
        if (dir < 0) {
          if (lo > 0) ids.forEach((id) => this.move(id, { parentId: first.parent_id, before: sibs[lo - 1].id }));
          else if (parent) ids.forEach((id) => this.move(id, { parentId: parent.parent_id, before: parent.id }));
        } else if (hi < sibs.length - 1) {
          [...ids].reverse().forEach((id) => this.move(id, { parentId: first.parent_id, after: sibs[hi + 1].id }));
        } else if (parent) {
          [...ids].reverse().forEach((id) => this.move(id, { parentId: parent.parent_id, after: parent.id }));
        }
      });
    }

    duplicate(ids) {
      ids = this.topLevel(ids);
      const created = this.op("Duplicate", () => ids.map((id) => {
        const b = App.store.block(id);
        return this.insertTree([this.nodeOf(id)], { parentId: b.parent_id, after: id })[0];
      }));
      return created || [];
    }

    deleteBlocks(ids) {
      ids = this.topLevel(ids);
      if (!ids.length) return;
      const firstEl = this.els.get(ids[0]);
      const lastEl = this.els.get(ids[ids.length - 1]);
      let land = firstEl ? this.prevVisible(firstEl) : null;
      while (land && ids.some((id) => { const e = this.els.get(id); return e && e.contains(land); })) land = this.prevVisible(land);
      let after = lastEl ? this.nextVisible(lastEl) : null;
      while (after && ids.some((id) => { const e = this.els.get(id); return e && e.contains(after); })) after = this.nextVisible(after);
      this.clearSelection();
      this.op("Delete", () => ids.forEach((id) => this.remove(id)));
      const target = (land && land.isConnected && land) || (after && after.isConnected && after);
      if (target) {
        if (this.isTextTarget(target)) this.focusBlock(target.dataset.id, target === land ? "end" : "start");
        else this.selectBlocks([target.dataset.id]);
      } else {
        this.root.focus({ preventScroll: true });
      }
    }

    turnInto(ids, type) {
      ids = this.topLevel(ids);
      if (type === "page") { if (ids.length) this.turnIntoPage(ids[0]); return; }
      const el = ids.length === 1 ? this.els.get(ids[0]) : null;
      const sel = el && el._text && document.activeElement === el._text ? caret.get(el._text) : null;
      this.op("Turn into", () => {
        for (const id of ids) {
          const b = App.store.block(id);
          if (!b || !TEXT.has(b.type) || b.type === type) continue;
          this.update(id, { type, props: this.propsFor(b.props, type) });
          if (type === "toggle") { const e = this.els.get(id); if (e) storeOpen(id, true); }
        }
      });
      if (el && sel) this.focusBlock(ids[0], sel.start);
      else if (ids.length) this.selectBlocks(ids);
    }

    // A block becomes a sub-page: its words the title, its children the
    // content, and a link to the new page in its place.
    turnIntoPage(id) {
      const b = App.store.block(id);
      if (!b) return;
      const page = this.op("Turn into page", () => {
        const p = App.store.createPage({ parentId: this.pageId, title: App.markdown.plain(b.text || "").replace(/\n/g, " ").trim() });
        App.store.childBlocks(id).forEach((k) => this.move(k.id, { pageId: p.id, parentId: null }));
        this.update(id, { type: "page", text: "", props: { page_id: p.id } });
        return p;
      });
      if (page) this.selectBlocks([id]);
    }

    setColor(ids, color) {
      ids = this.topLevel(ids);
      this.op("Color", () => {
        for (const id of ids) {
          const b = App.store.block(id);
          if (!b) continue;
          const props = { ...(b.props || {}) };
          if (color) props.color = color; else delete props.color;
          this.update(id, { props });
        }
      });
    }

    setProps(id, patch) {
      const b = App.store.block(id);
      if (!b) return;
      this.op("Edit block", () => this.update(id, { props: { ...(b.props || {}), ...patch } }));
    }

    toggleCheck(el) {
      const b = App.store.block(el.dataset.id);
      if (!b || this.readOnly) return;
      this.setProps(b.id, { checked: !(b.props && b.props.checked) });
    }

    // Save what a block's editable now shows, at once.
    commitText(el, text) {
      const b = App.store.block(el.dataset.id);
      el._b.text = text;
      if (b && !b.deleted && (b.text || "") !== text && !this.readOnly) App.store.updateBlock(b.id, { text });
    }

    /* Replace the selection in a block with text, as one saved edit. */
    insertText(el, str) {
      const t = el._text;
      if (!t) return;
      const text = readText(t);
      const sel = caret.get(t) || { start: text.length, end: text.length };
      const next = text.slice(0, sel.start) + str + text.slice(sel.end);
      this.setText(el, next, sel.start + str.length);
      this.commitText(el, next);
    }

    // Rewrite a block's whole text (formatting shortcuts, links), keeping a
    // selection, as one saved edit.
    replaceText(el, next, start, end = start) {
      const t = el._text;
      if (!t) return;
      this.setText(el, next);
      if (document.activeElement !== t) t.focus({ preventScroll: true });
      caret.set(t, Math.min(start, next.length), Math.min(end, next.length));
      this.commitText(el, next);
    }

    /* Paste of whole blocks at the caret. One plain paragraph is only text and
       goes in at the caret; anything else splits the block around the caret
       with the new blocks in between, all one undo step. */
    insertNodes(el, nodes) {
      nodes = (nodes || []).filter(Boolean);
      if (!nodes.length) return;
      const t = el._text;
      const b = App.store.block(el.dataset.id);
      if (!b) return;
      if (nodes.length === 1 && nodes[0].type === "paragraph" && !(nodes[0].children || []).length && t && TEXT.has(b.type)) {
        this.insertText(el, nodes[0].text || "");
        return;
      }
      const text = t && TEXT.has(b.type) ? readText(t) : "";
      const sel = t && TEXT.has(b.type) ? caret.get(t) || { start: text.length, end: text.length } : { start: 0, end: 0 };
      const before = text.slice(0, sel.start);
      const after = text.slice(sel.end);
      let created = [];
      this.op("Paste", () => {
        const kids = App.store.childBlocks(b.id).length;
        if (TEXT.has(b.type) && !before && !after && !kids && b.type === "paragraph") {
          created = this.insertTree(nodes, { parentId: b.parent_id, after: b.id });
          this.remove(b.id);
        } else if (TEXT.has(b.type) && !before && after) {
          created = this.insertTree(nodes, { parentId: b.parent_id, before: b.id });
          if (text !== (b.text || "")) this.update(b.id, { text });
        } else {
          if (TEXT.has(b.type) && before !== (b.text || "")) this.update(b.id, { text: before });
          created = this.insertTree(nodes, { parentId: b.parent_id, after: b.id });
          if (after) {
            const nt = CONTINUES.has(b.type) ? b.type : "paragraph";
            created.push(this.create({ parentId: b.parent_id, after: created[created.length - 1].id, type: nt, text: after, props: this.newProps(nt) }));
          }
        }
      });
      const lastNew = created.length ? created[created.length - 1] : null;
      if (!lastNew) return;
      const landEl = this.els.get(lastNew.id);
      if (after && created.length) this.focusBlock(lastNew.id, "start");
      else if (landEl && this.isTextTarget(landEl)) this.focusBlock(lastNew.id, "end");
      else this.selectBlocks([lastNew.id]);
    }

    // Clicking below the last block: into a trailing empty paragraph, made if
    // the page does not end with one.
    focusTrailing() {
      this.flushAll(); // the last block's text as typed, not as last saved
      const rows = App.store.blocks(this.pageId);
      const last = rows[rows.length - 1];
      if (last && last.type === "paragraph" && !last.text && !App.store.childBlocks(last.id).length) {
        this.focusBlock(last.id, "start");
        return;
      }
      if (this.readOnly) return;
      const b = this.op("New block", () => this.create({ parentId: null, type: "paragraph" }));
      if (b) this.focusBlock(b.id, "start");
    }

    // --- Markdown mode -----------------------------------------------------------------
    /* The whole page as one Markdown document in meerail's editor. Switching
       back parses it and reconciles it with the blocks: blocks whose Markdown
       is unchanged keep their ids (so links to them, comments and history
       stay attached), changed ones are updated in place, and only what was
       really added or removed is created or deleted. The same reconcile runs
       whenever typing pauses, so other devices see the edits as they happen. */
    setMarkdownMode(on) {
      on = Boolean(on);
      if (on === Boolean(this.md) || this.readOnly && on) return;
      if (on) {
        this.flushAll();
        this.clearSelection();
        const nodes = App.mdblocks.nodesFromTree(App.store.blockTree(this.pageId));
        const text = App.mdblocks.toMarkdown(nodes);
        const el = h("div", "editor-md md-editor");
        el.contentEditable = "true";
        el.spellcheck = true;
        el.dataset.placeholder = "Write Markdown…";
        const ed = App.markdown.editor(el);
        ed.setText(text);
        this.md = { el, editor: ed, text, base: this.flatten(nodes), timer: null, stale: false };
        ed.onChange(() => {
          clearTimeout(this.md.timer);
          this.md.timer = setTimeout(() => { if (this.md) this.applyMarkdown(); }, 1200);
        });
        this.blocksEl.hidden = true;
        this.tailEl.hidden = true;
        this.blocksEl.before(el);
        this.root.classList.add("is-markdown");
        if (this.hideGutter) this.hideGutter();
        ed.focus(false);
      } else {
        clearTimeout(this.md.timer);
        this.applyMarkdown();
        this.md.el.remove();
        this.md = null;
        this.blocksEl.hidden = false;
        this.tailEl.hidden = false;
        this.root.classList.remove("is-markdown");
        this.renderAll();
      }
    }

    // Nodes in document order with their depth and parent index; `id` is set
    // for nodes that came from the store.
    flatten(nodes) {
      const out = [];
      const walk = (list, parent) => {
        for (const n of list) {
          const i = out.length;
          out.push({ node: n, id: n.id || null, parent, type: n.type, sig: App.mdblocks.blockMarkdown(n) });
          walk(n.children || [], i);
        }
      };
      walk(nodes, -1);
      return out;
    }

    applyMarkdown() {
      const md = this.md;
      if (!md) return;
      const text = md.editor.getText();
      if (text === md.text) return;
      md.text = text;
      const nodes = App.mdblocks.parse(text);
      md.base = this.reconcileNodes(nodes, md.base);
    }

    /* Write `nodes` (freshly parsed) over the page, given `base`, the flat
       snapshot the Markdown was made from. Returns the new snapshot.

       Matching is on each block's own Markdown (App.mdblocks.blockMarkdown),
       by longest common subsequence against the snapshot rather than against
       the store: a block the user did not touch is left exactly as the store
       has it now, even if someone else changed it in the meantime. Unmatched
       blocks between two matches pair up by type, in order, and are updated;
       what is left is created or deleted. */
    reconcileNodes(nodes, base) {
      const flat = this.flatten(nodes);
      const pairs = lcs(base.map((x) => x.sig), flat.map((x) => x.sig));
      const idFor = new Array(flat.length).fill(null);
      const changed = new Array(flat.length).fill(false);
      const usedBase = new Set();
      pairs.forEach(([i, j]) => { idFor[j] = base[i].id; usedBase.add(i); });
      // Pair the gaps: same type, in order.
      const anchors = [[-1, -1], ...pairs, [base.length, flat.length]];
      for (let k = 0; k + 1 < anchors.length; k++) {
        const [i0, j0] = anchors[k];
        const [i1, j1] = anchors[k + 1];
        let i = i0 + 1;
        for (let j = j0 + 1; j < j1; j++) {
          let m = i;
          while (m < i1 && (usedBase.has(m) || base[m].type !== flat[j].type)) m++;
          if (m < i1) { idFor[j] = base[m].id; changed[j] = true; usedBase.add(m); i = m + 1; }
        }
      }
      const pageId = this.pageId;
      const keep = new Set();
      const live = (id) => { const b = id && App.store.block(id); return b && !b.deleted && b.page_id === pageId ? b : null; };
      App.store.group("Edit as Markdown", () => {
        const walk = (list, parentId) => {
          const entries = list.map((n) => {
            const j = n._j;
            const cur = live(idFor[j]);
            return { n, j, cur, id: cur ? cur.id : null };
          });
          // Positions: keep the existing ones when they are already in order,
          // else number the list afresh.
          const kept = entries.filter((e) => e.cur && (e.cur.parent_id || null) === parentId);
          let ordered = true;
          for (let k = 1; k < kept.length; k++) if (!(kept[k].cur.position > kept[k - 1].cur.position)) ordered = false;
          const pos = new Array(entries.length);
          if (ordered) {
            let prev = null;
            for (let k = 0; k < entries.length; k++) {
              const e = entries[k];
              if (e.cur && (e.cur.parent_id || null) === parentId) { pos[k] = e.cur.position; prev = pos[k]; continue; }
              let next = null;
              for (let q = k + 1; q < entries.length; q++) {
                const f = entries[q];
                if (f.cur && (f.cur.parent_id || null) === parentId) { next = f.cur.position; break; }
              }
              const p = App.store.between(prev, next);
              if (p === null) { ordered = false; break; }
              pos[k] = p;
              prev = p;
            }
          }
          if (!ordered) entries.forEach((e, k) => { pos[k] = k + 1; });
          entries.forEach((e, k) => {
            const n = e.n;
            if (!e.cur) {
              const b = App.store.createBlock({ pageId, parentId, type: n.type, text: n.text || "", props: clone(n.props) || {} });
              App.store.updateBlock(b.id, { position: pos[k] });
              e.id = b.id;
            } else {
              const patch = {};
              if ((e.cur.parent_id || null) !== parentId) patch.parent_id = parentId;
              if (e.cur.position !== pos[k]) patch.position = pos[k];
              if (changed[e.j]) {
                if ((e.cur.text || "") !== (n.text || "")) patch.text = n.text || "";
                const props = { ...(e.cur.props || {}), ...(n.props || {}) };
                if (propsKey(props) !== propsKey(e.cur.props)) patch.props = props;
              }
              if (Object.keys(patch).length) App.store.updateBlock(e.id, patch);
            }
            keep.add(e.id);
            n.id = e.id;
            walk(n.children || [], e.id);
          });
        };
        flat.forEach((f, j) => { f.node._j = j; });
        walk(nodes, null);
        for (const x of base) {
          if (x.id && !keep.has(x.id) && live(x.id)) App.store.updateBlock(x.id, { deleted: true });
        }
      });
      flat.forEach((f) => { delete f.node._j; });
      return this.flatten(nodes);
    }

    // --- teardown -----------------------------------------------------------------------
    destroy() {
      if (this.destroyed) return;
      try {
        this.flushAll();
        if (this.md) { clearTimeout(this.md.timer); this.applyMarkdown(); }
      } catch (e) { console.error(e); }
      this.destroyed = true;
      this.offs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
      this.offs = [];
      for (const el of this.els.values()) { this.cleanup(el); clearTimeout(el._timer); }
      this.els.clear();
      if (this.menu && !this.menu.closed) this.menu.close();
      this.root.remove();
    }

    api() {
      return {
        el: this.root,
        pageId: this.pageId,
        destroy: () => this.destroy(),
        focusTitle: () => this.focusTitle(),
        focusBlock: (id, where) => this.focusBlock(id, where),
        focusDefault: () => this.focusDefault(),
        scrollToBlock: (id) => this.scrollToBlock(id),
        setMarkdownMode: (on) => this.setMarkdownMode(on),
        isMarkdownMode: () => Boolean(this.md),
        flush: () => this.flushAll(),
        _editor: this,
      };
    }
  }

  // --- longest common subsequence ----------------------------------------------------
  /* Pairs [i, j] of equal entries of a and b, in order. The common head and
     tail are matched first (an edit is usually in one place, which leaves the
     table small); a middle too large for the table falls back to matching
     each signature to its next occurrence. */
  function lcs(a, b) {
    const pairs = [];
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) { pairs.push([s, s]); s++; }
    let ea = a.length, eb = b.length;
    const tail = [];
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; tail.unshift([ea, eb]); }
    const n = ea - s, m = eb - s;
    if (n && m) {
      if (n * m <= 4e6 && n < 65535 && m < 65535) {
        const W = m + 1;
        const L = new Uint16Array((n + 1) * W);
        for (let i = n - 1; i >= 0; i--) {
          for (let j = m - 1; j >= 0; j--) {
            L[i * W + j] = a[s + i] === b[s + j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
          }
        }
        let i = 0, j = 0;
        while (i < n && j < m) {
          if (a[s + i] === b[s + j]) { pairs.push([s + i, s + j]); i++; j++; }
          else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
          else j++;
        }
      } else {
        const where = new Map();
        for (let i = s; i < ea; i++) { if (!where.has(a[i])) where.set(a[i], []); where.get(a[i]).push(i); }
        let last = s - 1;
        for (let j = s; j < eb; j++) {
          const list = where.get(b[j]);
          if (!list) continue;
          while (list.length && list[0] <= last) list.shift();
          if (list.length) { last = list.shift(); pairs.push([last, j]); }
        }
      }
    }
    return pairs.concat(tail);
  }

  // --- renderers for the text kinds ---------------------------------------------------
  const PH = {
    paragraph: "Press '/' for commands…",
    heading_1: "Heading 1", heading_2: "Heading 2", heading_3: "Heading 3",
    bulleted_list: "List", numbered_list: "List", to_do: "To-do", toggle: "Toggle",
    quote: "Empty quote", callout: "Type something…",
  };

  function textRow(ed, el, b, prefix) {
    const row = h("div");
    if (prefix) row.append(prefix);
    row.append(ed.textEl(el, b, { placeholder: PH[b.type] }));
    return row;
  }

  types.paragraph = { render: (ed, el, b) => ({ row: textRow(ed, el, b) }) };
  types.heading_1 = types.paragraph;
  types.heading_2 = types.paragraph;
  types.heading_3 = types.paragraph;

  types.bulleted_list = { render: (ed, el, b) => ({ row: textRow(ed, el, b, h("span", "blk-marker")) }) };
  types.numbered_list = types.bulleted_list;

  types.to_do = {
    render(ed, el, b) {
      const checked = Boolean(b.props && b.props.checked);
      el.classList.toggle("is-checked", checked);
      const box = h("span", "blk-check");
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-checked", String(checked));
      box.setAttribute("aria-label", checked ? "Done" : "Not done");
      if (ed.readOnly) box.setAttribute("aria-disabled", "true");
      else box.tabIndex = -1;
      box.innerHTML = App.icon("check", 12);
      const marker = h("span", "blk-marker");
      marker.append(box);
      return { row: textRow(ed, el, b, marker) };
    },
  };

  types.toggle = {
    render(ed, el, b) {
      const open = isOpen(b.id);
      el.classList.toggle("is-open", open);
      el.classList.toggle("is-collapsed", !open);
      const btn = h("span", "toggle-btn");
      btn.setAttribute("role", "button");
      btn.setAttribute("aria-label", "Show or hide the content");
      btn.setAttribute("aria-expanded", String(open));
      btn.innerHTML = App.icon("chevron-right", 16);
      const marker = h("span", "blk-marker");
      marker.append(btn);
      const hint = h("div", "toggle-empty", ed.readOnly ? "Empty toggle." : "Empty toggle. Click or drop blocks inside.");
      return { row: textRow(ed, el, b, marker), after: hint };
    },
  };

  types.quote = {
    render(ed, el, b) {
      const row = h("div");
      const box = h("div", "quote-box");
      box.append(ed.textEl(el, b, { placeholder: PH.quote }));
      row.append(box);
      return { row, kidsHost: box };
    },
  };

  types.callout = {
    render(ed, el, b) {
      const row = h("div");
      const box = h("div", "callout-box");
      const icon = h("span", "callout-icon", (b.props && b.props.icon) || "💡");
      icon.setAttribute("role", "button");
      icon.setAttribute("aria-label", "Change icon");
      const body = h("div", "callout-body");
      body.append(ed.textEl(el, b, { placeholder: PH.callout }));
      box.append(icon, body);
      row.append(box);
      return { row, kidsHost: body };
    },
  };

  types.divider = {
    render() {
      const row = h("div");
      row.append(h("hr", "blk-hr"));
      return { row };
    },
  };

  // A block type this client does not know (a newer client wrote it): shown,
  // its text readable, and left alone.
  types.unknown = {
    render(ed, el, b) {
      const row = h("div", "blk-unknown");
      row.append(h("span", "blk-unknown-tag", b.type), h("span", "blk-unknown-text", App.markdown.plain(b.text || "")));
      return { row };
    },
  };

  // Where the cursor was on each page when Escape went back to the page list:
  // pageId -> { id, offset } or { title: true }. For the session only.
  const lastFocus = new Map();

  function mount(host, opts = {}) {
    if (!host) throw new Error("App.editor.mount needs a host element");
    const readOnly = opts.readOnly === undefined ? App.store.isReadOnly() : Boolean(opts.readOnly || App.store.isReadOnly());
    const ed = new Editor(host, { ...opts, readOnly });
    if (opts.autofocus && !readOnly) {
      requestAnimationFrame(() => {
        if (ed.destroyed) return;
        const p = App.store.page(ed.pageId);
        if (!p || !p.title) ed.focusTitle();
        else {
          const first = ed.blocksEl.firstElementChild;
          if (first && first.dataset.id && ed.isTextTarget(first)) ed.focusBlock(first.dataset.id, "end");
          else ed.focusTitle();
        }
      });
    }
    return ed.api();
  }

  return {
    mount, Editor, types, KINDS, TEXT, LISTS, COLORS,
    caret, readText, h, norm, isOpen, storeOpen, colorClass, lcs,
  };
})();
