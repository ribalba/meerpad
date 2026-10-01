/* The icon picker: every emoji, and Tabler's icons in the nine colours.

   App.iconPicker(anchor, { onPick(ref), onRemove(), onUpload(file) }) opens it
   and returns the popover handle. `ref` is what a page or callout stores: an
   emoji, or "icon:<name>[:<colour>]" (docs/DESIGN.md §1).

   Both sets are data files in app/static/vendor (tools/build_icons.py), loaded
   the first time the picker opens. The grid is filled a few hundred at a time
   as it scrolls: five thousand icons at once would make opening it slow. What
   was picked lately, the skin tone and the icon colour are this browser's
   own (App.local). */

window.App = window.App || {};

App.iconPicker = (() => {
  const EMOJI_SRC = "/static/vendor/emoji/emoji.json";
  const INDEX_SRC = "/static/vendor/tabler/index.json";
  const CHUNK = 280;
  const RECENT_MAX = 40;
  const RECENT_SHOWN = 20;
  const TONES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];
  const TONE_NAMES = ["Default", "Light", "Medium-light", "Medium", "Medium-dark", "Dark"];
  const COLOR_NAMES = { "": "Default", gray: "Gray", brown: "Brown", orange: "Orange", yellow: "Yellow", green: "Green",
    blue: "Blue", purple: "Purple", pink: "Pink", red: "Red" };

  // Each set: the load in flight or done, and the data once it is here.
  const sets = { emoji: { promise: null, data: null }, icons: { promise: null, data: null } };
  const fetchJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
  function load(name) {
    const s = sets[name];
    if (!s.promise) {
      s.promise = (name === "emoji" ? fetchJson(EMOJI_SRC) : Promise.all([fetchJson(INDEX_SRC), App.tabler.load()]).then(([index]) => index))
        .then((data) => { s.data = data; return data; })
        .catch((e) => { s.promise = null; throw e; });
    }
    return s.promise;
  }

  const recent = () => (App.local.get("recentIcons", []) || []).filter((r) => typeof r === "string");
  function remember(ref) {
    App.local.set("recentIcons", [ref, ...recent().filter((r) => r !== ref)].slice(0, RECENT_MAX));
  }

  // An emoji to type or paste in: pictographs, flags, keycaps and their
  // sequences, never a word.
  const EMOJI_LIKE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;
  const typedEmoji = (q) => (EMOJI_LIKE.test(q) && !/[\p{L}\p{N}]{2}/u.test(q) && [...q].length <= 16 ? q : null);

  /* The newest emoji version this device draws. Fonts lag the standard, and
     an emoji the font lacks shows as an empty box or as its parts side by
     side. A colour glyph ignores the fill colour, so drawing one in black and
     in white gives the same pixels, where a box or a plain letter does not;
     a sequence drawn as its parts is too wide. When even 😀 fails (a browser
     that scrambles canvas reads), nothing is hidden. */
  let maxVersion = null;
  function supportedVersion(groups) {
    if (maxVersion !== null) return maxVersion;
    maxVersion = Infinity;
    try {
      const canvas = App.el("canvas", { width: "40", height: "40" });
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.font = `24px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textBaseline = "top";
      const base = ctx.measureText("😀").width;
      const draws = (text) => {
        if (ctx.measureText(text).width > base * 1.4) return false;
        const pixels = (color) => {
          ctx.clearRect(0, 0, 40, 40);
          ctx.fillStyle = color;
          ctx.fillText(text, 4, 4);
          return ctx.getImageData(0, 0, 40, 40).data;
        };
        const a = pixels("#000");
        const b = pixels("#fff");
        let ink = false;
        for (let i = 0; i < a.length; i += 1) {
          if (a[i] !== b[i]) return false;
          if (i % 4 === 3 && a[i]) ink = true;
        }
        return ink;
      };
      if (!draws("😀")) return maxVersion;
      // The first emoji of each version from 12 on stands for the version.
      const probes = new Map();
      for (const [, items] of groups) {
        for (const it of items) if (it[3] >= 12 && !probes.has(it[3])) probes.set(it[3], it[0]);
      }
      const versions = [...probes.keys()].sort((x, y) => x - y);
      maxVersion = 11;
      for (const v of versions) {
        if (!draws(probes.get(v))) break;
        maxVersion = v;
      }
    } catch (e) { maxVersion = Infinity; }
    return maxVersion;
  }

  /* Sections (headings with grids) in `scroller`, filled CHUNK items at a
     time as the end comes into view. Returns a function that stops it. */
  function fillGrid(scroller, sections, makeButton) {
    scroller.replaceChildren();
    const flat = [];
    for (const s of sections) {
      if (!s.items.length) continue;
      flat.push({ heading: s.title });
      for (const it of s.items) flat.push(it);
    }
    const end = App.el("div", { class: "ip-end" });
    scroller.append(end);
    let i = 0;
    let grid = null;
    const more = () => {
      const stop = Math.min(flat.length, i + CHUNK);
      for (; i < stop; i += 1) {
        const x = flat[i];
        if (x.heading !== undefined) {
          grid = App.el("div", { class: "ip-grid", role: "group", "aria-label": x.heading });
          end.before(App.el("div", { class: "ip-heading", text: x.heading }), grid);
        } else grid.append(makeButton(x));
      }
      if (i >= flat.length) { io.disconnect(); end.remove(); return; }
      // Observing again reports the end afresh, so a chunk that did not
      // fill the view is followed by the next at once.
      io.unobserve(end);
      io.observe(end);
    };
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); },
      { root: scroller, rootMargin: "240px 0px" });
    more();
    return () => io.disconnect();
  }

  // Every word of the query somewhere in the item's words.
  const matcher = (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (hay) => words.every((w) => hay.includes(w));
  };

  /* Results by how well the name fits the query: the whole name, its start,
     every word in it, then the rest (found by keywords alone). Ties keep the
     set's own order. */
  function ranked(items, nameOf, q) {
    const n = q.toLowerCase().trim().replace(/\s+/g, " ");
    const words = n.split(" ");
    const score = (s) => (s === n ? 0 : s.startsWith(n) ? 1 : words.every((w) => s.includes(w)) ? 2 : 3);
    return items.map((it, i) => [score(nameOf(it)), i, it]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  }

  function open(anchor, opts = {}) {
    let tab = App.local.get("iconTab", "emoji") === "icons" ? "icons" : "emoji";
    let tone = Number(App.local.get("skinTone", 0)) || 0;
    let color = App.ICON_COLORS.includes(App.local.get("iconColor", "")) ? App.local.get("iconColor", "") : "";
    let stopGrid = () => {};
    let first = null; // () => the ref Enter in the search picks

    const pick = (ref) => {
      if (!ref) return;
      remember(ref);
      handle.close();
      if (opts.onPick) opts.onPick(ref);
    };

    // --- the frame: tabs, search, options, grid --------------------------------------
    const tabs = App.el("div", { class: "cover-tabs ip-tabs", role: "tablist" });
    const tabBtn = {};
    for (const [name, text] of [["emoji", "Emoji"], ["icons", "Icons"]]) {
      tabBtn[name] = App.el("button", { type: "button", role: "tab", text, onclick: () => setTab(name) });
      tabs.append(tabBtn[name]);
    }
    tabs.append(App.el("span", { class: "grow" }));
    if (opts.onUpload) {
      const fileInput = App.el("input", { type: "file", accept: "image/*", hidden: true });
      fileInput.addEventListener("change", () => {
        if (!fileInput.files[0]) return;
        handle.close();
        opts.onUpload(fileInput.files[0]);
      });
      tabs.append(fileInput, App.el("button", { type: "button", text: "Upload", onclick: () => fileInput.click() }));
    }
    if (opts.onRemove) tabs.append(App.el("button", { type: "button", text: "Remove", onclick: () => { handle.close(); opts.onRemove(); } }));

    const search = App.el("input", { class: "input ip-search", type: "search", autocomplete: "off", spellcheck: "false" });
    const toneBtn = App.el("button", { class: "ip-tone", type: "button" });
    const bar = App.el("div", { class: "ip-bar" }, search, toneBtn);
    const options = App.el("div", { class: "ip-options" });
    const scroller = App.el("div", { class: "ip-scroll" });
    const box = App.el("div", { class: "ip" }, tabs, bar, options, scroller);

    const status = (text) => { stopGrid(); first = null; scroller.replaceChildren(App.el("div", { class: "ip-status", text })); };

    // --- emoji ---------------------------------------------------------------------------
    const withTone = (it) => (tone && it[4] ? it[4][tone - 1] : it[0]);

    function emojiButton(it) {
      const e = withTone(it);
      return App.el("button", { class: "ip-btn ip-emoji", type: "button", text: e, title: it[1], "aria-label": it[1], onclick: () => pick(e) });
    }

    function drawToneBtn() {
      toneBtn.textContent = TONES[tone];
      toneBtn.title = `Skin tone: ${TONE_NAMES[tone]}`;
      toneBtn.setAttribute("aria-label", toneBtn.title);
    }

    toneBtn.addEventListener("click", () => {
      if (options.firstChild) { options.replaceChildren(); return; }
      options.replaceChildren(...TONES.map((t, n) => App.el("button", {
        class: `ip-btn ip-emoji${n === tone ? " on" : ""}`, type: "button", text: t, title: TONE_NAMES[n], "aria-label": TONE_NAMES[n],
        onclick: () => { tone = n; App.local.set("skinTone", n); options.replaceChildren(); drawToneBtn(); draw(); },
      })));
    });

    function drawEmoji(data) {
      const q = search.value.trim();
      const max = supportedVersion(data.groups);
      const groups = data.groups.map(([title, items]) => ({ title, items: items.filter((it) => it[3] <= max) }));
      // Every emoji and skin tone variant to its entry. A variant's entry has
      // no skins of its own, so the tone setting leaves it as it is.
      const byEmoji = new Map();
      for (const g of groups) {
        for (const it of g.items) {
          byEmoji.set(it[0], it);
          if (it[4]) for (const s of it[4]) byEmoji.set(s, [s, it[1], it[2], it[3]]);
        }
      }
      let sections;
      if (q) {
        const hit = matcher(q);
        const typed = typedEmoji(q);
        const found = ranked(groups.flatMap((g) => g.items.filter((it) => hit(`${it[1].toLowerCase()} ${it[2]}`))),
          (it) => it[1].toLowerCase(), q);
        // Something typed or pasted is the first result, as it is (no skin
        // tone put on it), whether the set has it or not (newer than the
        // data, or a sequence of its own).
        if (typed) found.unshift((byEmoji.get(typed) || [typed, typed, "", 0]).slice(0, 4));
        if (!found.length) { status("No emoji found"); return; }
        sections = [{ title: "Results", items: found }];
        first = () => withTone(found[0]);
      } else {
        const recents = recent().filter((r) => App.files.ref(r).kind === "emoji").slice(0, RECENT_SHOWN)
          .map((r) => byEmoji.get(r) || [r, r, "", 0]);
        sections = [{ title: "Recent", items: recents }, ...groups];
        first = null;
      }
      stopGrid();
      stopGrid = fillGrid(scroller, sections, emojiButton);
    }

    // --- icons ---------------------------------------------------------------------------
    const ref = (name) => (color ? `icon:${name}:${color}` : `icon:${name}`);
    const label = (name) => name.replace(/-/g, " ");

    function iconButton(name) {
      const glyph = App.tabler.el({ name, color }, "ip-glyph");
      return App.el("button", { class: "ip-btn", type: "button", title: label(name), "aria-label": label(name), onclick: () => pick(ref(name)) }, glyph);
    }

    // A new colour repaints the icons in place, so the grid keeps its scroll.
    function setColor(c) {
      color = c;
      App.local.set("iconColor", c);
      drawColors();
      for (const g of scroller.querySelectorAll(".ip-glyph")) {
        App.ICON_COLORS.forEach((k) => g.classList.remove(`c-${k}`));
        if (c) g.classList.add(`c-${c}`);
      }
    }

    function drawColors() {
      options.replaceChildren(...["", ...App.ICON_COLORS].map((c) => App.el("button", {
        class: `ip-swatch${c ? ` c-${c}` : ""}${c === color ? " on" : ""}`, type: "button", title: COLOR_NAMES[c], "aria-label": COLOR_NAMES[c],
        "aria-pressed": c === color ? "true" : "false", onclick: () => setColor(c),
      })));
    }

    function drawIcons(index) {
      const q = search.value.trim();
      let sections;
      if (q) {
        const hit = matcher(q);
        const found = ranked(index.categories.flatMap(([cat, names]) =>
          names.filter((name) => hit(`${label(name)} ${index.tags[name] || ""} ${cat.toLowerCase()}`))), label, q);
        if (!found.length) { status("No icons found"); return; }
        sections = [{ title: "Results", items: found }];
        first = () => ref(found[0]);
      } else {
        const recents = recent().map((r) => App.files.ref(r)).filter((r) => r.kind === "icon" && App.tabler.has(r.name))
          .map((r) => r.name).filter((n, i, all) => all.indexOf(n) === i).slice(0, RECENT_SHOWN);
        sections = [{ title: "Recent", items: recents }, ...index.categories.map(([title, items]) => ({ title, items }))];
        first = null;
      }
      stopGrid();
      stopGrid = fillGrid(scroller, sections, iconButton);
    }

    // --- switching and drawing -------------------------------------------------------------
    let drawn = 0; // drop answers to loads that a later tab switch made stale
    function draw() {
      const n = ++drawn;
      const name = tab;
      const paint = (data) => (name === "emoji" ? drawEmoji(data) : drawIcons(data));
      if (sets[name].data) { paint(sets[name].data); return; }
      load(name).then((data) => { if (n === drawn && !handle.closed) paint(data); })
        .catch(() => { if (n === drawn) status(`The ${name === "emoji" ? "emoji" : "icons"} could not load. Check the connection and try again.`); });
    }

    function setTab(name) {
      tab = name;
      App.local.set("iconTab", name);
      for (const [k, b] of Object.entries(tabBtn)) {
        b.classList.toggle("active", k === name);
        b.setAttribute("aria-selected", k === name ? "true" : "false");
      }
      const isEmoji = name === "emoji";
      search.placeholder = isEmoji ? "Search emoji, or paste one" : "Search icons";
      toneBtn.hidden = !isEmoji;
      if (isEmoji) { options.replaceChildren(); drawToneBtn(); } else drawColors();
      status("Loading…");
      draw();
      search.focus();
    }

    // --- keys: Enter picks the first result, arrows walk the grid ---------------------------
    let timer = null;
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(draw, 80); });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // The results may lag the last keystroke by the debounce.
        clearTimeout(timer);
        if (sets[tab].data) draw();
        if (first) pick(first());
      } else if (e.key === "ArrowDown") {
        const b = scroller.querySelector(".ip-btn");
        if (b) { e.preventDefault(); b.focus(); }
      }
    });
    scroller.addEventListener("keydown", (e) => {
      const cur = e.target.closest(".ip-btn");
      if (!cur || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const all = [...scroller.querySelectorAll(".ip-btn")];
      const i = all.indexOf(cur);
      let next = null;
      if (e.key === "ArrowLeft") next = all[i - 1];
      else if (e.key === "ArrowRight") next = all[i + 1];
      else {
        // The nearest button in the row above or below, by position.
        const r = cur.getBoundingClientRect();
        const down = e.key === "ArrowDown";
        let rowTop = null;
        let best = Infinity;
        for (const b of down ? all.slice(i + 1) : all.slice(0, i).reverse()) {
          const br = b.getBoundingClientRect();
          if (down ? br.top <= r.top + 1 : br.top >= r.top - 1) continue;
          if (rowTop === null) rowTop = br.top;
          if (Math.abs(br.top - rowTop) > 1) break;
          const d = Math.abs(br.left - r.left);
          if (d < best) { best = d; next = b; }
        }
        if (!next && !down) { search.focus(); return; }
      }
      if (next) { next.focus(); next.scrollIntoView({ block: "nearest" }); }
    });

    const handle = App.ui.popover(anchor, box, { className: "popover-icons", onClose: () => { clearTimeout(timer); stopGrid(); } });
    setTab(tab);
    setTimeout(() => search.focus(), 0);
    return handle;
  }

  return open;
})();
