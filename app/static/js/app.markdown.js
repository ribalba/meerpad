/* meerpad markdown: meerail's parser, ported. One grammar, three consumers.

   The inline rules, the line grammar and the whole-document editor are
   meerail's (app/static/js/app.markdown.js there), kept rule for rule so a
   block's text reads the same in the mail app, in this editor and on a
   published site (app/mdinline.py is the Python port of the same rules). What
   meerpad adds is small and listed where it happens:

     * `==highlight==` (a <mark>), matched after ~~strike~~ as mdinline.py does;
     * internal links `[Title](/p/<page_id>)`, allowed next to http(s) and
       mailto (docs/DESIGN.md §3);
     * `\n` inside a block's text is a soft line break;
     * no address printed after a link: meerail does that for plain-text mail
       readers (its hrefTag), and a web page has no such reader.

   The consumers:

     inline(text, {keep})  one block's text. keep: false is the reader: markers
                           are consumed and `**a**` becomes a bold "a". keep:
                           true is the editor: markers are KEPT and dimmed, so
                           textContent still equals the source and a caret
                           offset in the DOM is an offset into the text.
     editor(el)            meerail's composer, a whole document of lines, for
                           the editor's Markdown mode.
     toHtml(md)            meerail's reader for a whole document (copy as
                           text/html).

   Everything is escaped on the way in and the HTML is assembled here, so no
   page content ever reaches innerHTML unescaped. */

window.App = window.App || {};

App.markdown = (function () {
  const esc = App.esc;

  // --- Inline spans -----------------------------------------------------
  // `keep` is what separates the two consumers: it decides whether a marker
  // is emitted as dimmed text or swallowed. Every rule must round-trip when
  // keep is on: the editor relies on textContent still equalling the source.

  function mark(s, keep) {
    return keep ? `<span class="md-mark">${esc(s)}</span>` : "";
  }

  // /p/<page_id>, optionally with a #fragment (a block or heading on that
  // page). The same pattern as mdinline.py's _INTERNAL.
  const INTERNAL = /^\/p\/([A-Za-z0-9-]{1,64})(#[A-Za-z0-9_-]{1,100})?$/;

  function internalId(u) {
    const m = INTERNAL.exec(String(u || ""));
    return m ? { id: m[1], frag: m[2] || "" } : null;
  }

  // javascript: and data: URLs must never survive into an href. meerpad also
  // allows its own page links (DESIGN §3); anything else renders as "#".
  function safeUrl(u) {
    const s = String(u == null ? "" : u).trim();
    if (internalId(s)) return s;
    return /^(https?:|mailto:)/i.test(s) ? s : "#";
  }

  // Where an internal link goes in this app. The shell knows (a share view
  // maps /p/<id> into its own /s/<token>/<id> space); without it, /p/<id>.
  function pageHref(id, frag, opts) {
    if (opts && opts.pageHref) return opts.pageHref(id) + frag;
    if (App.nav && App.nav.pageHref) return App.nav.pageHref(id) + frag;
    return `/p/${id}${frag}`;
  }

  // The opening tag of a link in the reader. External links open in a new
  // tab; internal ones navigate in place and carry the page id, which is how
  // the editor recognises them without parsing the address again.
  function anchorOpen(url, opts, cls) {
    const c = cls ? ` class="${cls}"` : "";
    const internal = internalId(url);
    if (internal) {
      return `<a${c} href="${esc(pageHref(internal.id, internal.frag, opts))}" data-page-id="${esc(internal.id)}"`
        + `${internal.frag ? ` data-frag="${esc(internal.frag.slice(1))}"` : ""}>`;
    }
    const href = safeUrl(url);
    if (href === "#") return `<a${c} href="#">`;
    if (/^mailto:/i.test(href)) return `<a${c} href="${esc(href)}">`;
    return `<a${c} href="${esc(href)}" target="_blank" rel="noopener noreferrer">`;
  }

  function wrap(tag, delim, inner, keep, opts) {
    return mark(delim, keep) + `<${tag}>` + inlineHtml(inner, keep, opts) + `</${tag}>` + mark(delim, keep);
  }

  // In the editor (keep on) a link's words sit in an element of their own
  // between the dimmed `[` and `](url)`. With opts.anchors that element is a
  // real <a> (the block editor makes links clickable in blocks that are not
  // being edited); without it, meerail's plain span.
  function keptLink(innerHtml, url, opts) {
    if (opts && opts.anchors) return anchorOpen(url, opts, "md-link") + innerHtml + "</a>";
    return `<span class="md-link">${innerHtml}</span>`;
  }

  const RULES = [
    // Code first: nothing inside a code span is markdown.
    { re: /`([^`\n]+)`/,
      build: (m, k) => mark("`", k) + `<code class="md-code">${esc(m[1])}</code>` + mark("`", k) },
    // The trailing lookahead makes the lazy match skip a closing run that is
    // really a longer delimiter, so `**bold *and em***` closes where it should.
    { re: /\*\*(\S(?:[^\n]*?\S)?)\*\*(?!\*)/, build: (m, k, o) => wrap("strong", "**", m[1], k, o) },
    { re: /~~(\S(?:[^\n]*?\S)?)~~(?!~)/,        build: (m, k, o) => wrap("del", "~~", m[1], k, o) },
    // meerpad: ==highlight==, in the position mdinline.py gives it, so a tie
    // at one index resolves the same way in both implementations.
    { re: /==(\S(?:[^\n]*?\S)?)==(?!=)/,        build: (m, k, o) => wrap("mark", "==", m[1], k, o) },
    // Emphasis needs the delimiter to sit on a word boundary, or every
    // snake_case identifier and *.txt glob in a page turns italic.
    { re: /(?<![\w*])\*(\S(?:[^\n*]*?\S)?)\*(?![\w*])/, build: (m, k, o) => wrap("em", "*", m[1], k, o) },
    { re: /(?<![\w_])_(\S(?:[^\n_]*?\S)?)_(?![\w_])/,   build: (m, k, o) => wrap("em", "_", m[1], k, o) },
    { re: /\[([^\]\n]*)\]\(([^)\s]+)\)/,
      build: (m, k, o) => k
        ? mark("[", k) + keptLink(inlineHtml(m[1], k, o), m[2], o) + mark(`](${m[2]})`, k)
        : anchorOpen(m[2], o, internalId(m[2]) ? "md-internal" : "") + inlineHtml(m[1], k, o) + "</a>" },
    // Bare URLs. The trailing-character class keeps sentence punctuation out
    // of the link, which otherwise swallows the full stop after a URL.
    { re: /(?<![\w@.])(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/,
      build: (m, k, o) => k
        ? keptLink(esc(m[1]), m[1], o)
        : anchorOpen(m[1], o, "") + esc(m[1]) + "</a>" },
  ];

  function inlineHtml(src, keep, opts) {
    let out = "", rest = String(src == null ? "" : src);
    while (rest) {
      let best = null;
      for (const rule of RULES) {
        const m = rule.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { rule, m };
      }
      if (!best) return out + esc(rest);
      out += esc(rest.slice(0, best.m.index)) + best.rule.build(best.m, keep, opts);
      rest = rest.slice(best.m.index + best.m[0].length);
    }
    return out;
  }

  /* One block's text as HTML. keep: true is the editor's rendering, where
     the `\n` of a soft break stays a character (the block is white-space:
     pre-wrap) so offsets keep matching the source; the reader turns it into a
     <br>, as mdinline.py does. */
  function inline(text, opts = {}) {
    const src = String(text == null ? "" : text);
    if (opts.keep) return inlineHtml(src, true, opts);
    return src.split("\n").map((line) => inlineHtml(line, false, opts)).join("<br>");
  }

  // The words a reader sees, markers consumed (search snippets, card titles,
  // alt text). Built from the same rules, so it can never disagree with the
  // rendering about what is a marker.
  function plainLine(src) {
    let out = "", rest = src;
    while (rest) {
      let best = null;
      for (const rule of RULES) {
        const m = rule.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { rule, m };
      }
      if (!best) return out + rest;
      out += rest.slice(0, best.m.index);
      const m = best.m;
      // Code and bare URLs are their own text; the others recurse, since a
      // link's words or bold's inside can carry markers of their own.
      out += best.rule === RULES[0] || best.rule === RULES[RULES.length - 1] ? m[1] : plainLine(m[1]);
      rest = rest.slice(m.index + m[0].length);
    }
    return out;
  }

  function plain(text) {
    return String(text == null ? "" : text).split("\n").map(plainLine).join("\n");
  }

  // --- Line classification ---------------------------------------------
  // Shared by both whole-document consumers so a line can never mean one
  // thing while being typed and another once rendered.

  const RE = {
    fence:   /^\s*(```|~~~)/,
    heading: /^(#{1,6})(\s+)(.*)$/,
    quote:   /^(\s*>+)(\s?)(.*)$/,
    bullet:  /^(\s*)([-*+])(\s+)(.*)$/,
    ordered: /^(\s*)(\d{1,9}[.)])(\s+)(.*)$/,
    hr:      /^\s*([-*_])(?:\s*\1){2,}\s*$/,
    // meerpad: a task item's box, the container tags app.mdblocks.js writes
    // for toggles and callouts, and a display equation's $$ fence.
    task:    /^(\[[ xX]\])(\s+|$)(.*)$/,
    html:    /^\s*<\/?(details|summary|aside)\b[^>]*>.*$/i,
    math:    /^\s*\$\$\s*$/,
    image:   /^\s*!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/,
    table:   /^\s*\|.*\|\s*$/,
  };

  // Which lines sit inside a ``` block. Needed as a whole-body pass because a
  // line's meaning depends on how many fences precede it.
  function fenceFlags(lines) {
    const out = [];
    let inside = false;
    for (const line of lines) {
      const delim = RE.fence.test(line);
      out.push(delim ? "delim" : inside ? "in" : "");
      if (delim) inside = !inside;
    }
    return out;
  }

  // --- Reader: markdown -> HTML ----------------------------------------
  // meerail's, grown what a page needs that a mail does not: nested lists by
  // indentation, task items, pipe tables and standalone images. Used for the
  // text/html half of a copy, so a paste into a mail or a document keeps its
  // shape.

  const indentOf = (s) => (/^\s*/.exec(s)[0].replace(/\t/g, "    ").length);

  function imageSrc(u) {
    // Images may also come from this server's own file routes.
    return /^(https?:)/i.test(u) || /^\/(api\/files|_files)\//.test(u) ? u : "";
  }

  // A run of list lines (at any depth) to nested <ul>/<ol>. Items deeper than
  // the first one's indentation nest inside the previous item.
  function listHtml(lines) {
    let i = 0;
    function level(minIndent) {
      let html = "", tag = null;
      while (i < lines.length) {
        const line = lines[i];
        const ind = indentOf(line);
        if (ind < minIndent) break;
        const ordered = RE.ordered.exec(line);
        const m = ordered || RE.bullet.exec(line);
        if (!m) { i++; continue; }
        const t = ordered ? "ol" : "ul";
        if (tag && t !== tag) { html += `</${tag}><${t}>`; tag = t; }
        if (!tag) { html += `<${t}>`; tag = t; }
        i++;
        let body = m[4];
        const task = !ordered && RE.task.exec(body);
        let li = "";
        if (task) {
          const on = task[1] !== "[ ]";
          li = `<input type="checkbox" disabled${on ? " checked" : ""}> ${inline(task[3])}`;
        } else {
          li = inline(body);
        }
        if (i < lines.length && indentOf(lines[i]) > ind) li += level(indentOf(lines[i]));
        html += `<li>${li}</li>`;
      }
      return tag ? html + `</${tag}>` : html;
    }
    return level(0);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"));
  }

  function toHtml(text) {
    const lines = String(text == null ? "" : text).split(/\r?\n/);
    const flags = fenceFlags(lines);
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (flags[i] === "delim") {                       // fenced code block
        const body = [];
        i++;
        while (i < lines.length && flags[i] === "in") body.push(lines[i++]);
        if (i < lines.length && flags[i] === "delim") i++;
        out.push(`<pre class="md-pre"><code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if (RE.hr.test(line)) { out.push("<hr>"); i++; continue; }

      const h = RE.heading.exec(line);
      if (h) {
        const n = h[1].length;
        out.push(`<h${n}>${inline(h[3])}</h${n}>`);
        i++;
        continue;
      }

      const img = RE.image.exec(line);
      if (img && imageSrc(img[2])) {
        out.push(`<p><img src="${esc(imageSrc(img[2]))}" alt="${esc(img[1])}"></p>`);
        i++;
        continue;
      }

      // A pipe table: a row, then the |---| separator.
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
        const cell = (tag, c) => `<${tag}>${inline(c)}</${tag}>`;
        out.push(`<table><thead><tr>${head.map((c) => cell("th", c)).join("")}</tr></thead>`
          + `<tbody>${rows.map((r) => `<tr>${r.map((c) => cell("td", c)).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }

      if (RE.quote.test(line)) {                        // quoted blocks
        // One level per blockquote: `>> a` is a quote of a quote, so only one
        // `>` comes off here and the recursion takes the next. RE.quote's `>+`
        // would take both and flatten the two into one.
        const inner = [];
        while (i < lines.length && RE.quote.test(lines[i])) {
          inner.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${toHtml(inner.join("\n"))}</blockquote>`);
        continue;
      }

      const isItem = (s) => RE.bullet.exec(s) || RE.ordered.exec(s);
      if (isItem(line)) {
        // The whole run, nested items and their continuation lines included.
        const run = [];
        while (i < lines.length && lines[i].trim() && flags[i] === ""
               && (isItem(lines[i]) || indentOf(lines[i]) > 0)) run.push(lines[i++]);
        out.push(listHtml(run));
        continue;
      }

      // The container tags app.mdblocks.js writes are structure, not words;
      // a toggle's summary line carries its title, which is kept.
      const summary = /^\s*(?:<details[^>]*>)?\s*<summary>(.*)<\/summary>\s*$/i.exec(line);
      if (summary) { out.push(`<p>${inline(summary[1])}</p>`); i++; continue; }
      if (RE.html.test(line) || RE.math.test(line)) { i++; continue; }

      // Paragraph. Line breaks are preserved rather than reflowed: a soft
      // break inside a block is a line break the author typed.
      const para = [];
      while (i < lines.length && lines[i].trim() && flags[i] === "" &&
             !RE.hr.test(lines[i]) && !RE.heading.test(lines[i]) &&
             !RE.quote.test(lines[i]) && !isItem(lines[i]) && !RE.html.test(lines[i])) {
        // app.mdblocks.js escapes a line that would read as block syntax with
        // a leading backslash; the reader drops it again.
        para.push(inline(lines[i].replace(/^\\(?=[#>\-*+|`$!<\d~_[\s\\])/, "")));
        i++;
      }
      if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
      else i++;
    }
    return out.join("");
  }

  // --- Composer: live-preview editor -----------------------------------
  // meerail's composer, used whole for the block editor's Markdown mode. The
  // DOM is one `div.md-line` per line of source. That model is what keeps
  // this tractable: a newline is a block boundary rather than a character, so
  // typing only ever repaints the line under the caret, and reading the
  // document back is a join over the children.

  function lineParts(text, fence) {
    if (fence === "in")    return { cls: "md-in-code", html: esc(text) };
    if (fence === "delim") return { cls: "md-fence", html: mark(text, true) };
    if (RE.hr.test(text))  return { cls: "md-hr", html: mark(text, true) };
    // A toggle's title: the tags dim, the words stay words.
    const sm = /^(\s*(?:<details[^>]*>)?\s*<summary>)(.*?)(<\/summary>\s*)$/i.exec(text);
    if (sm) return { cls: "md-summary", html: mark(sm[1], true) + inlineHtml(sm[2], true) + mark(sm[3], true) };
    if (RE.math.test(text) || RE.html.test(text)) return { cls: "md-tagline", html: mark(text, true) };

    const h = RE.heading.exec(text);
    if (h) return { cls: `md-h md-h${h[1].length}`, html: mark(h[1], true) + esc(h[2]) + inlineHtml(h[3], true) };

    const q = RE.quote.exec(text);
    if (q) return { cls: "md-quote", html: mark(q[1], true) + esc(q[2]) + inlineHtml(q[3], true) };

    const li = RE.bullet.exec(text) || RE.ordered.exec(text);
    if (li) {
      // meerpad: a task item's box dims with the bullet.
      const task = RE.bullet.test(text) && RE.task.exec(li[4]);
      if (task) {
        return { cls: `md-li md-task${task[1] === "[ ]" ? "" : " md-done"}`,
          html: esc(li[1]) + mark(li[2], true) + esc(li[3]) + mark(task[1], true) + esc(task[2]) + inlineHtml(task[3], true) };
      }
      return { cls: "md-li", html: esc(li[1]) + mark(li[2], true) + esc(li[3]) + inlineHtml(li[4], true) };
    }

    if (RE.table.test(text)) return { cls: "md-table", html: inlineHtml(text, true) };

    return { cls: "", html: inlineHtml(text, true) };
  }

  function editor(el) {
    // Non-breaking spaces are what contenteditable leaves behind for a trailing
    // space; normalise on the way out so the document gets a real space.
    const norm = (s) => String(s).replace(/ /g, " ");
    const lineDivs = () => Array.from(el.children);

    let hist = [{ text: "", caret: 0 }];
    let hidx = 0;
    let histTimer = null;
    // Told after every repaint, and after every change the user makes (the
    // block editor saves Markdown mode's text back into blocks when it goes
    // quiet).
    let rendered = null;
    let changed = null;
    const notify = () => { if (rendered) rendered(); };
    const touch = () => { if (changed) changed(); };

    function paint(div, text, fence) {
      const { cls, html } = lineParts(text, fence);
      div.className = "md-line" + (cls ? " " + cls : "");
      div.dataset.src = text;
      div.dataset.fence = fence;
      div.innerHTML = html || "<br>";     // an empty div has no height without it
    }

    // --- caret <-> character offset ---
    function closestLine(node) {
      let n = node && node.nodeType === 3 ? node.parentNode : node;
      while (n && n !== el && n.parentNode !== el) n = n.parentNode;
      return n && n.parentNode === el ? n : null;
    }

    function globalOffset(node, off) {
      const divs = lineDivs();
      if (node === el) {                                 // selection on the root
        return divs.slice(0, off).reduce((n, d) => n + norm(d.textContent).length + 1, 0);
      }
      const line = closestLine(node);
      if (!line) return -1;
      let base = 0;
      for (const d of divs) {
        if (d === line) break;
        base += norm(d.textContent).length + 1;
      }
      const r = document.createRange();
      r.selectNodeContents(line);
      r.setEnd(node, off);
      return base + norm(r.toString()).length;
    }

    function caretOffset() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return -1;
      return globalOffset(sel.anchorNode, sel.anchorOffset);
    }

    function selectionRange() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return null;
      const r = sel.getRangeAt(0);
      const a = globalOffset(r.startContainer, r.startOffset);
      const b = globalOffset(r.endContainer, r.endOffset);
      return a < 0 || b < 0 ? null : [Math.min(a, b), Math.max(a, b)];
    }

    function placeInLine(div, off) {
      const walk = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      let node = null, at = 0, seen = 0, n;
      while ((n = walk.nextNode())) {
        if (seen + n.data.length >= off) { node = n; at = off - seen; break; }
        seen += n.data.length;
      }
      const r = document.createRange();
      if (node) r.setStart(node, Math.max(0, Math.min(at, node.data.length)));
      else { r.selectNodeContents(div); r.collapse(false); }
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }

    function placeGlobal(off) {
      const divs = lineDivs();
      for (const d of divs) {
        const len = norm(d.textContent).length;
        if (off <= len) return placeInLine(d, off);
        off -= len + 1;
      }
      const last = divs[divs.length - 1];
      if (last) placeInLine(last, norm(last.textContent).length);
    }

    // --- reading / writing the whole document ---
    // This is the one place that decides what the user actually typed, so it
    // walks textContent rather than innerText. innerText reports the <br> that
    // gives an empty line its height as a real line break, which would turn
    // every blank line into two, and since sync() compares against
    // textContent, the two readings would disagree and edits would land at the
    // wrong offset.
    const BLOCK = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6])$/;

    function collect(node, lines) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { lines[lines.length - 1] += norm(n.data); continue; }
        if (n.nodeType !== 1) continue;
        if (n.nodeName === "BR") {
          // Alone in a block it is only a height placeholder, not a break.
          if (n.previousSibling || n.nextSibling) lines.push("");
          continue;
        }
        if (BLOCK.test(n.nodeName) && lines[lines.length - 1] !== "") lines.push("");
        collect(n, lines);
      }
      return lines;
    }

    function readAll() {
      const lines = [];
      for (const n of el.childNodes) {
        if (n.nodeType === 3) lines.push(norm(n.data));
        else if (n.nodeName === "BR") lines.push("");
        else if (n.nodeType === 1) lines.push(...collect(n, [""]));
      }
      return lines.join("\n");
    }

    function rebuild(text, caret) {
      const lines = String(text).split(/\r?\n/);
      const flags = fenceFlags(lines);
      el.innerHTML = "";
      const frag = document.createDocumentFragment();
      lines.forEach((t, i) => {
        const d = document.createElement("div");
        paint(d, t, flags[i]);
        frag.appendChild(d);
      });
      el.appendChild(frag);
      el.classList.toggle("is-empty", lines.length === 1 && lines[0] === "");
      if (caret >= 0) placeGlobal(caret);
      notify();
    }

    // Repaint whatever changed. The fast path touches only lines whose text or
    // fence state actually moved; the rebuild is a safety net for the times the
    // browser restructures the DOM out from under us (drag-drop, some IMEs).
    function sync() {
      const divs = lineDivs();
      const canonical = divs.length > 0 && divs.length === el.childNodes.length &&
        divs.every((d) => d.nodeName === "DIV" && !d.querySelector("div,p"));
      if (!canonical) return rebuild(readAll(), caretOffset());

      const texts = divs.map((d) => norm(d.textContent));
      const flags = fenceFlags(texts);
      const sel = window.getSelection();
      const active = sel && sel.rangeCount && el.contains(sel.anchorNode) ? closestLine(sel.anchorNode) : null;

      divs.forEach((d, i) => {
        if (d.dataset.src === texts[i] && d.dataset.fence === flags[i]) return;
        const off = d === active ? globalOffsetInLine(d) : -1;
        paint(d, texts[i], flags[i]);
        if (off >= 0) placeInLine(d, Math.min(off, texts[i].length));
      });
      el.classList.toggle("is-empty", texts.length === 1 && texts[0] === "");
      notify();
    }

    // A DOM Range over [start, end) of the source text, or null when the text
    // is not that long. The inverse of globalOffset: lines are the children,
    // and every line but the last is followed by one newline that has no node.
    function pointAt(off) {
      for (const d of lineDivs()) {
        const len = norm(d.textContent).length;
        if (off <= len) {
          const walk = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
          let n, seen = 0, last = null;
          while ((n = walk.nextNode())) {
            if (seen + n.data.length >= off) return [n, off - seen];
            seen += n.data.length;
            last = n;
          }
          return last ? [last, last.data.length] : [d, 0];
        }
        off -= len + 1;
      }
      return null;
    }

    function rangeFor(start, end) {
      const a = pointAt(start);
      const b = pointAt(end);
      if (!a || !b) return null;
      const r = document.createRange();
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
      return r;
    }

    function globalOffsetInLine(div) {
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(div);
      r.setEnd(sel.anchorNode, sel.anchorOffset);
      return norm(r.toString()).length;
    }

    // Replace the selection with `str`, splitting it into lines. Enter and
    // paste both route through here so the browser never gets to invent its
    // own block structure.
    function insertText(str) {
      const range = selectionRange();
      if (!range) return;
      const text = readAll();
      const next = text.slice(0, range[0]) + str + text.slice(range[1]);
      rebuild(next, range[0] + str.length);
      record(true);
      touch();
    }

    // --- undo/redo ---
    // Rewriting innerHTML on every keystroke throws away the browser's own undo
    // stack, so the composer keeps one. Without this Ctrl-Z silently does
    // nothing while writing, which is worse than no live preview at all.
    function record(immediate) {
      clearTimeout(histTimer);
      const commit = () => {
        const text = readAll();
        if (text === hist[hidx].text) return;
        hist = hist.slice(0, hidx + 1);
        hist.push({ text, caret: caretOffset() });
        if (hist.length > 300) hist.shift();
        hidx = hist.length - 1;
      };
      if (immediate) commit(); else histTimer = setTimeout(commit, 250);
    }

    function undo() {
      clearTimeout(histTimer);
      const text = readAll();
      if (text !== hist[hidx].text) {                    // fold in the un-committed edit
        hist = hist.slice(0, hidx + 1);
        hist.push({ text, caret: caretOffset() });
        hidx = hist.length - 1;
      }
      if (hidx === 0) return;
      hidx--;
      rebuild(hist[hidx].text, hist[hidx].caret);
      touch();
    }

    function redo() {
      if (hidx >= hist.length - 1) return;
      hidx++;
      rebuild(hist[hidx].text, hist[hidx].caret);
      touch();
    }

    // --- list continuation ---
    // Enter inside a list carries the marker to the next line so a list can be
    // typed straight through. An item that is still empty ends the list
    // instead: the marker is taken away and you carry on in plain text, which
    // is the only way out that doesn't involve deleting it by hand.
    function currentItem() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return null;
      const line = closestLine(sel.anchorNode);
      if (!line) return null;
      const text = norm(line.textContent);
      const ordered = RE.ordered.test(text);
      const m = ordered ? RE.ordered.exec(text) : RE.bullet.exec(text);
      if (!m) return null;
      // 1. -> 2. and 1) -> 2), keeping whichever delimiter was used.
      let marker = ordered ? (parseInt(m[2], 10) + 1) + m[2].slice(-1) : m[2];
      // meerpad: a task item continues as a fresh, unticked task.
      const task = !ordered && RE.task.exec(m[4]);
      if (task) marker += " [ ]";
      const rest = task ? task[3] : m[4];
      return { line, empty: rest === "", prefix: m[1] + marker + m[3] };
    }

    function replaceLine(line, text) {
      const divs = lineDivs();
      const idx = divs.indexOf(line);
      if (idx < 0) return;
      let start = 0;
      for (let i = 0; i < idx; i++) start += norm(divs[i].textContent).length + 1;
      const all = readAll();
      const end = start + norm(line.textContent).length;
      rebuild(all.slice(0, start) + text + all.slice(end), start + text.length);
      record(true);
      touch();
    }

    function onEnter() {
      const item = currentItem();
      if (!item) return insertText("\n");
      if (item.empty) return replaceLine(item.line, "");
      insertText("\n" + item.prefix);
    }

    // --- wiring ---
    el.addEventListener("input", () => { sync(); record(false); touch(); });

    el.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      // meerpad: Tab indents the line rather than leaving the document, which
      // is what a nested list needs.
      if (e.key === "Tab" && !mod && !e.altKey) {
        e.preventDefault();
        if (!e.shiftKey) { insertText("  "); return; }
        const sel = selectionRange();
        const line = sel && closestLine(window.getSelection().anchorNode);
        if (line) {
          const t = norm(line.textContent);
          const strip = t.startsWith("  ") ? 2 : t.startsWith(" ") ? 1 : 0;
          if (strip) replaceLine(line, t.slice(strip));
        }
        return;
      }
      if (e.key === "Enter" && !mod && !e.altKey) { e.preventDefault(); onEnter(); }
    });

    el.addEventListener("paste", (e) => {
      e.preventDefault();
      insertText((e.clipboardData || window.clipboardData).getData("text/plain").replace(/\r\n?/g, "\n"));
    });

    // Clicking the padding below the last line should land the caret in the
    // document, not do nothing.
    el.addEventListener("mousedown", (e) => {
      if (e.target !== el) return;
      e.preventDefault();
      el.focus();
      const last = el.lastElementChild;
      if (last) placeInLine(last, norm(last.textContent).length);
    });

    function setText(text) {
      rebuild(text || "", -1);
      hist = [{ text: text || "", caret: 0 }];
      hidx = 0;
    }

    setText("");

    return {
      getText: readAll,
      setText,
      // Rewrite the document as a single undoable edit. setText() is for
      // opening a fresh document and throws the history away with the old
      // text; this is for changing text the user is already working on, which
      // they must be able to take back with Ctrl-Z.
      replaceText(text, caret) {
        rebuild(text || "", caret >= 0 ? caret : -1);
        record(true);
      },
      focus(atEnd) {
        el.focus();
        const last = el.lastElementChild;
        if (atEnd && last) placeInLine(last, norm(last.textContent).length);
      },
      // For code that draws on the text without owning it: told after every
      // repaint, and able to turn source offsets into Ranges and back. The
      // caret is -1 when it is not in the editor at all.
      onRender(fn) { rendered = fn; },
      onChange(fn) { changed = fn; },
      rangeFor,
      caret: caretOffset,
      setCaret: placeGlobal,
    };
  }

  return { inline, inlineHtml: (src, keep, opts) => inlineHtml(src, keep, opts), plain, safeUrl, internalId, toHtml, editor, RE, fenceFlags };
})();
