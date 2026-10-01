/* The editor's input: typing (live Markdown painting, the Markdown shortcuts,
   the `/` and `[[` triggers), the keyboard (Enter, Backspace, Tab, arrows,
   formatting, undo), paste, block selection (Escape, Shift+arrows, the
   rubber band, copy and cut), the gutter with its "+" and drag handle, and
   drag and drop (blocks by the handle, files from the desktop).

   Typing follows meerail's composer: the browser edits the DOM, and on every
   input the block's text is read back and repainted only if its markup
   changes, the caret put back by character offset. Everything structural
   (a new block, a merge, an indent) is a store edit instead (see op() in
   app.editor.js), never the browser's own idea of what Enter should do. */

(() => {
  const E = App.editor;
  const { h, caret, readText } = E;
  const P = E.Editor.prototype;

  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  // Cmd on a Mac, Ctrl elsewhere. Ctrl on a Mac is emacs keys in text fields
  // (Ctrl+A, Ctrl+E, Ctrl+K), which must keep working.
  const isMod = (e) => (MAC ? e.metaKey : e.ctrlKey);
  const hasFiles = (dt) => Boolean(dt && [...(dt.types || [])].includes("Files"));
  const LANG_ALIAS = { js: "javascript", ts: "typescript", py: "python", sh: "bash", zsh: "bash", yml: "yaml", md: "markdown", rb: "ruby", rs: "rust", "c++": "cpp", "c#": "csharp", cs: "csharp", kt: "kotlin", golang: "go", text: "plain", txt: "plain" };
  const SINGLE_URL = /^https?:\/\/[^\s<>"]+$/i;
  const BLOCK_SYNTAX = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\$\$|\s*([-*_])(\s*\2){2,}\s*$|\|.*\|\s*$|!\[[^\]]*\]\([^)]+\)\s*$|<(aside|details)\b)/;

  // --- wiring ---------------------------------------------------------------------------
  P.wireInput = function () {
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.offs.push(() => target.removeEventListener(type, fn, opts));
    };
    const blocks = this.blocksEl;
    const root = this.root;
    this.buildGutter();
    on(blocks, "keydown", (e) => this.onKeyDown(e));
    on(blocks, "beforeinput", (e) => this.onBeforeInput(e));
    on(blocks, "input", (e) => this.onInput(e, false));
    on(blocks, "compositionstart", () => { this.composing = true; });
    on(blocks, "compositionend", (e) => { this.composing = false; this.onInput(e, true); });
    on(blocks, "focusin", (e) => this.onFocusIn(e));
    on(blocks, "focusout", (e) => this.onFocusOut(e));
    // The dimmed markers show in the text being edited (editor.css, is-live).
    // For a click they appear once the press has placed the caret, not at
    // focus, which a browser does first: see onBlocksMouseDown.
    on(blocks, "focusin", (e) => {
      const t = e.target;
      if (t.classList && (t.classList.contains("blk-text") || t.classList.contains("tbl-cell")) && !this._pressing) t.classList.add("is-live");
    });
    on(blocks, "focusout", (e) => { if (e.target.classList) e.target.classList.remove("is-live"); });
    // Dragging selected text within the page. The browser would move the
    // DOM fragment itself, which drops the (hidden) Markdown markers and can
    // leave markup of its own behind; so the drag carries the source text and
    // the drop is done here, as one undoable edit (see onTextDrop).
    on(blocks, "dragstart", (e) => {
      const node = e.target && (e.target.nodeType === 3 ? e.target.parentElement : e.target);
      const t = node && node.closest ? node.closest(".blk-text") : null;
      const sel = t && caret.get(t);
      this._textDrag = null;
      if (!sel || sel.collapsed || !e.dataTransfer) return;
      const text = readText(t).slice(sel.start, sel.end);
      this._textDrag = { el: t.closest(".blk"), t, start: sel.start, end: sel.end, text };
      e.dataTransfer.setData("text/plain", text);
    });
    on(blocks, "dragend", () => { this._textDrag = null; });
    on(blocks, "drop", (e) => this.onTextDrop(e));
    on(blocks, "paste", (e) => this.onPaste(e));
    on(blocks, "mousedown", (e) => this.onBlocksMouseDown(e));
    on(blocks, "click", (e) => this.onBlocksClick(e));
    on(root, "keydown", (e) => this.onRootKeyDown(e));
    on(root, "copy", (e) => this.onCopy(e, false));
    on(root, "cut", (e) => this.onCopy(e, true));
    on(root, "paste", (e) => this.onRootPaste(e));
    on(root, "mousedown", (e) => this.onRootMouseDown(e));
    on(root, "mousemove", (e) => this.onHover(e));
    on(root, "mouseleave", () => this.hideGutterSoon());
    on(root, "dragover", (e) => this.onDragOver(e));
    on(root, "dragleave", (e) => this.onDragLeave(e));
    on(root, "drop", (e) => this.onDrop(e));
    on(this.tailEl, "mousedown", (e) => {
      if (e.button !== 0 || this.readOnly) return;
      e.preventDefault();
      this.focusTrailing();
    });
    on(this.titleEl, "keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter") this.clearSelection();
      if (e.key === "Escape" && this.leaveToPages({ title: true })) { e.preventDefault(); e.stopPropagation(); }
    });
    if (this.wireTables) this.wireTables();
  };

  const textTarget = (e) => (e.target && e.target.classList && e.target.classList.contains("blk-text") ? e.target : null);

  // --- focus ------------------------------------------------------------------------------
  P.onFocusIn = function (e) {
    const t = textTarget(e);
    if (!t) return;
    const el = t.closest(".blk");
    if (!el) return;
    this.clearSelection();
    el.classList.add("is-focused");
    const role = t.dataset.role;
    if (el._edit && (role === "equation" || (role === "code" && el.classList.contains("is-mermaid")))) el._edit(true);
    if (role === "caption") el.classList.add("is-captioning");
    if (this.gutter && window.matchMedia && matchMedia("(max-width: 700px)").matches) {
      this.gutter.classList.add("is-touch");
      this.showGutter(el, true);
    }
  };

  P.onFocusOut = function (e) {
    const t = textTarget(e);
    if (!t) return;
    const el = t.closest(".blk");
    if (!el) return;
    if (this.slash && this.slash.el === el) this.slash.handle.close();
    el.classList.remove("is-focused");
    if (el._deferred || el._stale) this.applyDeferred(el);
    else this.saveText(el);
    if (!el.isConnected) return;
    const role = t.dataset.role;
    if (el._edit && (role === "equation" || role === "code") && !el.contains(e.relatedTarget)) el._edit(false);
    if (role === "caption" && el._text) {
      const has = Boolean(readText(el._text));
      el.classList.toggle("has-caption", has);
      if (!has) el.classList.remove("is-captioning");
    }
  };

  // --- typing -------------------------------------------------------------------------------
  P.onBeforeInput = function (e) {
    const t = textTarget(e);
    if (!t || this.readOnly) return;
    switch (e.inputType) {
      case "historyUndo": e.preventDefault(); this.undo(false); break;
      case "historyRedo": e.preventDefault(); this.undo(true); break;
      // Enter reaches here only where keydown did not see it (a phone's
      // keyboard, an IME): the same handling either way.
      case "insertParagraph": e.preventDefault(); this.handleEnter(t, false); break;
      case "insertLineBreak": e.preventDefault(); this.handleEnter(t, true); break;
      case "formatBold": case "formatItalic": case "formatUnderline": case "formatStrikeThrough":
        e.preventDefault(); break;
      default: break;
    }
  };

  P.onInput = function (e, fromComposition) {
    const t = textTarget(e);
    if (!t || this.readOnly) return;
    if ((this.composing || e.isComposing) && !fromComposition) return;
    const el = t.closest(".blk");
    if (!el) return;
    const text = readText(t);
    const sel = caret.get(t);
    const off = sel ? sel.end : text.length;
    const role = t.dataset.role;
    const prose = !t._plain && role !== "caption";
    if (prose && e.inputType === "insertText" && this.shortcut(el, t, text, off, e.data)) return;
    this.repaint(t, text, sel);
    this.markDirty(el);
    if (el._preview) el._preview();
    if (this.pasteMenu && !this.pasteMenu.closed) this.pasteMenu.close();
    if (prose) this.triggers(el, t, text, off, e);
  };

  // `/` opens the slash menu at a block start or after a space; `[[` the page
  // picker. While the slash menu is open, every input refilters it.
  P.triggers = function (el, t, text, off, e) {
    if (this.slash) this.updateSlash(el, text, off);
    const data = e.data || "";
    const typed = e.inputType === "insertText" || e.type === "compositionend";
    if (!typed) return;
    if (data.endsWith("/") && !this.slash) {
      const at = off - 1;
      if (text[at] === "/" && (at === 0 || /\s/.test(text[at - 1]))) this.openSlash(el, at);
    }
    if (data.endsWith("[") && text.slice(off - 2, off) === "[[") this.openPageLinkPicker(el, off - 2);
  };

  /* The Markdown shortcuts, at the start of a paragraph, when the space after
     the marker is typed. Inline Markdown is never converted: it stays source,
     live-previewed. */
  P.shortcut = function (el, t, text, off, data) {
    const b = App.store.block(el.dataset.id);
    if (!b || b.type !== "paragraph") return false;
    const id = b.id;
    if (data === "-" && text === "---" && off === 3) {
      this.forgetTyping(el);
      const p = this.op("Divider", () => {
        this.update(id, { type: "divider", text: "", props: { ...(b.props || {}) } });
        return this.create({ parentId: b.parent_id, after: id, type: "paragraph" });
      });
      if (p) this.focusBlock(p.id, 0);
      return true;
    }
    if (data !== " ") return false;
    const head = text.slice(0, off);
    const rest = text.slice(off);
    let type = null;
    const extra = {};
    if (head === "# ") type = "heading_1";
    else if (head === "## ") type = "heading_2";
    else if (head === "### ") type = "heading_3";
    else if (/^[-*+] $/.test(head)) type = "bulleted_list";
    else if (/^\d{1,3}[.)] $/.test(head)) type = "numbered_list";
    else if (/^\[[ xX]?\] $/.test(head)) { type = "to_do"; extra.checked = /x/i.test(head); }
    else if (head === "> ") type = "quote";
    else if (head === ">> ") type = "toggle";
    else if (head === "!> ") type = "callout";
    if (!type) return false;
    this.forgetTyping(el);
    if (type === "toggle") E.storeOpen(id, true);
    if (this.slash) this.slash.handle.close();
    this.op("Turn into", () => this.update(id, { type, text: rest, props: { ...this.propsFor(b.props, type), ...extra } }));
    this.focusBlock(id, 0);
    return true;
  };

  // The edit that follows writes the block's text itself.
  P.forgetTyping = function (el) {
    clearTimeout(el._timer);
    el._dirty = false;
    this.dirty.delete(el);
  };

  // Text typed by a key handler (a soft break, a newline in code): painted
  // and saved like typing.
  P.typeText = function (el, t, str) {
    const text = readText(t);
    const sel = caret.get(t) || { start: text.length, end: text.length };
    const next = text.slice(0, sel.start) + str + text.slice(sel.end);
    t.innerHTML = this.htmlFor(t, next);
    caret.set(t, sel.start + str.length);
    this.markDirty(el);
    if (el._preview) el._preview();
  };

  P.undo = function (redo) {
    if (this.readOnly) return;
    if (App.ui && App.ui.closeAll) App.ui.closeAll();
    this.flushAll();
    if (redo) App.store.redo(); else App.store.undo();
  };

  /* **bold**, *italic*, `code`, ~~strike~~, ==highlight== around the
     selection: added, or taken away when it is already there. Whitespace at
     the edges of the selection stays outside, where the markers need it. */
  P.toggleMark = function (el, t, m) {
    const text = readText(t);
    const sel = caret.get(t);
    if (!sel) return;
    let { start, end } = sel;
    const inner = text.slice(start, end);
    const L = m.length;
    let next;
    if (text.slice(start - L, start) === m && text.slice(end, end + L) === m && !(m === "*" && (text[start - L - 1] === "*" || text[end + L] === "*"))) {
      next = text.slice(0, start - L) + inner + text.slice(end + L);
      start -= L; end -= L;
    } else if (inner.length >= 2 * L && inner.startsWith(m) && inner.endsWith(m)) {
      next = text.slice(0, start) + inner.slice(L, inner.length - L) + text.slice(end);
      end -= 2 * L;
    } else {
      const lead = /^\s*/.exec(inner)[0].length;
      const trail = inner.length - lead > 0 ? /\s*$/.exec(inner)[0].length : 0;
      const s = start + lead;
      const f = end - trail;
      next = text.slice(0, s) + m + text.slice(s, f) + m + text.slice(f);
      start = s + L;
      end = f + L;
    }
    this.replaceText(el, next, start, end);
  };

  // --- keyboard in a block -------------------------------------------------------------------
  P.onKeyDown = function (e) {
    const t = textTarget(e);
    if (!t || this.readOnly) return;
    const el = t.closest(".blk");
    if (!el) return;
    const key = e.key;
    const m = isMod(e);
    const role = t.dataset.role || "text";

    // An IME's own Enter (confirming a composition) is not ours.
    if (e.isComposing || e.keyCode === 229) return;

    // A menu opened while typing takes the arrows and Enter; the caret stays.
    const menu = this.slash ? this.slash.handle : (this.pasteMenu && !this.pasteMenu.closed ? this.pasteMenu : null);
    if (menu && !menu.closed) {
      if (key === "ArrowUp" || key === "ArrowDown" || key === "Enter" || (key === "Tab" && this.slash)) {
        e.preventDefault();
        e.stopPropagation();
        menu.key(key === "Tab" ? new KeyboardEvent("keydown", { key: e.shiftKey ? "ArrowUp" : "ArrowDown" }) : e);
        return;
      }
      // Escape closes the menu and leaves the typed text (App.ui does the
      // same, but only from the next tick on).
      if (key === "Escape") { e.preventDefault(); e.stopPropagation(); menu.close(); return; }
      if (menu === this.pasteMenu && !["Shift", "Control", "Meta", "Alt"].includes(key)) this.pasteMenu.close();
    }

    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    const lower = key.length === 1 ? key.toLowerCase() : key;

    if (m && !e.altKey && lower === "z") { stop(); this.undo(e.shiftKey); return; }
    if (m && !e.altKey && lower === "y" && !e.shiftKey) { stop(); this.undo(true); return; }

    if (m && !e.altKey && !t._plain) {
      let mark = null;
      if (!e.shiftKey) mark = { b: "**", i: "*", e: "`" }[lower] || null;
      else mark = { s: "~~", x: "~~", h: "==" }[lower] || null;
      if (mark) { stop(); this.toggleMark(el, t, mark); return; }
      if (lower === "k" && !e.shiftKey) { stop(); this.openLinkPopover(el); return; }
    }
    if (m && !e.shiftKey && !e.altKey && lower === "d") {
      stop();
      const sel = caret.get(t);
      const [copy] = this.duplicate([el.dataset.id]);
      if (copy) this.focusBlock(copy.id, sel ? sel.start : "end");
      return;
    }
    if (m && e.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
      stop();
      const sel = caret.get(t);
      const id = el.dataset.id;
      this.moveBy([id], key === "ArrowUp" ? -1 : 1);
      this.focusBlock(id, sel ? sel.start : "end");
      return;
    }
    if (m && !e.shiftKey && !e.altKey && lower === "a") {
      stop();
      const len = readText(t).length;
      const sel = caret.get(t);
      if (sel && sel.start === 0 && sel.end === len) this.selectAll();
      else caret.set(t, 0, len);
      return;
    }
    if (m && key === "Enter") {
      stop();
      if (role !== "text") this.leaveBlock(el);
      else if (el._b.type === "to_do") this.toggleCheck(el);
      else if (el._b.type === "toggle") this.setOpen(el, this.collapsed(el));
      return;
    }
    if (key === "Escape") {
      // Back to the page list (keyboard navigation: Enter came in, Escape goes
      // out). Blocks are selected with Shift+ArrowUp/Down at a block's edge.
      stop();
      this.saveText(el);
      const sel = caret.get(t);
      if (!this.leaveToPages({ id: el.dataset.id, offset: sel ? sel.start : 0 })) this.selectBlocks([el.dataset.id]);
      return;
    }

    if (key === "Enter" && !e.altKey) {
      stop();
      this.handleEnter(t, e.shiftKey);
      return;
    }

    if (key === "Tab" && !m && !e.altKey) {
      stop();
      if (role === "code") { this.codeTab(el, t, e.shiftKey); return; }
      if (role !== "text") return;
      const sel = caret.get(t);
      const id = el.dataset.id;
      if (e.shiftKey) this.outdent([id]); else this.indent([id]);
      this.focusBlock(id, sel ? sel.start : "end");
      return;
    }

    if (key === "Backspace" && !m && !e.altKey) {
      const sel = caret.get(t);
      if (sel && sel.collapsed && sel.start === 0) {
        stop();
        if (role === "caption") return;
        if (this.slash) this.slash.handle.close();
        this.backspaceAtStart(el);
      }
      return;
    }
    if (key === "Delete" && !m && !e.altKey) {
      const sel = caret.get(t);
      if (sel && sel.collapsed && sel.end === readText(t).length) {
        stop();
        if (role === "text" || role === "code") this.deleteAtEnd(el);
      }
      return;
    }

    if ((key === "ArrowUp" || key === "ArrowDown") && !m && !e.altKey) {
      const sel = caret.get(t);
      if (!sel) return;
      const up = key === "ArrowUp";
      const info = this.lineInfo(t);
      if (e.shiftKey) {
        const len = readText(t).length;
        if ((up && info.first && sel.start === 0) || (!up && info.last && sel.end === len)) {
          stop();
          this.saveText(el);
          this.selectBlocks([el.dataset.id]);
        }
        return;
      }
      if (!sel.collapsed || role === "caption") return;
      if (up && info.first) {
        const prev = this.prevText(el);
        stop();
        if (prev) this.focusAtX(prev, info.x, "last");
        else this.focusTitle();
      } else if (!up && info.last) {
        const next = this.nextText(el);
        if (next) { stop(); this.focusAtX(next, info.x, "first"); }
      }
      return;
    }
    if ((key === "ArrowLeft" || key === "ArrowRight") && !m && !e.altKey && !e.shiftKey && role !== "caption") {
      const sel = caret.get(t);
      if (!sel || !sel.collapsed) return;
      if (key === "ArrowLeft" && sel.start === 0) {
        const prev = this.prevText(el);
        if (prev) { stop(); this.focusBlock(prev.dataset.id, "end"); }
      } else if (key === "ArrowRight" && sel.end === readText(t).length) {
        const next = this.nextText(el);
        if (next) { stop(); this.focusBlock(next.dataset.id, "start"); }
      }
    }
  };

  /* Enter and Shift+Enter, by kind of text:
       prose    Enter splits (see split()), Shift+Enter is a soft break;
       code     Enter is a newline keeping the indentation, Shift+Enter leaves;
       equation Enter finishes, Shift+Enter is a newline;
       caption  Enter continues below the block, Shift+Enter a soft break. */
  P.handleEnter = function (t, shift) {
    const el = t.closest(".blk");
    if (!el || this.readOnly) return;
    const role = t.dataset.role || "text";
    if (this.slash) { this.slash.handle.key(new KeyboardEvent("keydown", { key: "Enter" })); return; }
    if (role === "code") {
      if (shift) { this.leaveBlock(el); return; }
      const text = readText(t);
      const sel = caret.get(t) || { start: text.length, end: text.length };
      const lineStart = text.lastIndexOf("\n", sel.start - 1) + 1;
      const indent = /^[ \t]*/.exec(text.slice(lineStart, sel.start))[0];
      this.typeText(el, t, `\n${indent}`);
      return;
    }
    if (role === "equation") {
      if (shift) { this.typeText(el, t, "\n"); return; }
      this.saveText(el);
      if (el._edit) el._edit(false);
      this.selectBlocks([el.dataset.id]);
      return;
    }
    if (role === "caption") {
      if (shift) { this.typeText(el, t, "\n"); return; }
      this.leaveBlock(el);
      return;
    }
    if (shift) { this.typeText(el, t, "\n"); return; }
    // ``` (with a language, maybe) and Enter: a code block.
    const b = App.store.block(el.dataset.id);
    const fence = b && b.type === "paragraph" && /^(```|~~~)\s*([\w+#.-]*)\s*$/.exec(readText(t));
    if (fence) {
      let lang = (fence[2] || "plain").toLowerCase();
      lang = LANG_ALIAS[lang] || lang;
      this.forgetTyping(el);
      this.op("Code", () => this.update(b.id, { type: "code", text: "", props: { ...(b.props || {}), language: lang } }));
      this.focusBlock(b.id, 0);
      return;
    }
    this.split(el);
  };

  P.leaveBlock = function (el) {
    this.saveText(el);
    if (el._edit) el._edit(false);
    this.exitBlock(el);
  };

  // Tab in code: two spaces, or the selected lines in (and out with Shift).
  P.codeTab = function (el, t, out) {
    const text = readText(t);
    const sel = caret.get(t) || { start: text.length, end: text.length };
    if (!out && sel.collapsed) { this.typeText(el, t, "  "); return; }
    const a = text.lastIndexOf("\n", sel.start - 1) + 1;
    const lines = text.slice(a, sel.end).split("\n");
    let delta0 = 0, delta = 0;
    const changed = lines.map((l, i) => {
      if (!out) { delta += 2; if (i === 0) delta0 = 2; return `  ${l}`; }
      const n = l.startsWith("  ") ? 2 : l.startsWith(" ") || l.startsWith("\t") ? 1 : 0;
      delta -= n;
      if (i === 0) delta0 = -n;
      return l.slice(n);
    });
    const next = text.slice(0, a) + changed.join("\n") + text.slice(sel.end);
    t.innerHTML = this.htmlFor(t, next);
    caret.set(t, Math.max(a, sel.start + delta0), Math.max(a, sel.end + delta));
    this.markDirty(el);
  };

  // Where the caret sits in its block, for crossing into the next block.
  P.lineInfo = function (t) {
    const cs = getComputedStyle(t);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.5;
    const box = t.getBoundingClientRect();
    const top = box.top + (parseFloat(cs.paddingTop) || 0);
    const bottom = box.bottom - (parseFloat(cs.paddingBottom) || 0);
    const r = caret.rect();
    if (!r || (!r.height && !r.top)) return { first: true, last: true, x: box.left };
    return { first: r.top - top < lh * 0.7, last: bottom - r.bottom < lh * 0.7, x: r.left };
  };

  // Into a block on its first or last line, at the same x (the column the
  // caret came from), the way a text editor moves between lines.
  P.focusAtX = function (el, x, which) {
    const t = this.editableOf(el);
    if (!t) { this.selectBlocks([el.dataset.id]); return; }
    this.clearSelection();
    t.focus({ preventScroll: true });
    this.reveal(el);
    const cs = getComputedStyle(t);
    const lh = parseFloat(cs.lineHeight) || 24;
    const box = t.getBoundingClientRect();
    const y = which === "last"
      ? box.bottom - (parseFloat(cs.paddingBottom) || 0) - lh / 2
      : box.top + (parseFloat(cs.paddingTop) || 0) + lh / 2;
    const pos = x == null ? null : caret.fromPoint(Math.max(box.left + 1, Math.min(x, box.right - 1)), y);
    if (pos && t.contains(pos.node)) {
      const sel = window.getSelection();
      sel.collapse(pos.node, pos.offset);
    } else {
      caret.set(t, which === "last" ? readText(t).length : 0);
    }
  };

  P.onTextDrop = function (e) {
    const dt = e.dataTransfer;
    if (this.readOnly || !dt || hasFiles(dt)) return;
    const node = e.target && (e.target.nodeType === 3 ? e.target.parentElement : e.target);
    const t = node && node.closest ? node.closest(".blk-text") : null;
    const src = this._textDrag;
    this._textDrag = null;
    if (!t) { if (src) e.preventDefault(); return; }
    const data = (dt.getData("text/plain") || "").replace(/\r\n?/g, "\n");
    if (!data) return;
    e.preventDefault();
    e.stopPropagation();
    // Copy or move is the browser's call (a modifier key); the moving is ours.
    const move = Boolean(src) && dt.dropEffect !== "copy" && !e.ctrlKey && !e.altKey;
    dt.dropEffect = "copy";
    const el = t.closest(".blk");
    const pos = caret.fromPoint(e.clientX, e.clientY);
    let off = pos && t.contains(pos.node) ? caret.offset(t, pos.node, pos.offset) : readText(t).length;
    const insert = t.dataset.role === "caption" ? data.replace(/\n+/g, " ") : data;
    let done = false;
    App.store.group("Move text", () => {
      if (move && src.el.isConnected) {
        const st = readText(src.t);
        if (st.slice(src.start, src.end) === src.text) {
          if (src.t === t) {
            if (off > src.start && off < src.end) return; // onto itself
            if (off >= src.end) off -= src.end - src.start;
          }
          const rest = st.slice(0, src.start) + st.slice(src.end);
          this.setText(src.el, rest);
          this.commitText(src.el, rest);
        }
      }
      const cur = readText(t);
      const next = cur.slice(0, off) + insert + cur.slice(off);
      this.setText(el, next);
      this.commitText(el, next);
      done = true;
    });
    if (!done) return;
    this._pressing = false;
    t.focus({ preventScroll: true });
    t.classList.add("is-live");
    caret.set(t, off, off + insert.length);
  };

  // --- links, checkboxes, toggles -------------------------------------------------------------
  P.onBlocksMouseDown = function (e) {
    if (e.button !== 0) return;
    // A cell's empty space (below its blocks, or an empty cell): write there,
    // as below the last block of the page.
    const own = this.blockOf(e.target);
    if (own && own._b.type === "grid_cell") {
      if (!this.readOnly) { e.preventDefault(); this.focusCellEnd(own); }
      return;
    }
    if (e.target.closest && e.target.closest(".blk-text, .tbl-cell") && !this._pressing) {
      this._pressing = true;
      // A press that turns into a native text drag ends in dragend, not
      // mouseup.
      const up = () => {
        document.removeEventListener("mouseup", up, true);
        document.removeEventListener("dragend", up, true);
        this._pressing = false;
        const a = document.activeElement;
        if (a && this.blocksEl.contains(a) && a.classList && (a.classList.contains("blk-text") || a.classList.contains("tbl-cell"))) a.classList.add("is-live");
      };
      document.addEventListener("mouseup", up, true);
      document.addEventListener("dragend", up, true);
    }
    const a = e.target.closest && e.target.closest("a.md-link, a[data-page-id]");
    if (a) {
      const t = a.closest(".blk-text, .tbl-cell");
      // In a block that is being edited a click places the caret, as in any
      // editor; Cmd/Ctrl+click follows the link there. Elsewhere it follows.
      if (t && (document.activeElement !== t || isMod(e) || this.readOnly)) {
        e.preventDefault();
        this._linkDown = a;
      }
      return;
    }
    if (e.target.closest(".blk-check, .toggle-btn, .callout-icon")) e.preventDefault();
  };

  P.onBlocksClick = function (e) {
    const a = e.target.closest && e.target.closest("a.md-link, a[data-page-id], a.md-internal");
    if (a && a.closest(".blk-text, .tbl-cell")) {
      const t = a.closest(".blk-text, .tbl-cell");
      if (this._linkDown === a || this.readOnly || document.activeElement !== t) {
        e.preventDefault();
        this._linkDown = null;
        this.followLink(a);
      }
      return;
    }
    const el = this.blockOf(e.target);
    if (!el) return;
    if (e.target.closest(".blk-check")) {
      if (!this.readOnly) this.toggleCheck(el);
      return;
    }
    if (e.target.closest(".toggle-btn")) {
      this.setOpen(el, this.collapsed(el));
      return;
    }
    if (e.target.closest(".toggle-empty") && !this.readOnly) {
      const c = this.op("New block", () => this.create({ parentId: el.dataset.id, after: null, type: "paragraph" }));
      if (c) this.focusBlock(c.id, 0);
      return;
    }
    if (e.target.closest(".callout-icon") && !this.readOnly) {
      this.openIconPicker(e.target.closest(".callout-icon"), el);
      return;
    }
    // A divider has nothing to click into: the click selects it.
    if (el._b.type === "divider" && e.target.closest(".blk-row")) this.selectBlocks([el.dataset.id]);
  };

  P.followLink = function (a) {
    const pid = a.dataset.pageId;
    if (pid) {
      const frag = a.dataset.frag || null;
      if (App.nav && App.nav.openPage) App.nav.openPage(pid, frag ? { blockId: frag } : {});
      else window.location.href = a.getAttribute("href");
      return;
    }
    const href = a.getAttribute("href");
    if (!href || href === "#") return;
    if (/^mailto:/i.test(href)) { window.location.href = href; return; }
    window.open(href, "_blank", "noopener,noreferrer");
  };

  // --- block selection --------------------------------------------------------------------------
  P.selectAll = function () {
    const ids = App.store.blocks(this.pageId).map((b) => b.id).filter((id) => this.els.has(id));
    this.selectBlocks(ids, { anchor: ids[0], head: ids[ids.length - 1] });
  };

  P.extendSelection = function (dir) {
    const list = this.visibleBlocks();
    const a = list.indexOf(this.els.get(this.selAnchor));
    const hd = list.indexOf(this.els.get(this.selHead));
    if (a < 0 || hd < 0) return;
    const next = Math.max(0, Math.min(list.length - 1, hd + dir));
    const lo = Math.min(a, next), hi = Math.max(a, next);
    const ids = list.slice(lo, hi + 1).map((x) => x.dataset.id);
    this.selectBlocks(this.topLevel(ids), { anchor: this.selAnchor, head: list[next].dataset.id });
  };

  P.onRootKeyDown = function (e) {
    if (e.target !== this.root || this.md) return;
    const m = isMod(e);
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (m && lower === "a") { stop(); this.selectAll(); return; }
    if (m && !e.altKey && (lower === "z" || lower === "y")) { stop(); this.undo(lower === "y" || e.shiftKey); return; }
    if (!this.selected.size) return;
    const ids = this.selectedIds();
    if (key === "Escape") { stop(); this.clearSelection(); return; }
    if (this.readOnly) {
      if (key === "ArrowUp" || key === "ArrowDown") { stop(); this.moveSelection(key === "ArrowUp" ? -1 : 1, e.shiftKey); }
      return;
    }
    if (key === "Backspace" || key === "Delete") { stop(); this.deleteBlocks(ids); return; }
    if (key === "Enter") {
      stop();
      const el = this.els.get(ids[0]);
      if (!el) return;
      const b = App.store.block(ids[0]);
      if (b && (b.type === "page" || b.type === "database") && b.props && b.props.page_id && App.nav && App.nav.openPage) App.nav.openPage(b.props.page_id);
      else if (this.editableOf(el) && E.TEXT.has(el._b.type)) this.focusBlock(ids[0], "end");
      else if (el._activate) { this.clearSelection(); el._activate(); }
      else if (el._text && el._text.isContentEditable) { el.classList.add("is-captioning"); this.focusCaption(el); }
      return;
    }
    if (m && e.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
      stop();
      this.moveBy(ids, key === "ArrowUp" ? -1 : 1);
      this.selectBlocks(ids);
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") { stop(); this.moveSelection(key === "ArrowUp" ? -1 : 1, e.shiftKey); return; }
    if (key === "Tab") { stop(); if (e.shiftKey) this.outdent(ids); else this.indent(ids); this.selectBlocks(ids); return; }
    if (m && lower === "d") { stop(); const c = this.duplicate(ids); if (c.length) this.selectBlocks(c.map((b) => b.id)); return; }
    if (m && (lower === "c" || lower === "x" || lower === "v")) return; // the copy/cut/paste events
    // Typing with blocks selected changes nothing.
    if (key.length === 1 && !m) e.preventDefault();
  };

  P.moveSelection = function (dir, extend) {
    if (extend) { this.extendSelection(dir); return; }
    const cur = this.els.get(this.selHead);
    if (!cur) return;
    // Cells are passed through: down from a grid is its first block, up
    // from a cell's first block the last block of the cell before.
    const step = (el) => (dir < 0 ? this.prevVisible(el) : this.nextVisible(el));
    let next = step(cur);
    while (next && next._b.type === "grid_cell") next = step(next);
    if (next) this.selectBlocks([next.dataset.id]);
  };

  // Copy and cut of selected blocks: Markdown for other programs, HTML for
  // rich ones, and the nodes themselves for a paste back into meerpad.
  P.onCopy = function (e, cut) {
    if (e.target !== this.root || !this.selected.size || !e.clipboardData) return;
    e.preventDefault();
    const ids = this.selectedIds();
    const nodes = ids.map((id) => this.nodeOf(id)).filter(Boolean);
    const md = App.mdblocks.toMarkdown(nodes);
    e.clipboardData.setData("text/plain", md);
    e.clipboardData.setData("text/html", App.markdown.toHtml(md));
    e.clipboardData.setData("application/x-meerpad-blocks", JSON.stringify(nodes));
    if (cut && !this.readOnly) this.deleteBlocks(ids);
  };

  // --- paste -------------------------------------------------------------------------------------
  const ownHtml = (html) => /class="?[^"]*\b(md-mark|md-link|blk-text|md-code)\b/.test(html);

  // Clipboard content as block nodes, or null when it is only text.
  function clipboardNodes(dt) {
    const json = dt.getData("application/x-meerpad-blocks");
    if (json) {
      try {
        const nodes = JSON.parse(json);
        if (Array.isArray(nodes) && nodes.length) return { nodes };
      } catch (e) { /* not ours after all */ }
    }
    const plain = (dt.getData("text/plain") || "").replace(/\r\n?/g, "\n");
    const html = dt.getData("text/html");
    if (html && !ownHtml(html)) {
      const nodes = App.mdblocks.fromHtml(html);
      if (nodes && nodes.length) return { nodes, plain };
    }
    if (!plain) return { nodes: [], plain };
    if (!plain.replace(/\n+$/, "").includes("\n") && !BLOCK_SYNTAX.test(plain)) return { text: plain.replace(/\n+$/, ""), plain };
    return { nodes: App.mdblocks.parse(plain), plain };
  }

  P.onPaste = function (e) {
    const t = textTarget(e);
    if (!t || this.readOnly) return;
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    e.stopPropagation();
    const el = t.closest(".blk");
    const role = t.dataset.role || "text";
    const files = [...(dt.files || [])];
    if (files.length && role !== "code" && role !== "equation") { this.pasteFiles(el, files); return; }
    const plain = (dt.getData("text/plain") || "").replace(/\r\n?/g, "\n");
    if (role === "code" || role === "equation") { this.typeText(el, t, plain); return; }
    if (role === "caption") { this.insertText(el, plain.replace(/\n+/g, " ")); return; }
    if (dt.getData("application/x-meerpad-blocks")) {
      const got = clipboardNodes(dt);
      if (got.nodes && got.nodes.length) { this.insertNodes(el, got.nodes); return; }
    }
    const url = plain.trim();
    if (SINGLE_URL.test(url)) { this.pasteUrl(el, t, url); return; }
    const got = clipboardNodes(dt);
    if (got.text !== undefined) { this.insertText(el, got.text); return; }
    if (got.nodes && got.nodes.length) this.insertNodes(el, got.nodes);
  };

  P.pasteUrl = function (el, t, url) {
    const text = readText(t);
    const sel = caret.get(t) || { start: text.length, end: text.length };
    if (!sel.collapsed && text.slice(sel.start, sel.end).trim()) {
      // A link pasted over words makes them its text.
      const label = text.slice(sel.start, sel.end).replace(/[[\]]/g, "");
      const link = `[${label}](${url})`;
      this.replaceText(el, text.slice(0, sel.start) + link + text.slice(sel.end), sel.start + link.length);
      return;
    }
    const next = text.slice(0, sel.start) + url + text.slice(sel.end);
    this.setText(el, next, sel.start + url.length);
    this.commitText(el, next);
    this.openPasteMenu(el, url, sel.start);
  };

  P.pasteFiles = function (el, files) {
    const b = App.store.block(el.dataset.id);
    if (!b) return;
    if (!navigator.onLine) { App.toast("Files need a connection"); return; }
    const empty = b.type === "paragraph" && el._text && !readText(el._text) && !App.store.childBlocks(b.id).length;
    if (empty) {
      // The empty line the paste landed in makes way for the files.
      this.uploadFiles(files, { parentId: b.parent_id, after: b.id }).then((made) => {
        const cur = App.store.block(b.id);
        if (made.length && cur && !cur.deleted && !cur.text) this.op("Paste", () => this.remove(b.id));
      });
    } else {
      this.uploadFiles(files, { parentId: b.parent_id, after: b.id });
    }
  };

  // A paste with blocks selected lands after them.
  P.onRootPaste = function (e) {
    if (e.target !== this.root || this.readOnly || !this.selected.size || !e.clipboardData) return;
    e.preventDefault();
    const ids = this.selectedIds();
    const last = App.store.block(ids[ids.length - 1]);
    if (!last) return;
    const files = [...(e.clipboardData.files || [])];
    if (files.length) { this.uploadFiles(files, { parentId: last.parent_id, after: last.id }); return; }
    const got = clipboardNodes(e.clipboardData);
    const nodes = got.nodes && got.nodes.length ? got.nodes : got.text ? [{ type: "paragraph", text: got.text, props: {}, children: [] }] : [];
    if (!nodes.length) return;
    const made = this.op("Paste", () => this.insertTree(nodes, { parentId: last.parent_id, after: last.id }));
    if (made && made.length) this.selectBlocks(made.map((b) => b.id));
  };

  // --- the gutter ---------------------------------------------------------------------------------
  const GUTTER_W = 46;

  P.buildGutter = function () {
    this.dropLine = h("div", "editor-drop");
    this.dropLine.hidden = true;
    this.inner.append(this.dropLine);
    if (this.readOnly) return;
    const g = h("div", "editor-gutter");
    g.hidden = true;
    const plus = h("button", "gutter-btn gutter-plus");
    plus.type = "button";
    plus.title = "Click to add a block below";
    plus.setAttribute("aria-label", "Add a block below");
    plus.innerHTML = App.icon("plus", 16);
    const handle = h("button", "gutter-btn gutter-handle");
    handle.type = "button";
    handle.title = "Drag to move, click for options";
    handle.setAttribute("aria-label", "Block options");
    handle.innerHTML = App.icon("drag", 16);
    g.append(plus, handle);
    this.inner.append(g);
    this.gutter = g;
    plus.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    plus.addEventListener("click", (e) => { e.stopPropagation(); if (this.gutterEl && this.gutterEl.isConnected) this.plusClick(this.gutterEl, e.altKey); });
    handle.addEventListener("mousedown", (e) => this.onHandleDown(e));
    handle.addEventListener("click", (e) => e.stopPropagation());
    g.addEventListener("mousedown", (e) => {
      if (e.target !== g) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.gutterEl) this.selectBlocks([this.gutterEl.dataset.id]);
    });
  };

  P.onHover = function (e) {
    if (!this.gutter || this.dragging || this.md) return;
    if (this.gutter.contains(e.target)) { clearTimeout(this._hideT); return; }
    const x = e.clientX, y = e.clientY;
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = null;
      this.hoverAt(x, y);
    });
  };

  // The innermost block whose own row is at this height. Probing at the
  // right edge of the column finds it at any nesting depth, because every
  // level's row reaches that edge. Over a grid the column is the cell under
  // the pointer, and a cell's empty space belongs to its grid.
  P.hoverAt = function (x, y) {
    if (!this.gutter || this.destroyed) return;
    const box = this.blocksEl.getBoundingClientRect();
    if (y < box.top || y > box.bottom || x > box.right + 40) { this.hideGutterSoon(); return; }
    const cell = this.cellAt(x, y);
    const col = cell ? cell._kids.getBoundingClientRect() : box;
    // Through a cell's menu button, which sits on its corner.
    const hit = document.elementsFromPoint(Math.max(col.left + 2, col.right - 3), y).find((n) => !n.closest(".cell-menu-btn"));
    let el = hit && !hit.closest(".editor-gutter") ? this.blockOf(hit) : null;
    if (el && el._b.type === "grid_cell") el = this.parentEl(el);
    if (!el) { if (!(hit && hit.closest(".editor-gutter"))) this.hideGutterSoon(); return; }
    this.showGutter(el);
  };

  P.showGutter = function (el, touch) {
    if (!this.gutter) return;
    clearTimeout(this._hideT);
    if (!touch) this.gutter.classList.remove("is-touch");
    this.gutterEl = el;
    const inner = this.inner.getBoundingClientRect();
    const row = el._row.getBoundingClientRect();
    let top = row.top;
    let lh = 24;
    const t = el._text;
    if (t && E.TEXT.has(el._b.type) && el._b.type !== "code" && el._b.type !== "equation" && t.getClientRects().length) {
      const tb = t.getBoundingClientRect();
      const cs = getComputedStyle(t);
      lh = parseFloat(cs.lineHeight) || 24;
      top = tb.top + (parseFloat(cs.paddingTop) || 0);
    } else if (el._b.type === "callout" || el._b.type === "code") {
      top = row.top + 4;
    }
    this.gutter.style.top = `${Math.round(top - inner.top + (lh - 24) / 2)}px`;
    // On a touch screen only the handle shows, in the page's narrow padding.
    this.gutter.style.left = `${Math.round(row.left - inner.left - (touch ? 20 : GUTTER_W))}px`;
    this.gutter.hidden = false;
  };

  P.hideGutterSoon = function () {
    if (!this.gutter) return;
    clearTimeout(this._hideT);
    this._hideT = setTimeout(() => {
      const menuOpen = this.menu && !this.menu.closed && this.menu.el && this.menu.el.classList.contains("block-menu");
      if (!this.dragging && !menuOpen && !this.gutter.classList.contains("is-touch")) this.gutter.hidden = true;
    }, 300);
  };

  P.hideGutter = function () {
    if (this.gutter) this.gutter.hidden = true;
  };

  // "+": a new block below (or this one, when it is an empty line), with the
  // slash menu open in it.
  P.plusClick = function (el, above) {
    const b = App.store.block(el.dataset.id);
    if (!b || this.readOnly) return;
    let target = el;
    const reuse = b.type === "paragraph" && el._text && !readText(el._text) && !App.store.childBlocks(b.id).length;
    if (!reuse) {
      const c = this.op("New block", () => this.create(above
        ? { parentId: b.parent_id, before: b.id, type: "paragraph" }
        : { parentId: b.parent_id, after: b.id, type: "paragraph" }));
      target = c && this.els.get(c.id);
    }
    if (!target) return;
    this.focusBlock(target.dataset.id, 0);
    const tt = target._text;
    tt.innerHTML = this.htmlFor(tt, "/");
    caret.set(tt, 1);
    this.markDirty(target);
    this.openSlash(target, 0);
  };

  // --- dragging blocks by the handle ------------------------------------------------------------
  P.onHandleDown = function (e) {
    if (e.button !== 0 || !this.gutterEl) return;
    e.preventDefault();
    e.stopPropagation();
    const el = this.gutterEl;
    const sx = e.clientX, sy = e.clientY;
    const handleBtn = e.currentTarget;
    let drag = null;
    const move = (ev) => {
      if (!drag) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        drag = this.startBlockDrag(el);
      }
      this.moveBlockDrag(drag, ev);
    };
    const up = (ev) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (drag) { this.endBlockDrag(drag, ev); return; }
      // A click: select the block and open its menu.
      const ids = this.selected.has(el.dataset.id) ? [...this.selected] : [el.dataset.id];
      this.selectBlocks(ids);
      this.openBlockMenu(handleBtn, ids);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  P.startBlockDrag = function (el) {
    const ids = this.selected.has(el.dataset.id) ? this.selectedIds() : [el.dataset.id];
    this.flushAll();
    this.selectBlocks(ids);
    const els = ids.map((id) => this.els.get(id)).filter(Boolean);
    els.forEach((x) => x.classList.add("is-dragging"));
    const ghost = h("div", "editor-ghost");
    const clone = el._row.cloneNode(true);
    clone.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
    clone.querySelectorAll("iframe").forEach((n) => n.remove());
    ghost.append(clone);
    ghost.style.width = `${Math.min(560, el._row.getBoundingClientRect().width)}px`;
    if (ids.length > 1) ghost.append(h("span", "ghost-count", String(ids.length)));
    document.body.append(ghost);
    this.dragging = true;
    if (this.gutter) this.gutter.hidden = true;
    document.body.classList.add("editor-dragging");
    return { ids, els, ghost, target: null };
  };

  P.moveBlockDrag = function (drag, ev) {
    drag.ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 6}px)`;
    drag.target = this.dropTarget(ev.clientX, ev.clientY, { nest: true, exclude: drag.els });
    this.showDropLine(drag.target);
    this.autoScroll(ev.clientY);
  };

  P.endBlockDrag = function (drag) {
    drag.ghost.remove();
    drag.els.forEach((x) => x.classList.remove("is-dragging"));
    document.body.classList.remove("editor-dragging");
    this.dragging = false;
    this.hideDrop();
    const t = drag.target;
    if (!t) return;
    // Into a new cell: the blocks take the place of its empty first line.
    const spare = this.placeholderLine(t.parentId, drag.ids);
    this.op("Move", () => {
      let after = t.after;
      for (const id of drag.ids) {
        this.move(id, { parentId: t.parentId, after });
        after = id;
      }
      if (spare && !drag.ids.includes(spare)) this.remove(spare);
    });
    if (t.parentId) { const p = this.els.get(t.parentId); if (p && p._b.type === "toggle" && this.collapsed(p)) this.setOpen(p, true); }
    this.selectBlocks(drag.ids);
  };

  /* Where a drop at (x, y) lands: { parentId, after } (after: a sibling id,
     or null for the top of the list) plus where to draw the line. The
     boundary is the nearest gap between two rows; the pointer's x picks the
     depth: to the right of the block above (by a margin) nests into it, and
     at the end of a nested list moving left climbs out level by level. */
  P.dropTarget = function (x, y, { nest = false, exclude = null } = {}) {
    const excluded = (el) => Boolean(exclude && exclude.some((d) => d === el || d.contains(el)));
    // Over a grid, the list dropped into is the cell under the pointer, and
    // it is a page of its own: the same rules, inside its edges. A grid in a
    // list is one block there, never a place to nest into.
    const cell = this.cellAt(x, y, exclude);
    const container = cell ? cell._kids : this.blocksEl;
    const list = this.visibleIn(container).filter((el) => !excluded(el));
    const box = container.getBoundingClientRect();
    const right = box.right;
    if (!list.length) return { parentId: cell ? cell.dataset.id : null, after: null, y: box.top, left: box.left, right };
    let k = list.length;
    for (let i = 0; i < list.length; i++) {
      const r = list[i]._row.getBoundingClientRect();
      if (y < r.top + r.height / 2) { k = i; break; }
    }
    const above = k > 0 ? list[k - 1] : null;
    const below = k < list.length ? list[k] : null;
    const rowBox = (el) => el._row.getBoundingClientRect();
    const textLeft = (el) => ((el._text && E.TEXT.has(el._b.type) && el._text.getClientRects().length) ? el._text : el._row).getBoundingClientRect().left;
    const lineY = below ? rowBox(below).top - 1 : rowBox(above).bottom + 1;
    if (!above) return { parentId: below._b.parent || null, after: null, y: lineY, left: rowBox(below).left, right };
    // Below the last block by a margin: the end of the page (or the cell).
    if (!below && y > rowBox(above).bottom + 12) {
      const tops = (cell ? App.store.childBlocks(cell.dataset.id) : App.store.blocks(this.pageId))
        .filter((b) => !exclude || !exclude.some((d) => d.dataset.id === b.id));
      const last = tops[tops.length - 1];
      return { parentId: cell ? cell.dataset.id : null, after: last ? last.id : null, y: lineY, left: box.left, right };
    }
    const grid = above._b.type === "grid";
    const firstKid = grid ? null : this.firstChildEl(above);
    if (firstKid && !excluded(firstKid)) {
      return { parentId: above.dataset.id, after: null, y: lineY, left: textLeft(above), right };
    }
    if (nest && x > textLeft(above) + 48 && !grid && above._b.type !== "divider") {
      return { parentId: above.dataset.id, after: null, y: lineY, left: textLeft(above) + 20, right, nested: true };
    }
    // Climb out while the block is the last in its list and the pointer is
    // left of where that list starts, but not out of the cell.
    let cur = above;
    for (;;) {
      if (x >= rowBox(cur).left - 6) break;
      let n = cur.nextElementSibling;
      while (n && (!n.dataset.id || excluded(n))) n = n.nextElementSibling;
      const parent = this.parentEl(cur);
      if (n || !parent || parent === cell) break;
      cur = parent;
    }
    return { parentId: cur._b.parent || null, after: cur.dataset.id, y: lineY, left: rowBox(cur).left, right };
  };

  P.showDropLine = function (t) {
    if (!t || !this.dropLine) return;
    const inner = this.inner.getBoundingClientRect();
    const box = this.blocksEl.getBoundingClientRect();
    this.dropLine.style.top = `${Math.round(t.y - inner.top - 2)}px`;
    this.dropLine.style.left = `${Math.round(t.left - inner.left)}px`;
    this.dropLine.style.width = `${Math.max(40, Math.round((t.right || box.right) - t.left))}px`;
    this.dropLine.hidden = false;
  };

  P.hideDrop = function () {
    if (this.dropLine) this.dropLine.hidden = true;
    if (this.fillTarget) { this.fillTarget.classList.remove("is-drop-target"); this.fillTarget = null; }
    this.fileTarget = null;
  };

  P.scroller = function () {
    let n = this.root.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };

  P.autoScroll = function (y) {
    const sc = this.scroller();
    const whole = sc === document.scrollingElement || sc === document.documentElement;
    const top = whole ? 0 : sc.getBoundingClientRect().top;
    const bottom = whole ? innerHeight : sc.getBoundingClientRect().bottom;
    if (y < top + 48) sc.scrollTop -= 16;
    else if (y > bottom - 48) sc.scrollTop += 16;
  };

  // --- the rubber band ------------------------------------------------------------------------------
  /* A drag that starts outside every block's content (the margins, the gaps
     between blocks) selects the blocks it passes over, the way Notion's does:
     by height, whatever the horizontal extent. A plain click there clears. */
  P.onRootMouseDown = function (e) {
    if (e.button !== 0 || this.md) return;
    const t = e.target;
    if (t.closest(".blk-row, .editor-title, .editor-header, .editor-tail, .editor-gutter, .editor-md, .toggle-empty, input, button, a, iframe")) {
      if (this.selected.size && !t.closest(".editor-gutter")) this.clearSelection();
      return;
    }
    if (!this.root.contains(t)) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let band = null;
    let raf = null;
    const move = (ev) => {
      if (!band && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!band) {
        band = h("div", "editor-rubber");
        document.body.append(band);
        const a = document.activeElement;
        if (a && a !== document.body && this.root.contains(a) && a.blur) a.blur();
      }
      const x1 = Math.min(sx, ev.clientX), x2 = Math.max(sx, ev.clientX);
      const y1 = Math.min(sy, ev.clientY), y2 = Math.max(sy, ev.clientY);
      Object.assign(band.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const hit = [];
        for (const el of this.visibleBlocks()) {
          const r = el._row.getBoundingClientRect();
          if (r.bottom >= y1 && r.top <= y2) hit.push(el.dataset.id);
        }
        const ids = this.topLevel(hit);
        if (ids.length) this.selectBlocks(ids, { anchor: ids[0], head: ids[ids.length - 1] });
        else this.clearSelection();
      });
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (band) band.remove();
      else this.clearSelection();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // --- files dropped from the desktop -------------------------------------------------------------
  const isEmptyMedia = (el) => el && (el._b.type === "image" || el._b.type === "file")
    && (() => { const p = JSON.parse(el._b.props || "{}"); return !p.file_id && !p.url; })();

  P.onDragOver = function (e) {
    if (this.readOnly || this.md || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const over = this.blockOf(e.target);
    if (over && isEmptyMedia(over)) {
      if (this.fillTarget !== over) {
        this.hideDrop();
        this.fillTarget = over;
        over.classList.add("is-drop-target");
      }
      this.fileTarget = { fill: over };
      return;
    }
    if (this.fillTarget) { this.fillTarget.classList.remove("is-drop-target"); this.fillTarget = null; }
    this.fileTarget = this.dropTarget(e.clientX, e.clientY, { nest: false });
    this.showDropLine(this.fileTarget);
  };

  P.onDragLeave = function (e) {
    if (!e.relatedTarget || !this.root.contains(e.relatedTarget)) this.hideDrop();
  };

  P.onDrop = function (e) {
    if (this.readOnly || this.md || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = this.fileTarget || this.dropTarget(e.clientX, e.clientY, { nest: false });
    this.hideDrop();
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    if (!navigator.onLine) { App.toast("Files need a connection"); return; }
    if (target.fill) { this.uploadFiles(files, { replaceId: target.fill.dataset.id, parentId: target.fill._b.parent || null, after: target.fill.dataset.id }); return; }
    // Into a new cell: the files take the place of its empty first line.
    const spare = this.placeholderLine(target.parentId);
    this.uploadFiles(files, { parentId: target.parentId, after: target.after }).then((made) => {
      if (made && made.length && spare && spare === this.placeholderLine(target.parentId, made.map((b) => b.id))) {
        this.op("Upload", () => this.remove(spare));
      }
    });
  };
})();
