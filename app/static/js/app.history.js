/* Page history: the sessions a page was edited in, and what each one changed.

   The server counts every edit into the page's current editing session. A
   session ends after a few idle minutes (or once it has run long enough), and
   the server then keeps a snapshot of the page as that session left it. This
   dialog lists the sessions, newest first, and shows the one picked either as
   its changes (against the session before it, or any other one) or as the
   page it left behind.

   Nothing here is in the local store: history is read from the server, needs
   a connection, and is for the owner only. It is read-only. Page content
   reaches the DOM the way it does everywhere else: through textContent, or
   through App.markdown, which escapes what it is given. Text diffs are built
   from textContent too, never Markdown, because a changed word can cut
   straight through a `**` or a link. */

window.App = window.App || {};

App.history = (() => {
  let handle = null;

  const TYPE_NAMES = {
    paragraph: "Text", heading_1: "Heading 1", heading_2: "Heading 2", heading_3: "Heading 3",
    bulleted_list: "Bulleted list", numbered_list: "Numbered list", to_do: "To-do", toggle: "Toggle",
    quote: "Quote", callout: "Callout", code: "Code", divider: "Divider", image: "Image", file: "File",
    bookmark: "Bookmark", embed: "Embed", table: "Table", page: "Page link", database: "Database",
    equation: "Equation",
  };
  const COLORS = new Set(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);
  const FONTS = { sans: "Default", serif: "Serif", mono: "Mono" };
  const STATUS_WORDS = { added: "Added", removed: "Removed", changed: "Changed" };

  const enc = encodeURIComponent;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const typeName = (t) => TYPE_NAMES[t] || t || "Block";
  const httpUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : "");
  const md = (text) => App.markdown.inline(String(text == null ? "" : text));

  // --- times and people ----------------------------------------------------------

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const clock = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  function dayName(d) {
    const now = new Date();
    const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  /* "Today, 14:02 – 14:37"; one time when the session fits in a minute, and
     both days when it ran past midnight. */
  function span(s) {
    const a = new Date(s.started_at);
    let b = new Date(s.ended_at || s.started_at);
    if (Number.isNaN(a.getTime())) return "Unknown time";
    if (Number.isNaN(b.getTime())) b = a;
    const start = `${dayName(a)}, ${clock(a)}`;
    if (startOfDay(a) !== startOfDay(b)) return `${start} – ${dayName(b)}, ${clock(b)}`;
    return clock(a) === clock(b) ? start : `${start} – ${clock(b)}`;
  }

  function fullSpan(s) {
    const a = new Date(s.started_at);
    const b = new Date(s.ended_at || s.started_at);
    if (Number.isNaN(a.getTime())) return "";
    return Number.isNaN(b.getTime()) || +a === +b ? a.toLocaleString() : `${a.toLocaleString()} – ${b.toLocaleString()}`;
  }

  /* Who edited, with the signed-in user as "You" (or "you" mid-sentence). */
  function editorNames(s, you = "You") {
    const me = ((App.me || (App.store.me && App.store.me()) || {}).email || "").toLowerCase();
    const names = (s.editors || []).map((e) => (me && String(e).toLowerCase() === me ? you : String(e)));
    return [...new Set(names)];
  }

  function joinNames(names, max = Infinity) {
    let list = names;
    if (names.length > max) list = [...names.slice(0, max - 1), `${names.length - max + 1} others`];
    if (list.length <= 1) return list.join("");
    return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  }

  // --- values ------------------------------------------------------------------------

  function dateText(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(v || ""));
    if (!m) return String(v);
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    const day = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    return m[4] ? `${day}, ${clock(d)}` : day;
  }

  /* A database row value as one short line of text (docs/DESIGN.md §4).
     Returns null for an empty value, which the caller shows as "empty". */
  function valueText(v, type) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "boolean") return v ? "checked" : "unchecked";
    if (Array.isArray(v)) {
      const parts = v.map((x) => (x && typeof x === "object" ? x.name || x.url || "" : String(x))).filter(Boolean);
      return parts.length ? parts.join(", ") : null;
    }
    if (typeof v === "object") {
      if ("start" in v || "end" in v) {
        const a = v.start ? dateText(v.start) : "";
        const b = v.end ? dateText(v.end) : "";
        return a && b ? `${a} – ${b}` : a || b || null;
      }
      if (v.name) return String(v.name);
      return JSON.stringify(v);
    }
    if (type === "date") return dateText(v);
    return String(v);
  }

  function valueNode(v, type) {
    const t = valueText(v, type);
    return t === null ? App.el("span", { class: "hist-none", text: "empty" }) : App.el("span", { class: "hist-val", text: t });
  }

  /* The row's parent database schema, for property names and types. */
  function schemaProps(pageId) {
    const page = App.store.page(pageId);
    const parent = page && page.parent_id ? App.store.page(page.parent_id) : null;
    return (parent && parent.schema && Array.isArray(parent.schema.properties)) ? parent.schema.properties : [];
  }

  // --- small pieces ----------------------------------------------------------------------

  const arrow = () => App.el("span", { class: "hist-arrow", text: "→" });

  /* A word-level text diff, as text nodes: never Markdown (see the top). */
  const segmentNodes = (segs) => segs.map((s) => App.el(s.op === "added" ? "ins" : s.op === "removed" ? "del" : "span", { text: s.text }));

  function colorStyle(c) {
    if (typeof c !== "string" || !c) return null;
    const bg = c.endsWith("_bg");
    const name = bg ? c.slice(0, -3) : c;
    if (!COLORS.has(name)) return null;
    return bg ? `background:var(--ed-${name}-bg);border-radius:4px` : `color:var(--ed-${name})`;
  }

  function iconNode(ref, cls = "hist-emoji") {
    const r = App.files.ref(ref);
    if (!r) return null;
    if (r.kind === "url") return App.el("img", { class: "hist-img-icon", src: r.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    if (r.kind === "gradient") return App.el("span", { class: `hist-swatch gradient-${Math.abs(r.n) % 8}` });
    return App.el("span", { class: cls, text: r.text });
  }

  function coverThumb(ref) {
    if (!ref) return App.el("span", { class: "hist-none", text: "none" });
    const r = App.files.ref(ref);
    if (r.kind === "url") return App.el("img", { class: "hist-swatch", src: r.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    if (r.kind === "gradient") return App.el("span", { class: `hist-swatch gradient-${Math.abs(r.n) % 8}` });
    return App.el("span", { class: "hist-swatch" });
  }

  function linkCard(pid, kind) {
    const p = pid ? App.store.page(pid) : null;
    const icon = p && p.icon ? iconNode(p.icon, "hist-card-emoji") : null;
    const kids = [
      App.el("span", { class: "hist-card-icon" }, icon || App.el("span", { html: App.icon(kind === "database" ? "database" : "page", 16) })),
      App.el("span", { class: "hist-card-title", text: p ? App.ui.titleOf(p) : "Untitled page" }),
    ];
    if (p && App.store.isTrashed && App.store.isTrashed(pid)) kids.push(App.el("span", { class: "hist-card-meta", text: "in the trash" }));
    if (!p) return App.el("div", { class: "hist-card hist-pagelink" }, kids);
    const href = App.nav && App.nav.pageHref ? App.nav.pageHref(pid) : `/p/${enc(pid)}`;
    return App.el("a", { class: "hist-card hist-pagelink", href, dataset: { pageId: pid } }, kids);
  }

  // --- the read-only block renderer ------------------------------------------------------

  /* The words of a text-bearing block: its Markdown, or, when a diff is
     given, the raw text with the added and removed words marked. */
  function textNode(text, segments, cls = "hist-text") {
    if (segments) return App.el("div", { class: `${cls} hist-segs` }, segmentNodes(segments));
    return App.el("div", { class: cls, html: md(text) });
  }

  function captionNode(text, segments) {
    if (!segments && !text) return null;
    return textNode(text, segments, "hist-caption");
  }

  const withMarker = (marker, body) => App.el("div", { class: "hist-row" }, marker, body);

  /* One block as a reader sees it. b is {type, text, props}; ctx carries the
     list number, the text diff and, for a changed table, the old props. */
  function blockNode(b, ctx = {}) {
    const p = b.props || {};
    const segs = Array.isArray(ctx.segments) && ctx.segments.length ? ctx.segments : null;
    const text = () => textNode(b.text, segs);
    const tint = (node) => { const s = colorStyle(p.color); if (s) node.setAttribute("style", s); return node; };
    switch (b.type) {
      case "paragraph": return tint(text());
      case "heading_1": case "heading_2": case "heading_3": {
        const t = text();
        t.classList.add(`hist-h${b.type.slice(-1)}`);
        return tint(t);
      }
      case "bulleted_list": return tint(withMarker(App.el("span", { class: "hist-marker", text: "•" }), text()));
      case "numbered_list": return tint(withMarker(App.el("span", { class: "hist-marker hist-num", text: `${ctx.num || 1}.` }), text()));
      case "to_do": {
        const on = Boolean(p.checked);
        const box = App.el("span", { class: `hist-check${on ? " on" : ""}`, role: "img", "aria-label": on ? "Checked" : "Not checked", html: on ? App.icon("check", 12) : "" });
        const row = withMarker(App.el("span", { class: "hist-marker" }, box), text());
        if (on) row.classList.add("is-checked");
        return tint(row);
      }
      case "toggle": return tint(withMarker(App.el("span", { class: "hist-marker", text: "▸" }), text()));
      case "quote": return tint(App.el("div", { class: "hist-quote" }, text()));
      case "callout": {
        const box = App.el("div", { class: "hist-callout" }, App.el("span", { class: "hist-callout-icon" }, iconNode(p.icon || "💡")), text());
        const s = colorStyle(p.color);
        if (s) box.setAttribute("style", s);
        return box;
      }
      case "code": {
        const pre = App.el("pre", { class: "hist-code" });
        if (segs) pre.append(...segmentNodes(segs)); else pre.textContent = b.text || "";
        const lang = p.language && p.language !== "plain" ? App.el("div", { class: "hist-code-lang", text: p.language }) : null;
        return App.el("div", { class: "hist-codebox" }, lang, pre);
      }
      case "equation": {
        const pre = App.el("pre", { class: "hist-code hist-equation" });
        if (segs) pre.append(...segmentNodes(segs)); else pre.textContent = b.text || "";
        return pre;
      }
      case "divider": return App.el("hr", { class: "hist-hr" });
      case "image": {
        const src = p.file_id ? App.files.url(p.file_id, p.name) : httpUrl(p.url);
        let media = App.el("div", { class: "hist-media-missing", html: App.icon("image", 16) }, App.el("span", { text: "Image" }));
        if (src) {
          media = App.el("img", { class: "hist-img", src, alt: App.markdown.plain(b.text || ""), loading: "lazy", referrerpolicy: "no-referrer" });
          media.addEventListener("error", () => media.replaceWith(App.el("div", { class: "hist-media-missing", html: App.icon("image", 16) },
            App.el("span", { text: "Image not available" }))), { once: true });
        }
        return App.el("figure", { class: "hist-figure" }, media, captionNode(b.text, segs));
      }
      case "file": {
        let name = p.name || "";
        if (!name && httpUrl(p.url)) { try { name = decodeURIComponent(new URL(p.url).pathname.split("/").filter(Boolean).pop() || ""); } catch (e) { name = ""; } }
        return App.el("div", {},
          App.el("div", { class: "hist-card" },
            App.el("span", { class: "hist-card-icon", text: "📎" }),
            App.el("span", { class: "hist-card-title", text: name || "File" }),
            p.size ? App.el("span", { class: "hist-card-meta", text: App.fmt.bytes(p.size) }) : null),
          captionNode(b.text, segs));
      }
      case "bookmark": case "embed": {
        const url = httpUrl(p.url);
        const title = b.type === "bookmark" && p.title ? p.title : url || p.url || (b.type === "bookmark" ? "Bookmark" : "Embed");
        const main = App.el("span", { class: "hist-card-main" },
          App.el("span", { class: "hist-card-title", text: title }),
          title !== url && url ? App.el("span", { class: "hist-card-meta", text: url }) : null);
        const icon = App.el("span", { class: "hist-card-icon", html: App.icon(b.type === "bookmark" ? "bookmark" : "embed", 16) });
        const card = url
          ? App.el("a", { class: "hist-card", href: url, target: "_blank", rel: "noopener noreferrer" }, icon, main)
          : App.el("div", { class: "hist-card" }, icon, main);
        return App.el("div", {}, card, captionNode(b.text, segs));
      }
      case "table": return tableNode(p, ctx.oldProps);
      case "page": case "database": return linkCard(p.page_id, b.type);
      default:
        return App.el("div", { class: "hist-unknown" },
          App.el("span", { class: "hist-unknown-tag", text: b.type || "block" }),
          App.el("span", { text: App.markdown.plain(b.text || "") }));
    }
  }

  /* A table block; given the old props, the cells that differ are marked. */
  function tableNode(p, oldProps) {
    const rows = Array.isArray(p.rows) ? p.rows : [];
    const oldRows = oldProps && Array.isArray(oldProps.rows) ? oldProps.rows : null;
    const table = App.el("table", { class: "hist-table" });
    const tbody = App.el("tbody");
    rows.forEach((row, r) => {
      const tr = App.el("tr");
      (Array.isArray(row) ? row : []).forEach((cell, c) => {
        const head = (p.header_row && r === 0) || (p.header_col && c === 0);
        const td = App.el(head ? "th" : "td", { html: md(cell) });
        if (oldRows) {
          const was = Array.isArray(oldRows[r]) && oldRows[r][c] !== undefined ? oldRows[r][c] : null;
          if (was === null || String(was) !== String(cell == null ? "" : cell)) {
            td.classList.add("hist-cell-changed");
            td.title = was === null ? "New cell" : `Was: ${App.markdown.plain(was) || "empty"}`;
          }
        }
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(tbody);
    return App.el("div", { class: "hist-table-wrap" }, rows.length ? table : App.el("span", { class: "hist-none", text: "Empty table" }));
  }

  /* List numbers, counted the way the editor counts them: a run of numbered
     siblings at one depth, restarted by any other block at that depth. A
     removed block (in a diff) neither breaks nor advances the newer version's
     run; a removed numbered item shows the number it would take there. */
  function numbering(items) {
    const out = new Array(items.length).fill(0);
    const run = [];
    items.forEach((it, i) => {
      const d = Math.max(0, it.depth || 0);
      if (it.status === "removed") {
        if (it.type === "numbered_list") out[i] = (run[d] || 0) + 1;
        return;
      }
      run.length = d + 1;
      if (it.type === "numbered_list") out[i] = run[d] = (run[d] || 0) + 1;
      else run[d] = 0;
    });
    return out;
  }

  // --- the diff view ---------------------------------------------------------------------

  const isChange = (e) => e.status !== "same" || e.moved;

  /* Small labels for what the text diff cannot show: a move, a to-do ticked,
     a new language or image, a changed setting. */
  function changeTags(e) {
    const tags = [];
    if (e.moved) tags.push({ text: "Moved", kind: "moved" });
    if (e.status !== "changed" || !e.old) return tags;
    const a = e.old.props || {};
    const b = e.props || {};
    if (e.old.type && e.old.type !== e.type) tags.push({ text: `Type: ${typeName(e.old.type)} → ${typeName(e.type)}` });
    if ((e.old.text || "") !== (e.text || "") && !(Array.isArray(e.segments) && e.segments.length)) tags.push({ text: "Text changed" });
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k]));
    const done = new Set();
    const has = (k) => keys.includes(k) && !done.has(k);
    const take = (...ks) => ks.forEach((k) => done.add(k));
    if (has("checked")) { tags.push({ text: b.checked ? "Checked" : "Unchecked" }); take("checked"); }
    if (has("language")) { tags.push({ text: `Language: ${a.language || "plain"} → ${b.language || "plain"}` }); take("language"); }
    if (has("file_id") || has("url")) {
      tags.push({ text: e.type === "image" ? "Image replaced" : e.type === "file" ? "File replaced" : "Link changed" });
      take("file_id", "url", "name", "size", "content_type", "title", "description");
    }
    if (has("color")) { tags.push({ text: b.color ? "Color changed" : "Color removed" }); take("color"); }
    if (has("icon")) {
      const short = (s) => typeof s === "string" && s.length <= 8 && !s.includes(":");
      const from = a.icon || "💡";
      const to = b.icon || "💡";
      tags.push({ text: short(from) && short(to) ? `Icon: ${from} → ${to}` : "Icon changed" });
      take("icon");
    }
    if (has("width")) { tags.push({ text: "Resized" }); take("width"); }
    if (has("rows")) {
      const ra = Array.isArray(a.rows) ? a.rows : [];
      const rb = Array.isArray(b.rows) ? b.rows : [];
      const cols = (rows) => rows.reduce((n, r) => Math.max(n, Array.isArray(r) ? r.length : 0), 0);
      if (ra.length > rb.length) tags.push({ text: `${plural(ra.length - rb.length, "row")} removed` });
      if (cols(ra) > cols(rb)) tags.push({ text: `${plural(cols(ra) - cols(rb), "column")} removed` });
      take("rows");
    }
    if (has("header_row")) { tags.push({ text: `Header row ${b.header_row ? "on" : "off"}` }); take("header_row"); }
    if (has("header_col")) { tags.push({ text: `Header column ${b.header_col ? "on" : "off"}` }); take("header_col"); }
    if (has("page_id")) { tags.push({ text: "Links to another page" }); take("page_id"); }
    if (has("view_id")) { tags.push({ text: "Other view" }); take("view_id"); }
    if (keys.some((k) => !done.has(k))) tags.push({ text: "Settings changed" });
    return tags;
  }

  function entryNode(e, num) {
    const node = App.el("div", {
      class: `hist-b hist-${e.status}${e.moved ? " is-moved" : ""}`,
      style: `--depth:${Math.max(0, e.depth || 0)}`,
    });
    if (e.status === "same" && e.moved) node.title = "Moved";
    else if (STATUS_WORDS[e.status]) node.title = STATUS_WORDS[e.status];
    const main = App.el("div", { class: "hist-b-main" });
    if (STATUS_WORDS[e.status]) main.append(App.el("span", { class: "sr-only", text: `${STATUS_WORDS[e.status]}: ` }));
    main.append(blockNode(e, {
      num,
      segments: e.status === "changed" ? e.segments : null,
      oldProps: e.status === "changed" && e.type === "table" && e.old && e.old.type === "table" ? e.old.props : null,
    }));
    node.append(main);
    const tags = changeTags(e);
    if (tags.length) {
      node.append(App.el("div", { class: "hist-tags" }, tags.map((t) =>
        App.el("span", { class: `hist-tag${t.kind ? ` hist-tag-${t.kind}` : ""}` },
          t.kind === "moved" ? App.el("span", { html: App.icon("move", 11) }) : null, t.text))));
    }
    return node;
  }

  /* The blocks of a diff, with long runs of unchanged ones folded away: one
     unchanged block stays on each side of a change, for context, and the
     rest of a run becomes a row that unfolds in place. */
  function blocksDiff(entries) {
    const nums = numbering(entries);
    const keep = entries.map(() => false);
    entries.forEach((e, i) => {
      if (!isChange(e)) return;
      keep[i] = true;
      if (i > 0) keep[i - 1] = true;
      if (i + 1 < entries.length) keep[i + 1] = true;
    });
    const box = App.el("div", { class: "hist-blocks" });
    let i = 0;
    while (i < entries.length) {
      if (keep[i]) { box.append(entryNode(entries[i], nums[i])); i++; continue; }
      const start = i;
      while (i < entries.length && !keep[i]) i++;
      const run = entries.slice(start, i).map((e, k) => [e, nums[start + k]]);
      if (run.length === 1) { box.append(entryNode(run[0][0], run[0][1])); continue; }
      const fold = App.el("button", { class: "hist-fold", type: "button", title: "Show these blocks" },
        App.el("span", { html: App.icon("chevron-down", 13) }),
        App.el("span", { text: `${run.length} unchanged blocks` }));
      fold.addEventListener("click", () => fold.replaceWith(...run.map(([e, n]) => entryNode(e, n))));
      box.append(fold);
    }
    return box;
  }

  /* The page's own changes (title, icon, properties, …) as short lines. */
  function pageChanges(changes, pageId) {
    const list = App.el("ul", { class: "hist-pc" });
    const line = (...kids) => list.append(App.el("li", {}, ...kids));
    const key = (text) => App.el("span", { class: "hist-pc-key", text });
    for (const c of changes) {
      switch (c.field) {
        case "title": {
          const segs = Array.isArray(c.segments) && c.segments.length ? c.segments : null;
          if (segs) line(key("Title"), App.el("span", { class: "hist-segs" }, segmentNodes(segs)));
          else line(key("Title"), App.el("span", { text: c.from || "Untitled" }), arrow(), App.el("span", { text: c.to || "Untitled" }));
          break;
        }
        case "icon":
          if (c.from && c.to) line(key("Icon"), iconNode(c.from), arrow(), iconNode(c.to));
          else line(key(c.to ? "Icon added" : "Icon removed"), iconNode(c.to || c.from));
          break;
        case "cover":
          if (c.from && c.to) line(key("Cover changed"), coverThumb(c.from), arrow(), coverThumb(c.to));
          else line(key(c.to ? "Cover added" : "Cover removed"), coverThumb(c.to || c.from));
          break;
        case "kind":
          line(key(c.to === "database" ? "Turned into a database" : "Turned into a page"));
          break;
        case "props": {
          const props = schemaProps(pageId);
          for (const ch of c.changes || []) {
            const prop = props.find((p) => p.id === ch.key);
            const type = prop ? prop.type : null;
            line(key(prop && prop.name ? prop.name : ch.key), valueNode(ch.from, type), arrow(), valueNode(ch.to, type));
          }
          break;
        }
        case "schema":
          for (const ch of c.changes || []) {
            const what = ch.kind === "view" ? "View" : "Property";
            let text = `${what} "${ch.name}" ${ch.change}`;
            if (ch.change === "renamed") text = `${what} "${ch.from}" renamed to "${ch.to}"`;
            line(App.el("span", { text }));
          }
          break;
        case "options":
          for (const ch of c.changes || []) {
            if (ch.key === "full_width") line(App.el("span", { text: `Full width ${ch.to ? "on" : "off"}` }));
            else if (ch.key === "small_text") line(App.el("span", { text: `Small text ${ch.to ? "on" : "off"}` }));
            else if (ch.key === "font") line(key("Font"), App.el("span", { text: FONTS[ch.from || "sans"] || ch.from }), arrow(), App.el("span", { text: FONTS[ch.to || "sans"] || ch.to }));
            else line(key(ch.key), valueNode(ch.from), arrow(), valueNode(ch.to));
          }
          break;
        default:
          line(App.el("span", { text: `${c.field} changed` }));
      }
    }
    return list;
  }

  // --- the page as it was ----------------------------------------------------------------

  function propsList(props, pageId) {
    const keys = Object.keys(props || {});
    if (!keys.length) return null;
    const schema = schemaProps(pageId);
    const ordered = [
      ...schema.filter((p) => keys.includes(p.id)).map((p) => [p.name || p.id, props[p.id], p.type]),
      ...keys.filter((k) => !schema.some((p) => p.id === k)).map((k) => [k, props[k], null]),
    ];
    return App.el("dl", { class: "hist-props" }, ordered.flatMap(([name, v, type]) =>
      [App.el("dt", { text: name }), App.el("dd", {}, valueNode(v, type))]));
  }

  function snapshotView(res, s) {
    const snap = res.snapshot || {};
    const pg = snap.page || {};
    const blocks = Array.isArray(snap.blocks) ? snap.blocks : [];
    const o = pg.options || {};
    const doc = App.el("div", { class: `hist-doc hist-snap${o.font === "serif" ? " hist-font-serif" : o.font === "mono" ? " hist-font-mono" : ""}` });
    doc.append(App.el("p", { class: "hist-lead", text: s.current ? "The page as it is now." : "The page as this session left it." }));
    if (pg.cover) {
      const r = App.files.ref(pg.cover);
      const cover = App.el("div", { class: `hist-cover${r.kind === "gradient" ? ` gradient-${Math.abs(r.n) % 8}` : ""}` });
      if (r.kind === "url") cover.append(App.el("img", { src: r.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }));
      doc.append(cover);
    }
    if (pg.icon) doc.append(App.el("div", { class: "hist-doc-icon" }, iconNode(pg.icon)));
    doc.append(App.el("h1", { class: "hist-doc-title", text: (pg.title || "").trim() || "Untitled" }));
    const props = propsList(pg.props, res.pageId);
    if (props) doc.append(props);
    if (pg.kind === "database") {
      const schema = pg.schema || {};
      const names = (xs) => (Array.isArray(xs) ? xs.map((x) => x.name || x.id).filter(Boolean).join(", ") : "");
      doc.append(App.el("div", { class: "note hist-db-note" }, App.el("span", { html: App.icon("database", 15) }),
        App.el("div", {},
          App.el("p", { text: "A database. Its rows are pages of their own, each with its own history." }),
          names(schema.properties) ? App.el("p", { text: `Properties: ${names(schema.properties)}` }) : null,
          names(schema.views) ? App.el("p", { text: `Views: ${names(schema.views)}` }) : null)));
    }
    if (!blocks.length) {
      if (pg.kind !== "database") doc.append(App.el("p", { class: "hist-lead", text: s.current ? "This page is empty." : "This page was empty." }));
      return doc;
    }
    const nums = numbering(blocks);
    const box = App.el("div", { class: "hist-blocks" });
    blocks.forEach((b, i) => {
      box.append(App.el("div", { class: "hist-b", style: `--depth:${Math.max(0, b.depth || 0)}` },
        App.el("div", { class: "hist-b-main" }, blockNode(b, { num: nums[i] }))));
    });
    doc.append(box);
    return doc;
  }

  // --- the dialog ---------------------------------------------------------------------

  function open(pageId) {
    if (handle) {
      if (handle.pageId === pageId) return;
      handle.close();
    }
    let closed = false;
    const root = App.el("div", { class: "hist-root" });
    const modal = App.ui.modal({
      title: "Page history", body: root, wide: true, className: "history-modal",
      onClose: () => { closed = true; if (handle === modal) handle = null; },
    });
    modal.pageId = pageId;
    handle = modal;

    const st = { sessions: [], byId: new Map(), sel: null, against: "", mode: "changes", userMode: "changes", idle: 10, max: 60 };
    const cache = new Map();
    let seq = 0;
    let layout = null;
    let list = null;
    let head = null;
    let controls = null;
    let view = null;

    // Links inside rendered text: a page link opens that page (the dialog
    // closes first); a dead "#" link does nothing; web links open a new tab.
    root.addEventListener("click", (e) => {
      const a = e.target instanceof Element ? e.target.closest("a") : null;
      if (!a || !root.contains(a)) return;
      if (a.dataset.pageId) {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        modal.close();
        if (App.nav && App.nav.openPage) App.nav.openPage(a.dataset.pageId);
      } else if (a.getAttribute("href") === "#") {
        e.preventDefault();
      }
    });

    const state = (...nodes) => root.replaceChildren(App.el("div", { class: "hist-state" }, ...nodes));
    const spinner = () => App.el("div", { class: "empty-state" }, App.el("div", { class: "spinner" }));
    const retry = (run) => App.el("div", { class: "btn-row", style: "margin-top:.5rem" },
      App.el("button", { class: "btn btn-small", type: "button", text: "Try again", onclick: run }));
    const offline = (run) => App.el("div", { class: "note note-warning" }, App.el("span", { html: App.icon("cloud-off") }),
      App.el("div", {}, App.el("p", { text: "Page history needs a connection. Try again when you are back online." }), retry(run)));
    const failed = (what, e, run) => App.el("div", { class: "note note-danger" }, App.el("span", { html: App.icon("warning") }),
      App.el("div", {}, App.el("p", { text: `Could not load ${what}: ${e.message}` }), retry(run)));

    async function load() {
      if (!navigator.onLine) { state(offline(load)); return; }
      state(spinner());
      let data;
      try {
        data = await App.api.get(`/api/pages/${enc(pageId)}/history`);
      } catch (e) {
        if (!closed) state(failed("the history", e, load));
        return;
      }
      if (closed) return;
      st.sessions = Array.isArray(data && data.sessions) ? data.sessions : [];
      st.byId = new Map(st.sessions.map((s) => [s.id, s]));
      st.idle = (data && data.idle_minutes) || 10;
      st.max = (data && data.max_session_minutes) || 60;
      if (!st.sessions.length) {
        state(App.el("div", { class: "empty-state" },
          App.el("div", { class: "empty-icon", html: App.icon("history", 36) }),
          App.el("h2", { text: "No history yet" }),
          App.el("p", { text: `History starts with the next edit to this page. Edits are grouped into sessions: a session ends after ${plural(st.idle, "minute")} without changes, or once it has run for ${plural(st.max, "minute")}.` })));
        return;
      }
      build();
      select(st.sessions[0].id, { show: false });
      const first = list.querySelector(".hist-item.active");
      if (first) first.focus({ preventScroll: true });
    }

    function build() {
      list = App.el("nav", { class: "hist-list", "aria-label": "Editing sessions" });
      head = App.el("div", { class: "hist-head" });
      controls = App.el("div", { class: "hist-controls" });
      view = App.el("div", { class: "hist-view" });
      const detail = App.el("section", { class: "hist-detail" }, head, controls, view);
      layout = App.el("div", { class: "hist" }, list, detail);
      st.sessions.forEach((s) => list.append(item(s)));
      // Up and down walk the list, as in a file browser.
      list.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const items = [...list.querySelectorAll(".hist-item")];
        const at = items.indexOf(document.activeElement);
        const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
        if (!next || next === document.activeElement) return;
        e.preventDefault();
        next.focus();
        select(next.dataset.id, { show: false });
      });
      root.replaceChildren(layout);
    }

    function badges(s) {
      const out = [];
      if (s.current) out.push(App.el("span", { class: "badge badge-accent", text: "Current version" }));
      if (s.active) out.push(App.el("span", { class: "badge badge-ok", text: "Editing now", title: `Edits in the next ${plural(st.idle, "minute")} join this session` }));
      if (s.baseline) out.push(App.el("span", { class: "badge", text: "Earliest version", title: "How the page looked before history was kept, or the oldest version still kept" }));
      return out;
    }

    function stats(s) {
      const t = s.stats;
      if (!t) return [];
      const chip = (cls, text, title) => App.el("span", { class: `hist-stat ${cls}`, text, title });
      const out = [];
      if (t.added) out.push(chip("add", `+${t.added}`, `${plural(t.added, "block")} added`));
      if (t.removed) out.push(chip("del", `−${t.removed}`, `${plural(t.removed, "block")} removed`));
      if (t.changed) out.push(chip("chg", `~${t.changed}`, `${plural(t.changed, "block")} changed`));
      if (t.moved) out.push(chip("mov", `${t.moved} moved`, `${plural(t.moved, "block")} moved`));
      if (t.page) out.push(chip("page", "Page details", "The title, icon, cover, properties or page settings changed"));
      if (!out.length) out.push(App.el("span", { class: "hist-quiet", text: "No visible changes" }));
      return out;
    }

    function item(s) {
      const who = joinNames(editorNames(s), 3);
      const btn = App.el("button", { class: `hist-item${s.current ? " is-current" : ""}`, type: "button", dataset: { id: s.id } },
        App.el("span", { class: "hist-when", text: span(s), title: fullSpan(s) }),
        who ? App.el("span", { class: "hist-who", text: who, title: editorNames(s).join(", ") }) : null,
        s.baseline ? App.el("span", { class: "hist-hint", text: "The page before history was kept, or the oldest version still kept." }) : null,
        App.el("span", { class: "hist-meta" }, badges(s), stats(s)));
      btn.addEventListener("click", () => select(s.id));
      return btn;
    }

    function select(id, { show = true } = {}) {
      const s = st.byId.get(id);
      if (!s) return;
      st.sel = id;
      st.against = "";
      st.mode = s.baseline ? "snapshot" : st.userMode;
      list.querySelectorAll(".hist-item").forEach((b) => {
        const on = b.dataset.id === id;
        b.classList.toggle("active", on);
        if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
      });
      if (show) layout.classList.add("show-detail");
      renderHead(s);
      renderControls(s);
      renderView();
    }

    function renderHead(s) {
      const who = joinNames(editorNames(s, "you"));
      const back = App.el("button", { class: "btn btn-small hist-back", type: "button", html: `${App.icon("chevron-left", 14)}<span>Sessions</span>` });
      back.addEventListener("click", () => {
        layout.classList.remove("show-detail");
        const it = list.querySelector(".hist-item.active");
        if (it) it.focus({ preventScroll: true });
      });
      let hint = null;
      if (s.active) hint = `This session is still open: edits in the next ${plural(st.idle, "minute")} are added to it.`;
      else if (s.baseline) hint = "The earliest version kept: the page as it was before history began, or the oldest version still kept. There is nothing before it to compare with.";
      head.replaceChildren(back, App.el("div", { class: "hist-head-main" },
        App.el("div", { class: "hist-head-when" }, App.el("span", { text: span(s), title: fullSpan(s) }), badges(s)),
        who ? App.el("div", { class: "hist-head-who", text: `Edited by ${who}` }) : null,
        hint ? App.el("div", { class: "hist-head-hint", text: hint }) : null));
    }

    function renderControls(s) {
      const select_ = App.el("select", { class: "select", "aria-label": "Compare with" });
      const prev = App.el("option", { value: "", text: s.baseline ? "Previous session (none)" : "Previous session" });
      if (s.baseline) prev.disabled = true;
      select_.append(prev);
      for (const o of st.sessions) {
        if (o.id === s.id) continue;
        const label = `${span(o)}${o.current ? " (current)" : o.baseline ? " (earliest)" : ""}`;
        select_.append(App.el("option", { value: o.id, text: label }));
      }
      select_.value = st.against;
      select_.addEventListener("change", () => {
        st.against = select_.value;
        st.mode = st.userMode = "changes";
        renderControls(s);
        renderView();
      });
      const seg = App.el("div", { class: "seg hist-mode", role: "group", "aria-label": "Show" });
      [["changes", "Changes"], ["snapshot", "Page as it was"]].forEach(([mode, label]) => {
        seg.append(App.el("button", {
          class: st.mode === mode ? "active" : "", type: "button", text: label, "aria-pressed": String(st.mode === mode),
          onclick: () => {
            if (st.mode === mode) return;
            st.mode = st.userMode = mode;
            renderControls(s);
            renderView();
          },
        }));
      });
      controls.replaceChildren(
        App.el("label", { class: "hist-compare" }, App.el("span", { text: "Compare with" }), select_),
        seg);
    }

    /* The picked session's changes or snapshot, fetched once per
       (session, compared-with, view) while the dialog is open. */
    function fetchView(s) {
      const snap = st.mode === "snapshot";
      const key = snap ? `${s.id}|snapshot` : `${s.id}|${st.against}|changes`;
      if (!cache.has(key)) {
        const base = `/api/pages/${enc(pageId)}/history/${enc(s.id)}`;
        const url = snap ? base : `${base}/diff${st.against ? `?against=${enc(st.against)}` : ""}`;
        const p = App.api.get(url);
        p.catch(() => cache.delete(key));
        cache.set(key, p);
      }
      return cache.get(key);
    }

    async function renderView() {
      const mine = ++seq;
      const s = st.byId.get(st.sel);
      if (!s) return;
      if (st.mode === "changes" && s.baseline && !st.against) {
        view.replaceChildren(App.el("div", { class: "empty-state" },
          App.el("div", { class: "empty-icon", html: App.icon("history", 36) }),
          App.el("h2", { text: "Nothing to compare with" }),
          App.el("p", { text: "This is the earliest version kept, so there are no changes to show. Look at the page as it was, or pick another session under Compare with." }),
          App.el("div", { class: "btn-row" }, App.el("button", {
            class: "btn btn-small", type: "button", text: "Page as it was",
            onclick: () => { st.mode = st.userMode = "snapshot"; renderControls(s); renderView(); },
          }))));
        return;
      }
      view.replaceChildren(spinner());
      view.scrollTop = 0;
      let res;
      try {
        res = await fetchView(s);
      } catch (e) {
        if (closed || mine !== seq) return;
        view.replaceChildren(navigator.onLine ? failed(st.mode === "snapshot" ? "this version" : "the changes", e, renderView) : offline(renderView));
        return;
      }
      if (closed || mine !== seq) return;
      try {
        view.replaceChildren(st.mode === "snapshot" ? snapshotView({ ...res, pageId }, s) : diffView(res));
      } catch (e) {
        console.error(e);
        view.replaceChildren(failed(st.mode === "snapshot" ? "this version" : "the changes", e, renderView));
      }
      view.scrollTop = 0;
    }

    function diffView(res) {
      const d = res.diff || {};
      const pageCh = Array.isArray(d.page) ? d.page : [];
      const blocks = Array.isArray(d.blocks) ? d.blocks : [];
      const doc = App.el("div", { class: "hist-doc" });
      const label = (x) => `${span(x)}${x.current ? " (current)" : ""}`;
      doc.append(App.el("p", {
        class: "hist-lead",
        text: res.from ? `From ${label(res.from)} to ${label(res.to)}.` : "Compared with an empty page: the page was new in this session.",
      }));
      if (!pageCh.length && !blocks.some(isChange)) {
        doc.append(App.el("div", { class: "empty-state" },
          App.el("h2", { text: "No changes" }),
          App.el("p", {
            text: st.against ? "These two versions of the page are the same."
              : !res.from ? "The page was still empty when this session ended."
                : "This session left the page as the session before it did: its edits cancelled each other out.",
          })));
        return doc;
      }
      if (pageCh.length) {
        if (blocks.length) doc.append(App.el("h3", { class: "section-title", text: "Page" }));
        doc.append(pageChanges(pageCh, pageId));
      }
      if (blocks.length) {
        if (pageCh.length) doc.append(App.el("h3", { class: "section-title", text: "Content" }));
        doc.append(blocksDiff(blocks));
      }
      return doc;
    }

    load();
    return modal;
  }

  return { open };
})();
