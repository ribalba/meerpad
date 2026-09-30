/* Search (Ctrl/Cmd+K): every page title and every block, as you type.

   The store does the searching (it holds the whole account in memory, so this
   works offline and answers within a frame); this module only shows the
   results. Matched words are highlighted by building text nodes and <mark>
   elements, never by assembling markup from what the user wrote. */

window.App = window.App || {};

App.search = (() => {
  let handle = null;

  // Accent- and case-folded, like App.store.search, so the highlight finds
  // "Hühner" when you typed "huhner".
  const foldChar = (c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  /* Ranges of `text` that match any of the terms, merged. */
  function ranges(text, terms) {
    if (!terms.length || !text) return [];
    let folded = "";
    const map = []; // folded index -> original index
    for (let i = 0; i < text.length; i++) {
      const f = foldChar(text[i]);
      for (let k = 0; k < f.length; k++) { folded += f[k]; map.push(i); }
    }
    map.push(text.length);
    const out = [];
    for (const t of terms) {
      if (!t) continue;
      let from = 0;
      for (;;) {
        const at = folded.indexOf(t, from);
        if (at < 0) break;
        out.push([map[at], map[Math.min(at + t.length, map.length - 1)]]);
        from = at + t.length;
      }
    }
    out.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    return merged;
  }

  function highlight(text, terms) {
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [a, b] of ranges(text, terms)) {
      if (a > at) frag.append(text.slice(at, a));
      frag.append(App.el("mark", { text: text.slice(a, b) }));
      at = b;
    }
    if (at < text.length) frag.append(text.slice(at));
    return frag;
  }

  /* Block text is inline Markdown; a snippet reads better without the marks. */
  function plain(md) {
    return String(md || "")
      .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1")
      .replace(/(\*\*|__|~~|==|`)/g, "")
      .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* A window of the text around the first match. */
  function snippet(text, terms) {
    const t = plain(text);
    const r = ranges(t, terms)[0];
    if (!r || t.length <= 140) return t;
    const start = Math.max(0, r[0] - 40);
    const end = Math.min(t.length, start + 150);
    return `${start > 0 ? "…" : ""}${t.slice(start, end).trim()}${end < t.length ? "…" : ""}`;
  }

  /* The search bar under the toolbar, meerpic's filter bar in shape: one input
     across the page with the results dropping down below it. One element for
     the whole session, moved into each page view as it is built, so what was
     typed survives opening a result. */
  let barEl = null;
  let barApi = null;
  function bar() {
    if (barEl) return barEl;
    const input = App.el("input", {
      type: "text", class: "filter-input", autocomplete: "off", spellcheck: "false", "aria-label": "Search",
      placeholder: `Search every page and its text · ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"}K`,
    });
    const clear = App.el("button", { class: "icon-btn filter-clear", type: "button", title: "Clear (Esc)", "aria-label": "Clear", html: App.icon("x", 15), hidden: true });
    const list = App.el("div", { class: "filter-results", role: "listbox", hidden: true });
    barEl = App.el("div", { class: "filter-region" },
      App.el("div", { class: "filter-bar" }, App.el("span", { class: "filter-icon", html: App.icon("search", 16) }), input, clear),
      list);
    let items = [];
    let active = 0;
    let timer = null;

    const close = () => { list.hidden = true; };
    function pick(i) {
      const it = items[i];
      if (!it) return;
      close();
      input.blur();
      App.nav.openPage(it.page.id, it.blockId ? { blockId: it.blockId } : {});
    }
    function setActive(i) {
      active = Math.max(0, Math.min(items.length - 1, i));
      list.querySelectorAll(".search-item").forEach((n, k) => {
        n.classList.toggle("active", k === active);
        n.setAttribute("aria-selected", String(k === active));
      });
      const cur = list.querySelectorAll(".search-item")[active];
      if (cur) cur.scrollIntoView({ block: "nearest" });
    }
    function render() {
      clearTimeout(timer);
      timer = null;
      const q = input.value.trim();
      clear.hidden = !input.value;
      const terms = q ? foldChar(q).split(/\s+/).map((t) => [...t].map(foldChar).join("")).filter(Boolean) : [];
      items = q
        ? App.store.search(q, 30).map((r) => ({ page: r.page, blockId: r.blockId, snippet: r.snippet }))
        : App.store.recent(8).map((p) => ({ page: p }));
      list.replaceChildren();
      if (!items.length) {
        list.append(App.el("div", { class: "search-empty" }, q ? `No results for "${q}"` : "No pages yet"));
      } else {
        if (!q) list.append(App.el("div", { class: "search-heading", text: "Recent" }));
        items.forEach((it, i) => {
          const p = it.page;
          const btn = App.el("button", { class: "search-item", type: "button", role: "option" },
            App.el("span", { class: "search-item-icon" }, App.shell.pageIcon(p, { size: 18 })),
            App.el("span", { class: "search-item-main" },
              App.el("div", { class: "search-item-title" }, highlight(App.ui.titleOf(p), terms)),
              App.el("div", { class: "search-item-path", text: App.ui.pathOf(p) }),
              it.snippet ? App.el("div", { class: "search-item-snippet" }, highlight(snippet(it.snippet, terms), terms)) : null),
            App.el("span", { class: "search-item-enter", html: App.icon("arrow-up-right", 14) }));
          btn.addEventListener("mousemove", (e) => { if ((e.movementX || e.movementY) && active !== i) setActive(i); });
          btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the input focused
          btn.addEventListener("click", () => pick(i));
          list.append(btn);
        });
        setActive(0);
      }
      list.hidden = false;
    }
    input.addEventListener("focus", render);
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 40); });
    input.addEventListener("blur", () => setTimeout(close, 120));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") { e.preventDefault(); if (timer) render(); pick(active); }
      else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (input.value) { input.value = ""; render(); } else { close(); input.blur(); }
      }
    });
    clear.addEventListener("mousedown", (e) => e.preventDefault());
    clear.addEventListener("click", () => { input.value = ""; render(); input.focus(); });
    barApi = { focus: () => { input.focus(); input.select(); } };
    return barEl;
  }

  function open() {
    // The bar is the search wherever a page view shows it; the dialog is the
    // fallback for screens without one.
    if (barEl && barEl.isConnected && barEl.offsetParent !== null) { barApi.focus(); return; }
    if (handle) { handle.focus(); return; }
    const input = App.el("input", {
      class: "search-input", type: "text", placeholder: "Search pages and text…",
      "aria-label": "Search", autocomplete: "off", spellcheck: "false",
    });
    const list = App.el("div", { class: "search-results", role: "listbox" });
    const foot = App.el("div", { class: "search-foot" },
      App.el("span", {}, App.el("kbd", { text: "↑↓" }), " to move"),
      App.el("span", {}, App.el("kbd", { text: "Enter" }), " to open"),
      App.el("span", {}, App.el("kbd", { text: "Esc" }), " to close"));
    const body = App.el("div", { class: "search-panel" },
      App.el("div", { class: "search-bar" }, App.el("span", { html: App.icon("search", 18) }), input),
      list, foot);
    let items = [];
    let active = 0;
    let timer = null;

    const modal = App.ui.modal({ title: "Search", body, className: "search-modal", onClose: () => { handle = null; } });
    handle = { close: modal.close, focus: () => { input.focus(); input.select(); } };

    function pick(i) {
      const it = items[i];
      if (!it) return;
      modal.close();
      App.nav.openPage(it.page.id, it.blockId ? { blockId: it.blockId } : {});
    }

    function setActive(i) {
      active = Math.max(0, Math.min(items.length - 1, i));
      list.querySelectorAll(".search-item").forEach((n, k) => {
        n.classList.toggle("active", k === active);
        n.setAttribute("aria-selected", String(k === active));
      });
      const cur = list.querySelectorAll(".search-item")[active];
      if (cur) cur.scrollIntoView({ block: "nearest" });
    }

    function render() {
      clearTimeout(timer);
      timer = null;
      const q = input.value.trim();
      const terms = q ? foldChar(q).split(/\s+/).map((t) => [...t].map(foldChar).join("")).filter(Boolean) : [];
      if (q) {
        items = App.store.search(q, 40).map((r) => ({ page: r.page, blockId: r.blockId, snippet: r.snippet }));
      } else {
        items = App.store.recent(12).map((p) => ({ page: p }));
      }
      list.replaceChildren();
      if (!items.length) {
        list.append(App.el("div", { class: "search-empty" }, q ? `No results for "${q}"` : "No pages yet"));
        return;
      }
      if (!q) list.append(App.el("div", { class: "search-heading", text: "Recent" }));
      items.forEach((it, i) => {
        const p = it.page;
        const title = App.ui.titleOf(p);
        const btn = App.el("button", { class: "search-item", type: "button", role: "option" },
          App.el("span", { class: "search-item-icon" }, App.shell.pageIcon(p, { size: 18 })),
          App.el("span", { class: "search-item-main" },
            App.el("div", { class: "search-item-title" }, highlight(title, terms)),
            App.el("div", { class: "search-item-path", text: App.ui.pathOf(p) }),
            it.snippet ? App.el("div", { class: "search-item-snippet" }, highlight(snippet(it.snippet, terms), terms)) : null),
          App.el("span", { class: "search-item-enter", html: App.icon("arrow-up-right", 14) }));
        btn.addEventListener("mousemove", (e) => { if ((e.movementX || e.movementY) && active !== i) setActive(i); });
        btn.addEventListener("click", () => pick(i));
        list.append(btn);
      });
      setActive(0);
    }

    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 40); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (timer) render(); // typed faster than the debounce: answer what is in the box
        pick(active);
      }
      else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "k" || e.key === "p")) { e.preventDefault(); modal.close(); }
    });
    render();
    setTimeout(() => input.focus(), 0);
  }

  return { open, bar, close: () => handle && handle.close(), highlight, snippet };
})();
