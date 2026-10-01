/* Shared UI pieces: popovers, menus, modals, and the page picker (the icon
   picker is app.iconpicker.js).

   Everything floating is a child of <body>, positioned against an anchor
   (an element, a DOMRect, or {x, y}), kept on screen, and closed by Escape or a
   click outside. Only one menu-like popover is open at a time; opening another
   closes the first, which is what every desktop menu does. */

window.App = window.App || {};

App.ui = (() => {
  let current = null; // the open popover handle
  const open = [];    // every open popover element, oldest first

  /* Escape closes only the layer on top. Every layer listens on document in
     the capture phase, where stopPropagation cannot keep the others from
     hearing the key, so each checks that nothing was opened above it: popovers
     and modals are appended to <body> in the order they open. */
  function topmost(node) {
    const layers = [...document.body.querySelectorAll(":scope > .popover, :scope > .modal-backdrop")];
    return layers[layers.length - 1] === node;
  }

  function rectOf(anchor) {
    if (!anchor) return { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3, width: 0, height: 0 };
    if (anchor.getBoundingClientRect) return anchor.getBoundingClientRect();
    if ("x" in anchor && !("left" in anchor)) return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    return anchor;
  }

  function place(el, anchor, placement = "bottom-start") {
    const r = rectOf(anchor);
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 6;
    let left = placement.endsWith("end") ? r.right - w : r.left;
    let top = placement.startsWith("top") ? r.top - h - gap : r.bottom + gap;
    if (placement.startsWith("right")) { left = r.right + gap; top = r.top; }
    // Flip vertically when there is no room, then clamp into the viewport.
    if (top + h > innerHeight - 8 && r.top - h - gap > 8) top = r.top - h - gap;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /* A floating panel. `content` is a Node. Returns { el, close, reposition }. */
  function popover(anchor, content, opts = {}) {
    if (current && !opts.stack) current.close();
    const el = App.el("div", { class: `popover ${opts.className || ""}`, role: opts.role || "dialog" });
    el.append(content);
    document.body.append(el);
    open.push(el);
    place(el, anchor, opts.placement);
    let closed = false;
    const onDown = (e) => {
      if (el.contains(e.target)) return;
      if (opts.anchorEl && opts.anchorEl.contains(e.target)) return;
      // A modal or a stacked popover opened from this one (a confirm, a
      // submenu) is part of the same interaction, not a click outside.
      const t = e.target instanceof Element ? e.target : null;
      if (t && t.closest(".modal-backdrop")) return;
      const other = t && t.closest(".popover");
      if (other && open.indexOf(other) > open.indexOf(el)) return;
      handle.close();
    };
    const onKey = (e) => {
      if (e.key !== "Escape" || !topmost(el)) return;
      e.preventDefault();
      e.stopPropagation();
      handle.close();
    };
    const handle = {
      el,
      close() {
        if (closed) return;
        closed = true;
        el.remove();
        open.splice(open.indexOf(el), 1);
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", handle.close);
        if (current === handle) current = null;
        if (opts.onClose) opts.onClose();
      },
      reposition() { place(el, anchor, opts.placement); },
      get closed() { return closed; },
    };
    // Registered after this event loop turn, so the click that opened the
    // popover does not immediately close it.
    // Escape works at once; the outside-click and resize listeners wait a
    // turn, so the click or layout change that opened the popover does not
    // immediately close it.
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => {
      if (closed) return;
      document.addEventListener("mousedown", onDown, true);
      window.addEventListener("resize", handle.close);
    }, 0);
    if (!opts.stack) current = handle;
    return handle;
  }

  /* A menu of actions.
       items: [{ label, icon?, hint?, danger?, disabled?, checked?, onSelect?, submenu?: items },
               { divider: true }, { heading: "Text" }]
     Arrow keys move, Enter picks, Escape closes; typing filters when
     opts.filter is set. Returns the popover handle. */
  function menu(anchor, items, opts = {}) {
    const list = App.el("div", { class: "menu", role: "menu" });
    let active = -1;
    let buttons = [];
    let input = null;
    let handle = null;

    function render(filter = "") {
      list.querySelectorAll(".menu-item, .menu-divider, .menu-heading, .menu-empty").forEach((n) => n.remove());
      const f = filter.trim().toLowerCase();
      buttons = [];
      const shown = items.filter((it) => !f || it.divider || it.heading
        || String(it.label).toLowerCase().includes(f) || (it.keywords || "").toLowerCase().includes(f));
      shown.forEach((it, i) => {
        if (it.divider) { if (!f && i > 0) list.append(App.el("div", { class: "menu-divider" })); return; }
        if (it.heading) { if (!f) list.append(App.el("div", { class: "menu-heading", text: it.heading })); return; }
        const btn = App.el("button", {
          class: `menu-item${it.danger ? " danger" : ""}${it.checked ? " checked" : ""}`,
          role: "menuitem", type: "button", disabled: it.disabled || null,
        },
        it.icon || it.iconHtml ? App.el("span", { class: "menu-icon", html: it.iconHtml || App.icon(it.icon) }) : (it.emoji ? App.el("span", { class: "menu-icon menu-emoji" }, App.glyph(it.emoji)) : null),
        App.el("span", { class: "menu-label" }, it.label, it.description ? App.el("small", { class: "menu-desc", text: it.description }) : null),
        it.hint ? App.el("span", { class: "menu-hint", text: it.hint }) : null,
        it.checked ? App.el("span", { class: "menu-check", html: App.icon("check", 14) }) : null,
        it.submenu ? App.el("span", { class: "menu-hint", html: App.icon("chevron-right", 14) }) : null);
        // Only a pointer that really moves picks an item: arrowing down scrolls
        // the list under a resting pointer, which fires mouseenter (and in
        // some browsers a mousemove with no movement) on the item it lands on.
        btn.addEventListener("mousemove", (e) => {
          if (!e.movementX && !e.movementY) return;
          const i = buttons.indexOf(btn);
          if (i !== active) setActive(i, false);
        });
        btn.addEventListener("click", (e) => { e.preventDefault(); pick(it, btn); });
        buttons.push(btn);
        btn._item = it;
        list.append(btn);
      });
      if (!buttons.length) list.append(App.el("div", { class: "menu-empty", text: opts.emptyText || "No results" }));
      setActive(buttons.length ? 0 : -1);
    }

    function setActive(i, scroll = true) {
      buttons.forEach((b, n) => b.classList.toggle("active", n === i));
      active = i;
      if (scroll && buttons[i]) buttons[i].scrollIntoView({ block: "nearest" });
    }

    function pick(it, btn) {
      if (it.disabled) return;
      if (it.submenu) {
        menu(btn, it.submenu, { placement: "right-start", stack: true });
        return;
      }
      if (!opts.keepOpen) handle.close();
      if (it.onSelect) it.onSelect();
    }

    const onKey = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % Math.max(1, buttons.length)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + buttons.length) % Math.max(1, buttons.length)); }
      else if (e.key === "Enter") { e.preventDefault(); if (buttons[active]) pick(buttons[active]._item, buttons[active]); }
    };

    const wrap = App.el("div", { class: "menu-wrap" });
    if (opts.filter) {
      input = App.el("input", { class: "menu-filter", placeholder: opts.placeholder || "Filter…", type: "text" });
      input.addEventListener("input", () => render(input.value));
      input.addEventListener("keydown", onKey);
      wrap.append(input);
    }
    wrap.append(list);
    render();
    handle = popover(anchor, wrap, { placement: opts.placement, className: `popover-menu ${opts.className || ""}`, onClose: opts.onClose, stack: opts.stack, anchorEl: opts.anchorEl, role: "menu" });
    if (input) setTimeout(() => input.focus(), 0);
    else if (opts.keepFocus) {
      // The caller keeps typing somewhere else (the slash menu in a block) and
      // forwards navigation keys through handle.key.
    } else {
      handle.el.tabIndex = -1;
      handle.el.addEventListener("keydown", onKey);
      setTimeout(() => handle.el.focus({ preventScroll: true }), 0);
    }
    handle.setItems = (next) => { items = next; render(input ? input.value : ""); handle.reposition(); };
    handle.filter = (text) => { render(text); handle.reposition(); return buttons.length; };
    handle.key = onKey; // for callers that keep focus elsewhere (the slash menu)
    return handle;
  }

  /* A modal dialog. Returns { el, body, close }. */
  function modal({ title, body, actions = [], onClose, wide = false, className = "" } = {}) {
    const backdrop = App.el("div", { class: "modal-backdrop" });
    const box = App.el("div", { class: `modal${wide ? " modal-wide" : ""} ${className}`, role: "dialog", "aria-modal": "true" });
    const head = App.el("div", { class: "modal-head" },
      App.el("h2", { class: "modal-title", text: title || "" }),
      App.el("button", { class: "icon-btn modal-x", type: "button", "aria-label": "Close", html: App.icon("x"), onclick: () => handle.close() }));
    const content = App.el("div", { class: "modal-body" });
    if (body) content.append(body);
    box.append(head, content);
    if (actions.length) {
      const foot = App.el("div", { class: "modal-foot" });
      for (const a of actions) {
        foot.append(App.el("button", {
          class: `btn${a.primary ? " btn-primary" : ""}${a.danger ? " btn-danger" : ""}`, type: "button", text: a.label,
          onclick: async () => { const keep = a.onClick ? await a.onClick() : false; if (keep !== true) handle.close(); },
        }));
      }
      box.append(foot);
    }
    backdrop.append(box);
    document.body.append(backdrop);
    const onKey = (e) => {
      if (e.key !== "Escape" || !topmost(backdrop)) return;
      e.stopPropagation();
      handle.close();
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) handle.close(); });
    let closed = false;
    const handle = {
      el: box,
      body: content,
      close() {
        if (closed) return;
        closed = true;
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        if (onClose) onClose();
      },
    };
    setTimeout(() => { const f = box.querySelector("input, textarea, select, button.btn-primary"); if (f) f.focus(); }, 0);
    return handle;
  }

  function confirm(message, { title = "Are you sure?", confirmLabel = "OK", danger = false } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      modal({
        title,
        body: App.el("p", { text: message }),
        actions: [
          { label: "Cancel", onClick: () => { answered = true; resolve(false); } },
          { label: confirmLabel, primary: !danger, danger, onClick: () => { answered = true; resolve(true); } },
        ],
        onClose: () => { if (!answered) resolve(false); },
      });
    });
  }

  function prompt(message, { title = "", value = "", placeholder = "", confirmLabel = "OK" } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const input = App.el("input", { class: "input", type: "text", value, placeholder });
      const body = App.el("div", {}, message ? App.el("p", { text: message }) : null, input);
      const h = modal({
        title,
        body,
        actions: [
          { label: "Cancel", onClick: () => { answered = true; resolve(null); } },
          { label: confirmLabel, primary: true, onClick: () => { answered = true; resolve(input.value); } },
        ],
        onClose: () => { if (!answered) resolve(null); },
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); answered = true; resolve(input.value); h.close(); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  /* Titles for display: an empty title is "Untitled". */
  const titleOf = (p) => (p && p.title && p.title.trim()) || "Untitled";

  /* "Work / Farm / Hühner": where a page lives, for pickers and search. */
  function pathOf(page) {
    const anc = App.store.ancestors(page.id).reverse();
    const ws = App.store.workspace(page.workspace_id);
    const parts = anc.slice(1).map(titleOf);
    return [ws ? ws.name : "", ...parts].filter(Boolean).join(" / ");
  }

  /* Pick a page: search as you type, recent pages when empty.
       opts: { onPick(page), exclude: Set(ids), placeholder, allowCreate(title) -> page, filter(page) -> bool } */
  function pagePicker(anchor, opts = {}) {
    const exclude = opts.exclude || new Set();
    const accept = (p) => p && !exclude.has(p.id) && (!opts.filter || opts.filter(p));
    const itemFor = (p) => ({
      label: titleOf(p),
      description: pathOf(p),
      ...(App.files.isGlyph(p.icon) ? { emoji: p.icon } : { icon: p.kind === "database" ? "database" : "page" }),
      onSelect: () => opts.onPick && opts.onPick(p),
    });
    const build = (q) => {
      const pages = q ? App.store.search(q, 40).map((r) => r.page) : App.store.recent(15);
      const items = pages.filter(accept).map(itemFor);
      if (q && opts.allowCreate) {
        items.push({ divider: true }, {
          label: `New page "${q}"`, icon: "plus",
          onSelect: () => { const p = opts.allowCreate(q); if (p && opts.onPick) opts.onPick(p); },
        });
      }
      return items;
    };
    const h = menu(anchor, build(""), { filter: true, placeholder: opts.placeholder || "Search pages…", className: "page-picker", emptyText: "No pages found", onClose: opts.onClose });
    const input = h.el.querySelector(".menu-filter");
    input.addEventListener("input", () => h.setItems(build(input.value)), true);
    return h;
  }

  return { popover, menu, modal, confirm, prompt, pagePicker, titleOf, pathOf, place, closeAll: () => current && current.close() };
})();
