/* Markdown and clipboard HTML to block trees, and block trees back to Markdown.

   The block-level half of meerpad's Markdown in the browser (app/mdblocks.py is
   the server's). Inline text is never parsed here: a block's `text` already is
   inline Markdown in meerail's dialect (docs/DESIGN.md §3), so a paragraph's
   source goes into `text` verbatim and comes back out verbatim.

   Trees are the shape App.store.insertTree takes:
     { type, text, props, children }   (children always an array, props an object)

   The public calls:

     parse(markdown)          Markdown -> nodes
     fromHtml(html)           clipboard HTML (browsers, Google Docs, Notion,
                              GitHub, Word) -> nodes
     toMarkdown(nodes)        nodes -> Markdown; parse() inverts it
     blockMarkdown(node)      one block's own Markdown, without its children.
                              The editor's Markdown mode diffs documents on it,
                              so it is a signature: deterministic, and equal
                              for a stored block and for what parse() makes of
                              that block's Markdown when nobody edited it.
     nodesFromTree(tree)      App.store.blockTree output -> nodes (with `id`)
     pageToMarkdown(pageId)   a stored page as a Markdown document

   Two rules keep the round trip exact:

   * **Escapes are a pair of one predicate.** A text line that would read as
     block syntax (`# x`, `- x`, `> x`, a fence, ...) is written with a leading
     backslash, and parse() strips a backslash only when the rest would need
     one. Both sides call needsEscape(), so a line the user typed with a
     backslash of their own survives too (it simply gets one more).
   * **Blank lines count.** An empty paragraph is written as nothing, so the
     usual blank line between blocks grows by two for every empty paragraph,
     and parse() counts runs of blank lines back into empty paragraphs.

   Why not a CommonMark library: this Markdown is not quite CommonMark (tight
   lists of mixed kinds, HTML containers for toggles and callouts, soft breaks
   as plain newlines), and a general parser would turn inline Markdown into a
   tree we would then have to print back. A line classifier that leaves inline
   text alone is both simpler and exact.

   fromHtml() only ever reads a DOMParser document: nothing from the pasted
   HTML runs, loads, or reaches the live page, and the only strings kept from
   attributes are http(s)/mailto//p/ link targets and http(s) image sources. */

window.App = window.App || {};

App.mdblocks = (() => {
  const LIST_TYPES = new Set(["bulleted_list", "numbered_list", "to_do"]);
  const isList = (n) => Boolean(n) && LIST_TYPES.has(n.type);
  const DEFAULT_ICON = "💡";

  const node = (type, text = "", props = {}, children = []) => ({ type, text, props, children });
  const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
  const oneLine = (s) => String(s == null ? "" : s).replace(/\r?\n/g, " ");
  // Blank lines at the edges of a block's text cannot be written (a blank
  // line ends the block), so they are left out of its Markdown. That keeps
  // the signature of an untouched "a\n" equal to the "a" that comes back.
  const trimTail = (s) => s.replace(/(?:\n[ \t]*)+$/, "");
  const trimEdges = (s) => trimTail(s).replace(/^(?:[ \t]*\n)+/, "");

  // An emoji at the start of a string: flags, keycaps, and pictographs with
  // their variation selectors, skin tones, tag sequences and ZWJ joins, so a
  // family or a rainbow flag counts as one icon.
  const EMOJI = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?[\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*)/u;

  // --- lines ---------------------------------------------------------------------
  const isBlank = (line) => /^[ \t]*$/.test(line);
  const lstrip = (line) => line.replace(/^[ \t]+/, "");

  /* Leading whitespace in columns, tabs advancing to the next multiple of 4
     (CommonMark's tab stop), so a tab-indented list nests like a 4-space one. */
  function indentOf(line) {
    let col = 0;
    for (const ch of line) {
      if (ch === " ") col += 1;
      else if (ch === "\t") col += 4 - (col % 4);
      else break;
    }
    return col;
  }

  /* Remove `n` columns of indentation, no more. A tab that straddles the cut
     leaves its remainder as spaces; tabs after the cut (Go code in a list
     item) stay tabs. */
  function dedent(line, n) {
    let col = 0;
    let i = 0;
    while (i < line.length && col < n) {
      const ch = line[i];
      if (ch === " ") { col += 1; i += 1; }
      else if (ch === "\t") {
        const w = 4 - (col % 4);
        if (col + w > n) return " ".repeat(col + w - n) + line.slice(i + 1);
        col += w;
        i += 1;
      } else break;
    }
    return line.slice(i);
  }

  /* A nested region, shifted left by its shallowest non-blank line. */
  function dedentAll(lines) {
    let min = Infinity;
    for (const l of lines) if (!isBlank(l)) min = Math.min(min, indentOf(l));
    if (!min || min === Infinity) return lines;
    return lines.map((l) => dedent(l, min));
  }

  // --- links ---------------------------------------------------------------------
  // A scanner rather than a regex, because file names keep their parentheses
  // ("bestellung (1).pdf" is "bestellung%20(1).pdf" after encodeURIComponent)
  // and captions may hold balanced brackets.

  function closeBracket(s, i) {
    let depth = 0;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "`") {
        // Brackets inside a code span do not count (`a[0]`).
        const c = s.indexOf("`", i + 1);
        if (c !== -1) { i = c; continue; }
      }
      if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) return i;
    }
    return -1;
  }

  function closeParen(s, i) {
    let depth = 0;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return i;
    }
    return -1;
  }

  /* The line is exactly one `[text](dest)` or `![text](dest "title")`:
     {image, text, dest}, else null. */
  function exactLink(line) {
    const t = line.trim();
    const image = t[0] === "!";
    const open = image ? 1 : 0;
    if (t[open] !== "[" || t[t.length - 1] !== ")") return null;
    const close = closeBracket(t, open);
    if (close < 0 || t[close + 1] !== "(") return null;
    const text = t.slice(open + 1, close);
    let dest;
    let title;
    let j = close + 2;
    while (t[j] === " " || t[j] === "\t") j++;
    if (t[j] === "<") {
      const gt = t.indexOf(">", j);
      if (gt < 0) return null;
      dest = t.slice(j + 1, gt);
      title = t.slice(gt + 1, -1);
    } else {
      if (closeParen(t, close + 1) !== t.length - 1) return null;
      const m = /^(\S*)([\s\S]*)$/.exec(t.slice(close + 2, -1).trim());
      dest = m[1];
      title = m[2];
    }
    title = title.trim();
    if (title && !/^("[^"]*"|'[^']*'|\([^)]*\))$/.test(title)) return null;
    return { image, text, dest };
  }

  const decode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };

  /* /api/files/<id>[/<name>][?...] (the app's, a share link's with ?share=)
     or /_files/<id>/<name> (a published site's): {file_id, name?}. */
  function fileRef(dest) {
    const m = /^\/api\/files\/([^/?#]+)(?:\/([^?#]*))?(?:[?#].*)?$/.exec(dest)
      || /^\/_files\/([^/?#]+)\/([^?#]*)(?:[?#].*)?$/.exec(dest);
    if (!m) return null;
    const out = { file_id: decode(m[1]) };
    if (m[2]) out.name = decode(m[2]);
    return out;
  }

  /* A standalone image line that becomes an image block. Other targets
     (relative paths, data: URLs) stay paragraph text. */
  function imageLine(t) {
    const l = exactLink(t);
    if (!l || !l.image) return null;
    const ref = fileRef(l.dest);
    if (ref) return { text: l.text, props: ref };
    if (/^https?:\/\//i.test(l.dest)) return { text: l.text, props: { url: l.dest } };
    return null;
  }

  /* A standalone link to an uploaded file becomes a file block. */
  function fileLine(t) {
    const l = exactLink(t);
    if (!l || l.image) return null;
    const ref = fileRef(l.dest);
    return ref ? { file_id: ref.file_id, name: l.text } : null;
  }

  function fileUrl(fileId, name) {
    if (App.files && typeof App.files.url === "function") return App.files.url(fileId, name);
    return `/api/files/${encodeURIComponent(fileId)}${name ? `/${encodeURIComponent(name)}` : ""}`;
  }

  /* A destination with spaces or unbalanced parentheses goes in <...>, the
     one form a Markdown reader cannot cut short. */
  function dest(url) {
    const s = String(url || "");
    let depth = 0;
    for (const ch of s) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth < 0) break;
    }
    return /\s/.test(s) || depth !== 0 ? `<${s}>` : s;
  }

  // --- line grammar --------------------------------------------------------------
  const FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*(.*)$/;
  const FENCE_CLOSE = /^(`+|~+)[ \t]*$/;
  const DIVIDER = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const HEADING = /^(#{1,6})(?:[ \t]+(.*))?$/;
  const BULLET = /^([-*+])(?:([ \t]+)(.*))?$/;
  const ORDERED = /^(\d{1,9})([.)])(?:([ \t]+)(.*))?$/;
  const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/;
  const DETAILS_OPEN = /^<details(?:\s[^>]*)?>/i;
  const ASIDE_OPEN = /^<aside(?:\s[^>]*)?>/i;
  const BR_LINE = /^<br\s*\/?>[ \t]*$/i;
  const MATH_ONE = /^\$\$(.+)\$\$[ \t]*$/;
  const SEP_CELL = /^:?-+:?$/;
  // Written escaped although not block syntax on their own: a pipe row
  // (spec'd), a $$ that only looks like math, and the container tags, which
  // must never close or open a toggle or callout from inside a paragraph.
  const EXTRA_ESCAPE = /^(?:\||\$\$|<\/?(?:details|summary|aside)\b)/i;

  function fenceOpen(t) {
    const m = FENCE_OPEN.exec(t);
    if (!m) return null;
    // A backtick fence's info string cannot hold a backtick: "```a```" is
    // inline code on a line of its own, not a fence.
    if (m[1][0] === "`" && m[2].includes("`")) return null;
    return { ch: m[1][0], len: m[1].length, info: m[2].trim() };
  }

  /* Cells of a pipe row: outer pipes optional, `\|` is a pipe inside a cell. */
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim());
  }

  /* A delimiter row under a header with `count` cells. It must contain a pipe
     and must not read as a list item ("- | -"), so it can never be mistaken
     for any other block, which keeps the escape predicate local to a line and
     the one after it. */
  function isSeparator(line, count) {
    const s = String(line || "").trim();
    if (!s.includes("|") || /^[-*+](\s|$)/.test(s)) return false;
    const cells = splitRow(s);
    return cells.length === count && cells.every((c) => SEP_CELL.test(c));
  }

  const tableStart = (t, next) => t.includes("|") && t[0] !== "\\" && isSeparator(next, splitRow(t).length);

  /* What block a line starts (its indentation removed), or null for text.
     `next` is the raw line after it, which only a table needs. */
  function blockKind(t, next) {
    if (!t || t[0] === "\\") return null;
    if (fenceOpen(t)) return "code";
    if (t.trim() === "$$" || MATH_ONE.test(t)) return "equation";
    if (DIVIDER.test(t)) return "divider";
    if (HEADING.test(t)) return "heading";
    if (DETAILS_OPEN.test(t)) return "toggle";
    if (ASIDE_OPEN.test(t)) return "callout";
    if (BR_LINE.test(t)) return "br";
    if (t.startsWith("<!--")) return "comment";
    if (t[0] === ">") return "quote";
    if (BULLET.test(t) || ORDERED.test(t)) return "list";
    if (tableStart(t, next)) return "table";
    if (imageLine(t)) return "image";
    if (fileLine(t)) return "file";
    return null;
  }

  /* The escape predicate, shared by writer and reader. Leading backslashes
     are looked through, so text that already starts with one gets another.
     The first line of a paragraph is also escaped when it starts with
     whitespace: indentation there would otherwise be read as a child block
     (or dropped). */
  function needsEscape(line, next, first) {
    const bare = line.replace(/^\\+/, "");
    if (first && /^[ \t]/.test(bare)) return true;
    const t = lstrip(bare);
    return Boolean(blockKind(t, next) || EXTRA_ESCAPE.test(t));
  }

  const unescapeLine = (c, next, first) =>
    (c[0] === "\\" && needsEscape(c.slice(1), next, first) ? c.slice(1) : c);

  /* Escape the lines of a text bottom up: whether a line starts a table
     depends on the line after it, as written (escaped). The last line's
     successor is never a delimiter row (blocks are separated by blank lines,
     list items by marker lines), so "" stands in for it. */
  function escapeLines(lines, first) {
    const out = new Array(lines.length);
    for (let j = lines.length - 1; j >= 0; j--) {
      const next = j + 1 < lines.length ? out[j + 1] : "";
      out[j] = needsEscape(lines[j], next, first && j === 0) ? `\\${lines[j]}` : lines[j];
    }
    return out;
  }

  /* A list item's first line follows its marker, so only what would change
     the marker's meaning needs a backslash: "[ ] x" after "- " (a to-do),
     "- --" (a divider as a whole line), and leading whitespace. */
  function itemNeedsEscape(type, s) {
    const bare = s.replace(/^\\+/, "");
    if (/^[ \t]/.test(bare)) return true;
    return type === "bulleted_list" && (TASK.test(bare) || DIVIDER.test(`- ${bare}`));
  }

  // --- parse -----------------------------------------------------------------------

  function parse(markdown) {
    const src = String(markdown == null ? "" : markdown).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    return parseLines(src.split("\n"));
  }

  /* A run of lines as sibling blocks. Blank runs become empty paragraphs:
     k blank lines between two blocks hold floor((k-1)/2) of them, at either
     end of the run floor(k/2) (the writer's "\n\n" separators around an empty
     string). Lines indented 2+ past a block after a blank line are that
     block's children. */
  function parseLines(lines) {
    const out = [];
    const n = lines.length;
    let i = 0;
    let last = null;
    let lastIndent = 0;
    let started = false;
    const empties = (k) => { for (let e = 0; e < k; e++) out.push(node("paragraph")); };
    while (i < n) {
      const runStart = i;
      while (i < n && isBlank(lines[i])) i++;
      const k = i - runStart;
      if (i >= n) { empties(Math.floor(k / 2)); break; }
      const ind = indentOf(lines[i]);
      if (k > 0 && last && ind >= lastIndent + 2) {
        // Children of a block with no container syntax of its own. The blank
        // lines before them go in too, so empty paragraphs at the start of
        // the children are counted like at the start of a document.
        let end = i;
        let j = i;
        while (j < n) {
          if (isBlank(lines[j])) { j++; continue; }
          if (indentOf(lines[j]) < lastIndent + 2) break;
          j++;
          end = j;
        }
        last.children.push(...parseLines(dedentAll(lines.slice(runStart, end))));
        i = end;
        continue;
      }
      if (k > 0) empties(started ? Math.floor((k - 1) / 2) : Math.floor(k / 2));
      const res = parseBlock(lines, i);
      started = true;
      i = res.next;
      if (res.node) { out.push(res.node); last = res.node; lastIndent = ind; }
    }
    return out;
  }

  function parseBlock(lines, i) {
    const t = lstrip(lines[i]);
    const next = i + 1 < lines.length ? lines[i + 1] : "";
    switch (blockKind(t, next)) {
      case "code": return parseCode(lines, i);
      case "equation": return parseEquation(lines, i);
      case "divider": return { node: node("divider"), next: i + 1 };
      case "heading": {
        const m = HEADING.exec(t);
        return { node: node(`heading_${Math.min(3, m[1].length)}`, (m[2] || "").trim()), next: i + 1 };
      }
      case "toggle": return parseToggle(lines, i);
      case "callout": return parseCallout(lines, i);
      case "br": return { node: node("paragraph"), next: i + 1 };
      case "comment": {
        let j = i;
        let rest = t.slice(4);
        while (!rest.includes("-->") && ++j < lines.length) rest = lines[j];
        return { node: null, next: Math.min(j + 1, lines.length) };
      }
      case "quote": return parseQuote(lines, i);
      case "list": return parseListItem(lines, i);
      case "table": return parseTable(lines, i);
      case "image": {
        const im = imageLine(t);
        return { node: node("image", im.text, im.props), next: i + 1 };
      }
      case "file": return { node: node("file", "", fileLine(t)), next: i + 1 };
      default: return parseParagraph(lines, i);
    }
  }

  /* Consecutive text lines, each a soft break. A continuation keeps any
     indentation beyond the paragraph's own (poems, ASCII art). */
  function parseParagraph(lines, i) {
    const n = lines.length;
    const ind = indentOf(lines[i]);
    const nextOf = (j) => (j + 1 < n ? lines[j + 1] : "");
    const out = [unescapeLine(lstrip(lines[i]), nextOf(i), true)];
    let j = i + 1;
    while (j < n && !isBlank(lines[j]) && !blockKind(lstrip(lines[j]), nextOf(j))) {
      out.push(unescapeLine(dedent(lines[j], ind), nextOf(j), false));
      j++;
    }
    return { node: node("paragraph", out.join("\n")), next: j };
  }

  function parseCode(lines, i) {
    const fenceInd = indentOf(lines[i]);
    const f = fenceOpen(lstrip(lines[i]));
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const m = FENCE_CLOSE.exec(lstrip(lines[j]));
      if (m && m[1][0] === f.ch && m[1].length >= f.len) break;
      body.push(fenceInd ? dedent(lines[j], fenceInd) : lines[j]);
    }
    // An unclosed fence runs to the end, as in CommonMark.
    const language = f.info.split(/\s+/)[0] || "plain";
    return { node: node("code", body.join("\n"), { language }), next: Math.min(j + 1, lines.length) };
  }

  function parseEquation(lines, i) {
    const t = lstrip(lines[i]);
    const one = MATH_ONE.exec(t);
    if (t.trim() !== "$$" && one) return { node: node("equation", one[1].trim()), next: i + 1 };
    const body = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== "$$"; j++) body.push(lines[j]);
    return { node: node("equation", body.join("\n")), next: Math.min(j + 1, lines.length) };
  }

  /* Consecutive `>` lines, one level stripped. The first paragraph is the
     quote's text, everything after it its children (so `>> x` is a quote in
     a quote). A blank first line means the quote's own text is empty. */
  function parseQuote(lines, i) {
    const content = [];
    let j = i;
    while (j < lines.length && /^[ \t]*>/.test(lines[j])) {
      content.push(lines[j].replace(/^[ \t]*> ?/, ""));
      j++;
    }
    let text = "";
    let children;
    if (!content.length || isBlank(content[0])) {
      children = parseLines(content.slice(1));
    } else {
      const nodes = parseLines(content);
      if (nodes[0] && nodes[0].type === "paragraph") {
        text = nodes[0].text;
        children = nodes[0].children.concat(nodes.slice(1));
      } else {
        children = nodes;
      }
    }
    return { node: node("quote", text, {}, children), next: j };
  }

  /* One list item and everything that belongs to it: continuation lines
     right after it (indented, or lazily not) are soft breaks in its text;
     lines indented past its marker, after a blank line or once a nested
     block started, are its children, dedented by their shallowest line.
     Real-world nesting by 2 or 4 spaces or tabs all lands here. */
  function parseListItem(lines, i) {
    const n = lines.length;
    const ind = indentOf(lines[i]);
    const t = lstrip(lines[i]);
    let type;
    let markerLen;
    let gap;
    let rest;
    let m = BULLET.exec(t);
    if (m) {
      type = "bulleted_list";
      markerLen = 1;
      gap = m[2] || "";
      rest = m[3] || "";
    } else {
      m = ORDERED.exec(t);
      type = "numbered_list";
      markerLen = m[1].length + 1;
      gap = m[3] || "";
      rest = m[4] || "";
    }
    // Where continuation text starts. More than 4 columns of gap is
    // CommonMark's "indented code in an item"; treat it as a single space.
    const gapCols = indentOf(gap);
    const contentCol = ind + markerLen + (gapCols >= 1 && gapCols <= 4 ? gapCols : 1);
    let props = {};
    let text = rest;
    if (type === "bulleted_list") {
      const tm = TASK.exec(rest);
      if (tm) {
        type = "to_do";
        props = { checked: tm[1] !== " " };
        text = tm[2] || "";
      }
    }
    if (text[0] === "\\" && itemNeedsEscape(type, text.slice(1))) text = text.slice(1);

    const textLines = [text];
    let j = i + 1;
    let end = i + 1;       // exclusive end of the item's own lines
    let textEnd = i + 1;   // exclusive end of its continuation text
    let inText = true;
    while (j < n) {
      const line = lines[j];
      if (isBlank(line)) { inText = false; j++; continue; }
      const nextLine = j + 1 < n ? lines[j + 1] : "";
      const lt = lstrip(line);
      if (indentOf(line) > ind) {
        if (inText) {
          if (blockKind(lt, nextLine)) inText = false;
          else {
            textLines.push(unescapeLine(dedent(line, contentCol), dedent(nextLine, contentCol), false));
            textEnd = j + 1;
          }
        }
        j++;
        end = j;
        continue;
      }
      if (inText && !blockKind(lt, nextLine)) {
        // Lazy continuation: Notion writes soft breaks in items unindented.
        textLines.push(unescapeLine(lt, nextLine, false));
        j++;
        end = j;
        textEnd = j;
        continue;
      }
      break;
    }
    const region = lines.slice(textEnd, end);
    const children = region.length ? parseLines(dedentAll(region)) : [];
    return { node: node(type, textLines.join("\n"), props, children), next: end };
  }

  function parseTable(lines, i) {
    const rows = [splitRow(lines[i])];
    let j = i + 2;
    while (j < lines.length && !isBlank(lines[j]) && lines[j].includes("|")) rows.push(splitRow(lines[j++]));
    const width = Math.max(...rows.map((r) => r.length));
    const cells = rows.map((r) => {
      const out = r.map((c) => c.replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"));
      while (out.length < width) out.push("");
      return out;
    });
    return { node: node("table", "", { rows: cells, header_row: true, header_col: false }), next: j };
  }

  /* The lines inside <tag>...</tag>, nesting and fence aware, so a toggle in
     a toggle, or "</details>" in a code block, does not close early. The
     opening line's rest counts as content ("<aside>💡 text</aside>"). A
     closing tag counts at the start of a line (or at the end of a line that
     opens the same tag), never in the middle of text. */
  function htmlContainer(lines, i, tag, openRe) {
    const closeStart = new RegExp(`^</${tag}>`, "i");
    const closeEnd = new RegExp(`</${tag}>[ \\t]*$`, "i");
    const t0 = lstrip(lines[i]);
    const first = t0.slice(openRe.exec(t0)[0].length);
    const content = [];
    let depth = 1;
    let fence = null;
    const feed = (line) => {
      const t = lstrip(line);
      if (fence) {
        const m = FENCE_CLOSE.exec(t);
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
        content.push(line);
        return false;
      }
      const f = fenceOpen(t);
      if (f) { fence = f; content.push(line); return false; }
      if (openRe.test(t)) {
        if (!closeEnd.test(t)) depth++;
      } else if (closeStart.test(t) && --depth === 0) {
        return true;
      }
      content.push(line);
      return false;
    };
    let j = i;
    let closed = false;
    if (closeEnd.test(first)) {
      const before = first.replace(closeEnd, "");
      if (!isBlank(before)) content.push(before);
      closed = true;
    } else if (!isBlank(first)) {
      feed(first);
    }
    while (!closed && ++j < lines.length) closed = feed(lines[j]);
    return { content, next: Math.min(j + 1, lines.length) };
  }

  /* <details> with a <summary> (on its own line, on the <details> line, or
     spanning lines for a toggle whose text has soft breaks). */
  function parseToggle(lines, i) {
    const { content, next } = htmlContainer(lines, i, "details", DETAILS_OPEN);
    let k = 0;
    while (k < content.length && isBlank(content[k])) k++;
    let text = "";
    let rest = content;
    const sm = k < content.length ? /^<summary(?:\s[^>]*)?>/i.exec(lstrip(content[k])) : null;
    if (sm) {
      const firstLine = lstrip(content[k]).slice(sm[0].length);
      const parts = [];
      let line = firstLine;
      let q = k;
      for (;;) {
        const c = line.search(/<\/summary>/i);
        if (c >= 0) {
          parts.push(line.slice(0, c));
          const after = line.slice(c + "</summary>".length);
          rest = (isBlank(after) ? [] : [after]).concat(content.slice(q + 1));
          text = parts.join("\n");
          break;
        }
        parts.push(line);
        if (++q >= content.length) {
          // No </summary> at all: the summary is its first line.
          text = firstLine;
          rest = content.slice(k + 1);
          break;
        }
        line = content[q];
      }
    }
    return { node: node("toggle", text, {}, parseLines(dedentAll(rest))), next };
  }

  /* <aside>: the first paragraph, minus a leading emoji (the icon), is the
     callout's text; the blocks after it are its children. */
  function parseCallout(lines, i) {
    const { content, next } = htmlContainer(lines, i, "aside", ASIDE_OPEN);
    const nodes = parseLines(dedentAll(content));
    let icon = DEFAULT_ICON;
    let text = "";
    let children = nodes;
    if (nodes[0] && nodes[0].type === "paragraph") {
      let t = nodes[0].text;
      const m = EMOJI.exec(t);
      if (m) {
        icon = m[0];
        t = t.slice(m[0].length).replace(/^[ \t]+/, "");
      }
      text = t;
      children = nodes[0].children.concat(nodes.slice(1));
    }
    return { node: node("callout", text, { icon }, children), next };
  }

  // --- toMarkdown -----------------------------------------------------------------

  /* Always ends in one newline, which parse() does not count as a blank
     line; an empty paragraph at the end is what adds more. */
  function toMarkdown(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    return list.length ? `${serializeBlocks(list)}\n` : "";
  }

  function blockMarkdown(n) {
    return blockMd(n || {}, 1, false);
  }

  /* Siblings: a blank line between blocks, a single newline between list
     items of any kind (a tight list). Numbers count consecutive numbered
     siblings from 1. */
  function serializeBlocks(nodes) {
    let out = "";
    let num = 0;
    let prev = null;
    for (const n of nodes) {
      num = n.type === "numbered_list" ? num + 1 : 0;
      if (prev) out += isList(prev) && isList(n) ? "\n" : "\n\n";
      out += blockMd(n, num || 1, true);
      prev = n;
    }
    return out;
  }

  const indent = (md, width) => {
    const pad = " ".repeat(width);
    return md.split("\n").map((l) => (l ? pad + l : "")).join("\n");
  };

  function blockMd(n, num, withChildren) {
    const type = n.type || "paragraph";
    const text = n.text == null ? "" : String(n.text);
    const props = n.props || {};
    const kids = withChildren && Array.isArray(n.children) ? n.children : [];
    switch (type) {
      case "bulleted_list":
      case "numbered_list":
      case "to_do": return listMd(type, text, props, kids, num);
      case "toggle": return toggleMd(text, kids);
      case "quote": return quoteMd(text, kids);
      case "callout": return calloutMd(text, props, kids);
      default: break;
    }
    // Blocks without container syntax carry their children indented by two,
    // after a blank line. An empty paragraph is written as nothing, which
    // leaves its children nothing to hang from, so it becomes a <br> line
    // then (parse reads that as an empty paragraph; the signature, which has
    // no children, stays "").
    let own = leafMd(type, text, props);
    if (kids.length && own === "") own = "<br>";
    return kids.length ? `${own}\n\n${indent(serializeBlocks(kids), 2)}` : own;
  }

  function leafMd(type, text, props) {
    switch (type) {
      case "heading_1": return `# ${oneLine(text).trim()}`.trimEnd();
      case "heading_2": return `## ${oneLine(text).trim()}`.trimEnd();
      case "heading_3": return `### ${oneLine(text).trim()}`.trimEnd();
      case "code": return codeMd(text, props);
      case "divider": return "---";
      case "equation": return `$$\n${text}\n$$`;
      case "image": return `![${oneLine(text)}](${dest(mediaSrc(props))})`;
      case "file": return `[${oneLine(props.name || "file")}](${dest(mediaSrc(props))})`;
      case "bookmark": return props.title ? `[${oneLine(props.title)}](${dest(props.url)})` : String(props.url || "");
      case "embed": return String(props.url || "");
      case "table": return tableMd(props);
      case "page":
      case "database": return `[${pageTitle(props.page_id)}](/p/${props.page_id || ""})`;
      default: return escapeLines(trimEdges(text).split("\n"), true).join("\n");
    }
  }

  const mediaSrc = (props) => (props.file_id ? fileUrl(props.file_id, props.name) : String(props.url || ""));

  /* The linked page's title as it is now, not as it was when the link was
     made: page links are live in the editor too. */
  function pageTitle(pageId) {
    let page = null;
    try { page = pageId && App.store && App.store.page ? App.store.page(pageId) : null; } catch (e) { page = null; }
    const title = App.ui && typeof App.ui.titleOf === "function"
      ? App.ui.titleOf(page)
      : (page && page.title && page.title.trim()) || "Untitled";
    return oneLine(title);
  }

  function codeMd(text, props) {
    // One backtick more than the longest run in the source, so no line of
    // the code can close the fence.
    const longest = (text.match(/`+/g) || []).reduce((a, r) => Math.max(a, r.length), 0);
    const fence = "`".repeat(Math.max(3, longest + 1));
    // parse() keeps the info string's first word, so that is all that is
    // written (and a backtick would stop the line being a fence at all).
    const word = String(props.language || "").replace(/`/g, "").trim().split(/\s+/)[0];
    const lang = word && word !== "plain" ? word : "";
    return `${fence}${lang}\n${text ? `${text}\n` : ""}${fence}`;
  }

  /* Markdown needs a header row, so the first row is one whatever
     header_row says (the editor keeps the flag through the signature). */
  function tableMd(props) {
    const rows = Array.isArray(props.rows) && props.rows.length ? props.rows : [[""]];
    const width = Math.max(1, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
    const cell = (c) => String(c == null ? "" : c).trim().replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
    const line = (r) => `| ${Array.from({ length: width }, (_, k) => cell(Array.isArray(r) ? r[k] : "")).join(" | ")} |`;
    return [line(rows[0]), `| ${new Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
  }

  function listMd(type, text, props, kids, num) {
    const marker = type === "numbered_list" ? `${num}.` : "-";
    // Continuation lines and children line up under the item's text: 2 for
    // "- " and "- [ ] ", 3 for "1. ", 4 for "10. ".
    const width = marker.length + 1;
    let head = `${marker} `;
    if (type === "to_do") head += props.checked ? "[x] " : "[ ] ";
    const lines = trimTail(text).split("\n");
    let first = lines[0];
    if (itemNeedsEscape(type, first)) first = `\\${first}`;
    let md = first ? head + first : head.trimEnd();
    const pad = " ".repeat(width);
    for (const l of escapeLines(lines.slice(1), false)) md += `\n${l ? pad + l : ""}`;
    if (kids.length) md += (isList(kids[0]) ? "\n" : "\n\n") + indent(serializeBlocks(kids), width);
    return md;
  }

  function toggleMd(text, kids) {
    const head = `<details>\n<summary>${text}</summary>`;
    return kids.length ? `${head}\n\n${serializeBlocks(kids)}\n\n</details>` : `${head}\n</details>`;
  }

  function quoteMd(text, kids) {
    let lines = escapeLines(trimEdges(text).split("\n"), true);
    if (kids.length) lines = lines.concat([""], serializeBlocks(kids).split("\n"));
    return lines.map((l) => (l ? `> ${l}` : ">")).join("\n");
  }

  function calloutMd(text, props, kids) {
    const icon = (props.icon && String(props.icon).trim()) || DEFAULT_ICON;
    const lines = trimTail(text).split("\n");
    // The icon leads the first line, so that line can never read as block
    // syntax; only the soft-broken lines after it need escapes.
    const body = [`${icon} ${lines[0]}`.trimEnd(), ...escapeLines(lines.slice(1), false)];
    if (kids.length) body.push("", serializeBlocks(kids));
    return `<aside>\n${body.join("\n")}\n</aside>`;
  }

  // --- store trees ----------------------------------------------------------------

  function nodesFromTree(tree) {
    return (Array.isArray(tree) ? tree : []).map((entry) => {
      const b = (entry && entry.block) || {};
      return {
        id: b.id,
        type: b.type || "paragraph",
        text: b.text == null ? "" : String(b.text),
        props: clone(b.props) || {},
        children: nodesFromTree(entry && entry.children),
      };
    });
  }

  function pageToMarkdown(pageId, { title = true } = {}) {
    const page = App.store.page(pageId);
    const head = title && page && page.title && page.title.trim() ? `# ${oneLine(page.title).trim()}\n\n` : "";
    return head + toMarkdown(nodesFromTree(App.store.blockTree(pageId)));
  }

  // --- fromHtml -------------------------------------------------------------------
  // A walk over the parsed body. Block elements become blocks; runs of inline
  // content between them become paragraphs. Inline content is flattened into
  // styled text segments first, and Markdown markers are placed from those,
  // which is what keeps them valid for meerail's inline rules: no marker
  // around whitespace, whitespace moved outside markers, no doubled markers,
  // and no marker spanning a line break.

  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "dialog",
    "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
    "h5", "h6", "header", "hgroup", "hr", "html", "legend", "li", "main", "menu", "nav", "ol", "p", "pre",
    "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  ]);
  const BLOCK_SELECTOR = `${[...BLOCK_TAGS].join(",")},img`;
  const DROP_TAGS = new Set([
    "script", "style", "meta", "link", "title", "head", "template", "iframe", "object", "embed", "svg",
    "noscript", "button", "input", "select", "textarea", "canvas", "video", "audio", "xml", "math", "map",
    "area", "source", "track", "frame", "frameset", "applet", "base", "param",
  ]);

  const tagOf = (el) => String(el.localName || "").toLowerCase();
  const classOf = (el) => String((el.getAttribute && el.getAttribute("class")) || "");

  function cssOf(el) {
    const out = {};
    const raw = el.getAttribute && el.getAttribute("style");
    if (!raw) return out;
    for (const decl of raw.split(";")) {
      const c = decl.indexOf(":");
      if (c > 0) out[decl.slice(0, c).trim().toLowerCase()] = decl.slice(c + 1).replace(/!important/i, "").trim().toLowerCase();
    }
    return out;
  }

  /* Elements that contribute nothing: scripts and media, Word's namespaced
     junk (o:p, v:shape, w:...), its inlined list glyphs (mso-list:Ignore),
     and anything hidden. Comments (Word's conditional ones included) are
     never visited at all. */
  function dropped(el) {
    if (el.nodeType !== 1) return el.nodeType !== 3;
    const tag = tagOf(el);
    if (DROP_TAGS.has(tag) || tag.includes(":")) return true;
    if (el.hasAttribute("hidden")) return true;
    const style = String(el.getAttribute("style") || "").toLowerCase();
    return /display\s*:\s*none|mso-hide\s*:\s*all|mso-list\s*:\s*ignore/.test(style);
  }

  /* An inline element holding blocks (Google Docs wraps a whole copy in one
     <b>) or an image is taken apart like a container. */
  const isBlockish = (el) => BLOCK_TAGS.has(tagOf(el)) || tagOf(el) === "img" || Boolean(el.querySelector(BLOCK_SELECTOR));

  /* The inline style an element adds to the inherited one: tags first, then
     CSS, which may cancel (Google Docs' <b style="font-weight:normal">
     wrapper is not bold, a span at 700 is). */
  function styled(el, st) {
    const s = { ...st };
    const tag = tagOf(el);
    if (tag === "b" || tag === "strong") s.b = true;
    else if (tag === "i" || tag === "em") s.i = true;
    else if (tag === "s" || tag === "del" || tag === "strike") s.s = true;
    else if (tag === "mark") s.m = true;
    else if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") s.code = true;
    else if (tag === "a") {
      // Only what the inline renderer would link anyway (DESIGN §3).
      const href = String(el.getAttribute("href") || "").trim();
      s.href = /^(https?:|mailto:)/i.test(href) || /^\/p\/\S/.test(href) ? href : null;
    }
    const css = cssOf(el);
    const fw = css["font-weight"] || "";
    if (/^(bold|bolder)$/.test(fw) || (/^\d+$/.test(fw) && Number(fw) >= 600)) s.b = true;
    else if (/^(normal|lighter)$/.test(fw) || (/^\d+$/.test(fw) && Number(fw) < 600)) s.b = false;
    const fs = css["font-style"] || "";
    if (/^(italic|oblique)/.test(fs)) s.i = true;
    else if (fs === "normal") s.i = false;
    if (/line-through/.test(`${css["text-decoration"] || ""} ${css["text-decoration-line"] || ""}`)) s.s = true;
    // Headings are bold by nature; a bold span inside one is not emphasis.
    if (s.nob) s.b = false;
    return s;
  }

  function collect(n, st, segs) {
    if (n.nodeType === 3) {
      const text = n.nodeValue.replace(/[\u200B\uFEFF]/g, "").replace(/\s+/g, " ");
      if (text) segs.push({ ...st, text });
      return;
    }
    if (n.nodeType !== 1 || dropped(n)) return;
    const tag = tagOf(n);
    if (tag === "br") { segs.push({ br: true }); return; }
    if (tag === "img") return;
    // Blocks inside inline context (a table cell, a heading) are lines.
    const block = BLOCK_TAGS.has(tag);
    if (block) segs.push({ br: true });
    const s2 = styled(n, st);
    for (const c of n.childNodes) collect(c, s2, segs);
    if (block) segs.push({ br: true });
  }

  const STYLE_KEYS = ["b", "i", "s", "m", "code"];
  const MARK = { b: "**", s: "~~", m: "==", i: "*" };
  const sameStyle = (a, b) => STYLE_KEYS.every((k) => Boolean(a[k]) === Boolean(b[k])) && (a.href || null) === (b.href || null);
  const codeSpan = (s) => (s.includes("`") ? s : `\`${s}\``);

  /* One run of segments (no line breaks, one link target) to Markdown.
     Markers open just before text and close just after it; a style that
     lasts longer opens first, so it wraps the shorter ones. Emphasis is
     always innermost: meerail's *em* cannot contain another asterisk. */
  function renderStyled(group) {
    let out = "";
    let pending = "";
    const stack = [];
    const runLength = (k, from) => {
      let len = 0;
      for (let q = from; q < group.length; q++) {
        if (!group[q].text.trim()) continue;
        if (!group[q][k]) break;
        len++;
      }
      return len;
    };
    group.forEach((seg, idx) => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(seg.text);
      pending += m[1];
      if (!m[2]) { pending += m[3]; return; }
      const want = ["b", "s", "m", "i"].filter((k) => seg[k]);
      let keep = 0;
      while (keep < stack.length && want.includes(stack[keep])) keep++;
      const needsOuter = want.some((k) => k !== "i" && !stack.slice(0, keep).includes(k));
      if (needsOuter && keep > 0 && stack[keep - 1] === "i") keep--;
      for (let q = stack.length - 1; q >= keep; q--) out += MARK[stack[q]];
      stack.length = keep;
      out += pending;
      pending = "";
      const toOpen = want
        .filter((k) => !stack.includes(k))
        .sort((a, b) => (a === "i") - (b === "i") || runLength(b, idx) - runLength(a, idx));
      for (const k of toOpen) { out += MARK[k]; stack.push(k); }
      out += seg.code ? codeSpan(m[2]) : m[2];
      pending = m[3];
    });
    for (let q = stack.length - 1; q >= 0; q--) out += MARK[stack[q]];
    return out + pending;
  }

  /* [text](href) with the whitespace outside. meerail's link rule takes no
     "]" or line break in the text and no ")" or space in the target, so the
     target is percent-encoded and an unrepresentable text stays plain. */
  function linkMd(inner, href) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    if (!m[2] || /[\]\n]/.test(m[2])) return inner;
    const url = href.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
    return `${m[1]}[${m[2]}](${url})${m[3]}`;
  }

  function renderSegs(segs) {
    const merged = [];
    for (const s of segs) {
      const prev = merged[merged.length - 1];
      if (prev && !prev.br && !s.br && sameStyle(prev, s)) prev.text += s.text;
      else merged.push({ ...s });
    }
    let out = "";
    let i = 0;
    while (i < merged.length) {
      if (merged[i].br) { out += "\n"; i++; continue; }
      const href = merged[i].href || null;
      const group = [];
      while (i < merged.length && !merged[i].br && (merged[i].href || null) === href) group.push(merged[i++]);
      const inner = renderStyled(group);
      out += href ? linkMd(inner, href) : inner;
    }
    return out.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
  }

  function inlineOf(nodes, st) {
    const segs = [];
    for (const c of nodes) collect(c, st, segs);
    return renderSegs(segs);
  }

  function blocksOf(childNodes, st) {
    const out = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const text = inlineOf(run, st);
      run = [];
      // Word and Google Docs space paragraphs with empty ones; never keep them.
      if (text) out.push(node("paragraph", text));
    };
    for (const c of childNodes) {
      if (c.nodeType === 3) { run.push(c); continue; }
      if (c.nodeType !== 1 || dropped(c)) continue;
      if (isBlockish(c)) { flush(); out.push(...blockNodes(c, st)); } else run.push(c);
    }
    flush();
    return nestWordLists(out);
  }

  function blockNodes(el, st) {
    const tag = tagOf(el);
    const s2 = styled(el, st);
    if (/^h[1-6]$/.test(tag)) {
      const text = inlineOf(el.childNodes, { ...s2, b: false, nob: true }).replace(/\s*\n\s*/g, " ");
      return text ? [node(`heading_${Math.min(3, Number(tag[1]))}`, text)] : [];
    }
    switch (tag) {
      case "ul":
      case "ol": return listNodes(el, s2);
      case "li": return listItemNode(el, "bulleted_list", s2, false);
      case "blockquote": return quoteNode(el, s2);
      case "pre": return [codeNode(el)];
      case "hr": return [node("divider")];
      case "img": return imageNode(el, "");
      case "figure": return figureNode(el, s2);
      case "table": return tableNode(el, s2);
      case "details": return toggleNode(el, s2);
      case "aside": return calloutNode(blocksOf(el.childNodes, s2));
      default: break;
    }
    if (tag === "p" && isWordListPara(el)) return wordItem(el, s2);
    if (tag === "p" && /\bMsoTitle\b/.test(classOf(el))) {
      const text = inlineOf(el.childNodes, { ...s2, b: false, nob: true }).replace(/\s*\n\s*/g, " ");
      return text ? [node("heading_1", text)] : [];
    }
    // p, div, section, a transparent inline wrapper: loose inline runs
    // become paragraphs, blocks inside stay blocks.
    return blocksOf(el.childNodes, s2);
  }

  function listNodes(listEl, st) {
    const type = tagOf(listEl) === "ol" ? "numbered_list" : "bulleted_list";
    const todo = /\b(to-do-list|contains-task-list)\b/.test(classOf(listEl));
    const out = [];
    for (const c of listEl.childNodes) {
      if (c.nodeType !== 1 || dropped(c)) continue;
      const t = tagOf(c);
      if (t === "li") {
        out.push(...listItemNode(c, type, st, todo));
      } else if (t === "ul" || t === "ol") {
        // A list directly inside a list (Google Docs, older editors) nests
        // under the item before it.
        const items = listNodes(c, st);
        const prev = out[out.length - 1];
        if (prev && isList(prev)) prev.children.push(...items);
        else out.push(...items);
      } else {
        out.push(...(isBlockish(c) ? blockNodes(c, st) : blocksOf([c], st)));
      }
    }
    return out;
  }

  /* One <li>. Its first paragraph is the item's text, everything after it
     (nested lists, further paragraphs, code) its children. A checkbox, a
     GitHub task-list class, Notion's to-do markup or an aria-checked makes
     it a to-do. */
  function listItemNode(li, type, st, todoList) {
    const own = (sel) => Array.from(li.querySelectorAll(sel)).filter((e) => e.closest("li") === li);
    const box = own('input[type="checkbox" i]')[0];
    const notionBox = own(".checkbox-on, .checkbox-off")[0];
    const aria = li.getAttribute("aria-checked");
    const isTodo = Boolean(box || notionBox) || aria !== null || /\btask-list-item\b/.test(classOf(li)) || todoList;
    let checked = false;
    if (box) checked = box.hasAttribute("checked");
    else if (notionBox) checked = notionBox.classList.contains("checkbox-on");
    else if (aria !== null) checked = aria === "true";
    else checked = own(".to-do-children-checked").length > 0;
    const blocks = blocksOf(li.childNodes, st);
    // Notion wraps each toggle in <ul class="toggle"><li>.
    if (blocks.length === 1 && blocks[0].type === "toggle") return blocks;
    let text = "";
    let children = blocks;
    if (blocks[0] && blocks[0].type === "paragraph") {
      text = blocks[0].text;
      children = blocks[0].children.concat(blocks.slice(1));
    }
    if (!text && !children.length) return [];
    return [node(isTodo ? "to_do" : type, text, isTodo ? { checked } : {}, children)];
  }

  function quoteNode(bq, st) {
    const blocks = blocksOf(bq.childNodes, st);
    if (!blocks.length) return [];
    if (blocks[0].type === "paragraph") return [node("quote", blocks[0].text, {}, blocks[0].children.concat(blocks.slice(1)))];
    return [node("quote", "", {}, blocks)];
  }

  function codeLanguage(pre) {
    const code = pre.querySelector("code");
    for (const el of [pre, code, pre.parentElement]) {
      if (!el || !el.getAttribute) continue;
      const cls = classOf(el);
      const m = /(?:^|\s)(?:language|lang)-(\S+)/i.exec(cls) || /(?:^|\s)highlight-source-(\S+)/i.exec(cls);
      if (m) return m[1].toLowerCase();
      // GitHub writes <pre lang="python">; a parent's lang is a human language.
      const attr = el !== pre.parentElement && (el.getAttribute("lang") || el.getAttribute("data-language") || el.getAttribute("data-lang"));
      if (attr) return attr.toLowerCase();
    }
    return "plain";
  }

  function codeNode(pre) {
    let text = "";
    const walk = (n) => {
      if (n.nodeType === 3) { text += n.nodeValue; return; }
      if (n.nodeType !== 1 || dropped(n)) return;
      const tag = tagOf(n);
      if (tag === "br") { text += "\n"; return; }
      // Some editors put each line of code in its own <div>.
      const blk = BLOCK_TAGS.has(tag);
      if (blk && text && !text.endsWith("\n")) text += "\n";
      n.childNodes.forEach(walk);
      if (blk && text && !text.endsWith("\n")) text += "\n";
    };
    pre.childNodes.forEach(walk);
    return node("code", text.replace(/\u00A0/g, " ").replace(/\n$/, ""), { language: codeLanguage(pre) });
  }

  function imageNode(img, caption) {
    const src = String(img.getAttribute("src") || "").trim();
    return /^https?:\/\//i.test(src) ? [node("image", caption, { url: src })] : [];
  }

  function figureNode(fig, st) {
    // Notion's HTML export writes callouts as <figure class="callout">.
    if (/\bcallout\b/.test(classOf(fig))) return calloutNode(blocksOf(fig.childNodes, st));
    const img = Array.from(fig.querySelectorAll("img")).find((im) => /^https?:\/\//i.test(im.getAttribute("src") || ""));
    if (img) {
      const cap = fig.querySelector("figcaption");
      return imageNode(img, cap ? inlineOf(cap.childNodes, st).replace(/\s*\n\s*/g, " ") : "");
    }
    return blocksOf(fig.childNodes, st);
  }

  function tableNode(table, st) {
    const trs = Array.from(table.rows || []);
    if (!trs.length) return [];
    const cellText = (cell) => blocksOf(cell.childNodes, st).map((b) => b.text).filter(Boolean).join("\n");
    const rows = trs.map((tr) => {
      const cells = [];
      for (const cell of Array.from(tr.cells)) {
        cells.push(cellText(cell));
        const span = Math.min(Number(cell.getAttribute("colspan")) || 1, 50);
        for (let k = 1; k < span; k++) cells.push("");
      }
      return cells;
    });
    const width = Math.max(1, ...rows.map((r) => r.length));
    rows.forEach((r) => { while (r.length < width) r.push(""); });
    const firstCells = Array.from(trs[0].cells);
    const headerRow = Boolean(table.tHead) || (firstCells.length > 0 && firstCells.every((c) => tagOf(c) === "th"));
    const body = trs.slice(headerRow ? 1 : 0);
    const headerCol = body.length > 0 && body.every((tr) => tr.cells[0] && tagOf(tr.cells[0]) === "th");
    return [node("table", "", { rows, header_row: headerRow, header_col: headerCol })];
  }

  function toggleNode(details, st) {
    const summary = Array.from(details.children).find((c) => tagOf(c) === "summary");
    const text = summary ? inlineOf(summary.childNodes, st) : "";
    const children = blocksOf(Array.from(details.childNodes).filter((c) => c !== summary), st);
    return text || children.length ? [node("toggle", text, {}, children)] : [];
  }

  function calloutNode(blocks) {
    let icon = DEFAULT_ICON;
    let text = "";
    let children = blocks;
    if (blocks[0] && blocks[0].type === "paragraph") {
      let t = blocks[0].text;
      const m = EMOJI.exec(t);
      if (m) {
        icon = m[0];
        t = t.slice(m[0].length).replace(/^\s+/, "");
      }
      children = blocks[0].children.concat(blocks.slice(1));
      // An icon in its own element (Notion's <span class="icon">) leaves the
      // text in the next paragraph.
      if (!t && m && children[0] && children[0].type === "paragraph" && !children[0].children.length) {
        t = children[0].text;
        children = children.slice(1);
      }
      text = t;
    }
    return text || children.length ? [node("callout", text, { icon }, children)] : [];
  }

  // Word: list items are paragraphs with a level in their mso-list style and
  // the bullet or number inlined as text (in a span marked mso-list:Ignore).
  const isWordListPara = (el) => /\bMsoListParagraph/i.test(classOf(el)) || /mso-list\s*:\s*l\d/i.test(el.getAttribute("style") || "");

  function wordItem(p, st) {
    const style = p.getAttribute("style") || "";
    const level = /level(\d+)/i.exec(style);
    const glyphEls = Array.from(p.querySelectorAll("span")).filter((s) => /mso-list\s*:\s*ignore/i.test(s.getAttribute("style") || ""));
    let glyph = glyphEls.map((s) => s.textContent).join("").replace(/\s+/g, " ").trim();
    let text = inlineOf(p.childNodes, st);
    if (!glyphEls.length) {
      const m = /^([·•▪◦§Ø\-\u2013\u2014*☐□☒☑]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s+/.exec(text);
      if (m) {
        glyph = m[1];
        text = text.slice(m[0].length);
      }
    }
    if (!text) return [];
    // Word also styles the indented paragraphs under an item "List
    // Paragraph". With no list in the style and no glyph, it is one of those:
    // a paragraph inside the item above, not an item of its own.
    if (!glyph && !/mso-list\s*:\s*l\d/i.test(style)) return [Object.assign(node("paragraph", text), { _cont: true })];
    let item;
    if (/^[☐□]$/.test(glyph)) item = node("to_do", text, { checked: false });
    else if (/^[☒☑]$/.test(glyph)) item = node("to_do", text, { checked: true });
    else item = node(/^\(?(\d{1,3}|[a-z]{1,2}|[ivxlcdm]{1,6})[.)]$/i.test(glyph) ? "numbered_list" : "bulleted_list", text);
    item._level = level ? Number(level[1]) : 1;
    return [item];
  }

  /* Word's flat, levelled list paragraphs to nested items. (The _level and
     _cont marks are dropped when fromHtml copies the tree out.) */
  function nestWordLists(blocks) {
    if (!blocks.some((b) => b._level)) return blocks;
    const out = [];
    const stack = [];
    for (const b of blocks) {
      if (!b._level) {
        if (b._cont && stack.length) { stack[stack.length - 1].node.children.push(b); continue; }
        stack.length = 0;
        out.push(b);
        continue;
      }
      const lvl = b._level;
      delete b._level;
      while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
      if (stack.length) stack[stack.length - 1].node.children.push(b);
      else out.push(b);
      stack.push({ lvl, node: b });
    }
    return out;
  }

  function fromHtml(html) {
    if (!html) return [];
    // DOMParser gives an inert document: no script runs, no image loads, and
    // nothing of it is ever attached to the page.
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    if (!doc.body) return [];
    const nodes = blocksOf(doc.body.childNodes, {});
    const tidy = (list) => list.map((n) => ({
      type: n.type,
      text: n.text || "",
      props: n.props || {},
      children: tidy(n.children || []),
    }));
    return tidy(nodes);
  }

  return { parse, fromHtml, toMarkdown, blockMarkdown, nodesFromTree, pageToMarkdown };
})();
