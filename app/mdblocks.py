"""Markdown to block trees and back.

The block-level half of meerpad's Markdown: ``parse_markdown`` turns a document
into a list of ``BlockNode`` trees (docs/DESIGN.md §2), ``blocks_to_markdown``
writes them back out, and ``page_to_markdown`` exports a stored page. Inline
text is never touched here: a block's ``text`` already *is* inline Markdown in
meerail's dialect (§3), so a paragraph's source goes into ``text`` verbatim and
comes back out verbatim.

The dialect is the one Notion's "Markdown & CSV" export writes, because that is
what the importer (app/notion_import.py) reads and what the export should give
back:

* ``#``, ``##``, ``###`` headings (deeper levels become ``heading_3``);
* paragraphs, whose consecutive lines are soft breaks (``\\n`` in ``text``);
* ``-``/``*``/``+`` bullets, ``1.`` numbered items and ``- [ ]``/``- [x]``
  to-dos, nested by indentation (Notion writes 4 spaces; 2 or more is accepted);
* ``>`` quotes, fenced code with a language, ``---`` dividers, ``$$`` equations;
* GFM pipe tables, standalone ``![alt](src)`` images;
* Notion's HTML leftovers: ``<aside>`` for callouts and
  ``<details><summary>`` for toggles;
* and one container of meerpad's own: ``<grid columns="N">`` holding a
  ``<cell>`` per cell, for grids (DESIGN §2, Grids).

Any other HTML stays as text.

Why not a CommonMark library: Notion's output is not quite CommonMark (a
two-space gap after ``- [ ]``, soft breaks written as unindented lines inside
list items, callouts as raw HTML), and a general parser would turn inline
Markdown into a tree we would then have to print back. A line classifier that
leaves inline text alone is both simpler and exact.

The round trip is the contract the tests hold: for every tree ``t`` that
``parse_markdown`` produces, ``parse_markdown(blocks_to_markdown(t)) == t``.
"""

import re
import unicodedata
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .models import Block, Page


@dataclass
class BlockNode:
    """One block and the blocks nested in it. ``text``/``props`` as in DESIGN §2."""

    type: str
    text: str = ""
    props: dict = field(default_factory=dict)
    children: list["BlockNode"] = field(default_factory=list)


LIST_TYPES = ("bulleted_list", "numbered_list", "to_do")
# Text-bearing blocks whose text is inline Markdown (code and equations are raw).
INLINE_TYPES = (
    "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list", "numbered_list",
    "to_do", "toggle", "quote", "callout",
)
INDENT = "    "


# --- Links -------------------------------------------------------------------
#
# Shared with the importer, which rewrites link targets. Notion percent-encodes
# the targets it writes, but a file name like "bestellung-6_(1).pdf" keeps its
# parentheses, and a folder like "[Archive] Hochebene" puts brackets in the link
# text, so a regex would cut both short. This scanner balances them.


@dataclass
class Link:
    start: int      # offset of "[" (or of "!" for an image)
    end: int        # offset just past ")"
    text: str       # the part between the brackets, as written
    target: str     # the part between the parentheses, as written
    image: bool     # written as ![text](target)


def _close_bracket(s: str, i: int) -> int:
    """Index of the "]" matching the "[" at ``i``, or -1."""
    depth = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "`":
            # Brackets inside a code span do not count (`a[0]`).
            close = s.find("`", i + 1)
            if close != -1:
                i = close + 1
                continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return i
        elif ch == "\n" and i + 1 < len(s) and s[i + 1] == "\n":
            return -1  # a link never spans a paragraph break
        i += 1
    return -1


def _close_paren(s: str, i: int) -> int:
    """Index of the ")" closing the "(" at ``i`` (nested pairs balanced), or -1.

    Notion cuts file and folder names at about 50 characters, which can leave a
    target with an unbalanced "(" ("KiZi%20(brainstorming;%20Ma/x.pdf"). When
    the pairs never balance, the last ")" on the line closes the link, as long
    as the target has no whitespace (Notion percent-encodes its spaces)."""
    start = i
    depth = 0
    last = -1
    while i < len(s):
        ch = s[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "\n":
            break
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
            last = i
        i += 1
    if last != -1 and not any(c.isspace() for c in s[start + 1:last]):
        return last
    return -1


def find_links(text: str) -> Iterator[Link]:
    """Every ``[text](target)`` and ``![alt](target)`` in ``text``, left to right.

    Code spans are skipped: nothing inside one is Markdown (DESIGN §3)."""
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "`":
            close = text.find("`", i + 1)
            if close != -1 and "\n" not in text[i:close]:
                i = close + 1
                continue
        if ch == "[":
            close = _close_bracket(text, i)
            if close != -1 and close + 1 < n and text[close + 1] == "(":
                end = _close_paren(text, close + 1)
                if end != -1:
                    image = i > 0 and text[i - 1] == "!"
                    start = i - 1 if image else i
                    yield Link(start, end + 1, text[i + 1:close], text[close + 2:end], image)
                    i = end + 1
                    continue
        i += 1


def whole_link(text: str) -> Link | None:
    """The link when ``text`` is exactly one link (or image) and nothing else."""
    s = text.strip()
    if not s.startswith(("[", "![")):
        return None
    for link in find_links(s):
        return link if link.start == 0 and link.end == len(s) else None
    return None


# --- Callout icons ---------------------------------------------------------------

_EMOJI_TAIL = {"\ufe0f", "\ufe0e", "\u20e3"}


def _is_emoji_start(ch: str) -> bool:
    cp = ord(ch)
    if cp >= 0x1F000:
        return True
    return unicodedata.category(ch) == "So" and cp >= 0x2100


# A Tabler icon (DESIGN §1) as a callout's first word: "icon:<name>" or
# "icon:<name>:<colour>". Only its shape is checked; an unknown name or colour
# is the renderer's business.
TABLER_ICON_RE = re.compile(r"icon:[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z]+)?(?=\s|\Z)")  # as app.mdblocks.js ICON_REF


def split_icon(text: str) -> tuple[str | None, str]:
    """Split a leading emoji (with its modifiers, ZWJ parts and flag pair) or
    Tabler icon off ``text``: Notion writes a callout's icon as the first
    character of its text, and meerpad writes its own icons the same way."""
    m = TABLER_ICON_RE.match(text)
    if m:
        return m.group(), text[m.end():].lstrip(" \t\n")
    if not text or not _is_emoji_start(text[0]):
        return None, text
    i = 1
    n = len(text)
    flag = 0x1F1E6 <= ord(text[0]) <= 0x1F1FF
    while i < n:
        ch = text[i]
        cp = ord(ch)
        if ch in _EMOJI_TAIL or 0x1F3FB <= cp <= 0x1F3FF or 0xE0020 <= cp <= 0xE007F:
            i += 1
        elif ch == "\u200d" and i + 1 < n:
            i += 2
        elif flag and i == 1 and 0x1F1E6 <= cp <= 0x1F1FF:
            i += 1
        else:
            break
    return text[:i], text[i:].lstrip(" \t\n")


# --- Parsing ---------------------------------------------------------------------

FENCE_RE = re.compile(r"^(`{3,}|~{3,})\s*([^`\s]*)")
HEADING_RE = re.compile(r"^(#{1,6})(?:[ \t]+(.*))?$")
HR_RE = re.compile(r"^([-*_])(?:[ \t]*\1){2,}$")
TODO_RE = re.compile(r"^[-*+][ \t]+\[([ xX])\](?:[ \t]+(.*))?$")
BULLET_RE = re.compile(r"^[-*+](?:[ \t]+(.*))?$")
# Only "1." counts: Notion always writes that, and "1) Pflügen" in running
# text is a paragraph somebody typed, not a list.
NUMBER_RE = re.compile(r"^(\d{1,9})\.(?:[ \t]+(.*))?$")
QUOTE_RE = re.compile(r"^>[ \t]?(.*)$")
TABLE_SEP_RE = re.compile(r"^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$")
SUMMARY_RE = re.compile(r"<summary>(.*?)</summary>", re.DOTALL | re.IGNORECASE)
# Formatting tags Notion may wrap a toggle's summary in. Only these: a general
# tag pattern would also eat an autolink such as <https://example.com>.
TAG_RE = re.compile(r"</?(?:strong|b|em|i|u|s|del|code|mark|span|h[1-6])(?:\s[^>]*)?>", re.IGNORECASE)
CELL_SPLIT_RE = re.compile(r"(?<!\\)\|")
BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
# <grid columns="3">, quoted or not. Leading zeros are dropped here so that
# the digits left say how big the number is.
COLUMNS_RE = re.compile(r"\bcolumns\s*=\s*[\"']?0*(\d+)", re.IGNORECASE)


def _indent(line: str) -> int:
    """Leading whitespace width, a tab counting as 4 columns."""
    n = 0
    for ch in line:
        if ch == " ":
            n += 1
        elif ch == "\t":
            n += 4
        else:
            break
    return n


def _dedent(line: str, width: int) -> str:
    """Remove up to ``width`` columns of leading whitespace."""
    i = 0
    col = 0
    while i < len(line) and col < width and line[i] in " \t":
        col += 4 if line[i] == "\t" else 1
        i += 1
    return line[i:]


def _dedent_block(lines: list[str]) -> list[str]:
    widths = [_indent(ln) for ln in lines if ln.strip()]
    if not widths:
        return lines
    width = min(widths)
    return [_dedent(ln, width) for ln in lines]


def _is_table_start(lines: list[str], i: int) -> bool:
    return (
        lines[i].strip().startswith("|")
        and i + 1 < len(lines)
        and bool(TABLE_SEP_RE.match(lines[i + 1].strip()))
        and "-" in lines[i + 1]
    )


def _image_line(s: str) -> Link | None:
    link = whole_link(s)
    return link if link is not None and link.image else None


def _starts_block(lines: list[str], i: int) -> bool:
    """Does line ``i`` open a block of its own (so it cannot continue a paragraph)?"""
    s = lines[i].strip()
    if not s:
        return True
    low = s[:9].lower()
    return bool(
        FENCE_RE.match(s)
        or s.startswith("$$")
        # A cell's tags too, so that inside a grid the blocks outside every
        # cell end where the next cell begins (or a stray closing tag is).
        or low.startswith(("<aside", "<details", "<grid", "<cell", "</cell"))
        or HEADING_RE.match(s)
        or HR_RE.match(s)
        or TODO_RE.match(s)
        or BULLET_RE.match(s)
        or NUMBER_RE.match(s)
        or QUOTE_RE.match(s)
        or _is_table_start(lines, i)
        or _image_line(s)
    )


def _split_cells(row: str) -> list[str]:
    row = row.strip().removeprefix("|")
    if row.endswith("|") and not row.endswith("\\|"):
        row = row[:-1]
    return [BR_RE.sub("\n", c.strip().replace("\\|", "|")) for c in CELL_SPLIT_RE.split(row)]


def _html_section(lines: list[str], i: int, tag: str) -> tuple[list[str], int]:
    """The lines between ``<tag>`` (at line ``i``) and its closing tag, nested
    sections of the same tag included. Returns (inner lines, index after)."""
    open_tag, close_tag = f"<{tag}", f"</{tag}>"
    first = lines[i].strip()
    rest = first[first.find(">") + 1:] if ">" in first else ""
    inner: list[str] = []
    depth = 1
    pending = [rest]
    i += 1
    while True:
        for piece in pending:
            low = piece.lower()
            pos = 0
            while True:
                o = low.find(open_tag, pos)
                c = low.find(close_tag, pos)
                if c == -1 and o == -1:
                    break
                if o != -1 and (c == -1 or o < c):
                    depth += 1
                    pos = o + len(open_tag)
                    continue
                depth -= 1
                if depth == 0:
                    before = piece[:c]
                    if before.strip():
                        inner.append(before)
                    return inner, i
                pos = c + len(close_tag)
            inner.append(piece)
        if i >= len(lines):
            return inner, i  # unclosed: runs to the end
        pending = [lines[i]]
        i += 1


def _merge_leading_paragraphs(blocks: list[BlockNode]) -> tuple[str, list[BlockNode]]:
    parts = []
    while blocks and blocks[0].type == "paragraph" and not blocks[0].children:
        parts.append(blocks.pop(0).text)
    return "\n\n".join(parts), blocks


def _parse(lines: list[str], cells: bool = False) -> list[BlockNode]:
    """Blocks from ``lines``. ``cells`` is set for the inside of a grid, where
    a ``<cell>`` section is a ``grid_cell``; anywhere else its tags are text."""
    out: list[BlockNode] = []
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        s = raw.strip()
        if not s:
            i += 1
            continue
        ind = _indent(raw)
        low = s[:9].lower()

        m = FENCE_RE.match(s)
        if m:
            fence = m.group(1)
            body = []
            i += 1
            while i < n:
                t = lines[i].strip()
                if t.startswith(fence) and set(t) == {fence[0]}:
                    i += 1
                    break
                body.append(_dedent(lines[i], ind))
                i += 1
            out.append(BlockNode("code", "\n".join(body), {"language": m.group(2) or "plain"}))
            continue

        if s.startswith("$$"):
            rest = s[2:]
            if rest.endswith("$$") and rest.strip() != "":
                out.append(BlockNode("equation", rest[:-2].strip()))
                i += 1
                continue
            body = [rest] if rest.strip() else []
            i += 1
            while i < n:
                t = lines[i].rstrip()
                if t.strip().endswith("$$"):
                    last = t.strip()[:-2]
                    if last.strip():
                        body.append(_dedent(last, 0))
                    i += 1
                    break
                body.append(_dedent(t, ind))
                i += 1
            out.append(BlockNode("equation", "\n".join(body).strip("\n")))
            continue

        if low.startswith("<aside"):
            inner, i = _html_section(lines, i, "aside")
            blocks = _parse(_dedent_block(inner))
            text, children = _merge_leading_paragraphs(blocks)
            icon, text = split_icon(text)
            out.append(BlockNode("callout", text, {"icon": icon} if icon else {}, children))
            continue

        if low.startswith("<details"):
            inner, i = _html_section(lines, i, "details")
            joined = "\n".join(inner)
            summary = ""
            m2 = SUMMARY_RE.search(joined)
            if m2:
                summary = TAG_RE.sub("", m2.group(1)).strip()
                joined = joined[:m2.start()] + joined[m2.end():]
            children = _parse(_dedent_block(joined.split("\n")))
            out.append(BlockNode("toggle", summary, {}, children))
            continue

        if low.startswith("<grid"):
            inner, i = _html_section(lines, i, "grid")
            out.append(_grid(s, inner))
            continue

        if cells and low.startswith("<cell"):
            inner, i = _html_section(lines, i, "cell")
            out.append(BlockNode("grid_cell", "", {}, _parse(_dedent_block(inner))))
            continue

        if cells and low.startswith("</cell"):
            # A cell that never opened (its <cell> deleted by hand). The tag
            # closes nothing here, and kept as text it would close the cell
            # it is written into.
            i += 1
            continue

        if _is_table_start(lines, i):
            rows = [_split_cells(s)]
            i += 2
            while i < n and lines[i].strip().startswith("|"):
                rows.append(_split_cells(lines[i]))
                i += 1
            width = max(len(r) for r in rows)
            rows = [r + [""] * (width - len(r)) for r in rows]
            out.append(BlockNode("table", "", {"rows": rows, "header_row": True}))
            continue

        m = HEADING_RE.match(s)
        if m:
            level = min(len(m.group(1)), 3)
            out.append(BlockNode(f"heading_{level}", (m.group(2) or "").strip()))
            i += 1
            continue

        if HR_RE.match(s):
            out.append(BlockNode("divider"))
            i += 1
            continue

        item = None
        m = TODO_RE.match(s)
        if m:
            item = BlockNode("to_do", (m.group(2) or "").strip(), {"checked": m.group(1) in "xX"})
        elif m := BULLET_RE.match(s):
            item = BlockNode("bulleted_list", (m.group(1) or "").strip())
        elif m := NUMBER_RE.match(s):
            item = BlockNode("numbered_list", (m.group(2) or "").strip())
        if item is not None:
            i = _list_item(lines, i, ind, item)
            out.append(item)
            continue

        if QUOTE_RE.match(s):
            body = []
            while i < n and QUOTE_RE.match(lines[i].strip()):
                body.append(QUOTE_RE.match(lines[i].strip()).group(1).rstrip())
                i += 1
            out.append(BlockNode("quote", "\n".join(body).strip("\n")))
            continue

        link = _image_line(s)
        if link is not None:
            out.append(BlockNode("image", link.text, {"url": link.target}))
            i += 1
            continue

        para = [s]
        i += 1
        while i < n and lines[i].strip() and not _starts_block(lines, i):
            para.append(lines[i].strip())
            i += 1
        out.append(BlockNode("paragraph", "\n".join(para)))
    return out


def _list_item(lines: list[str], i: int, ind: int, item: BlockNode) -> int:
    """Fill in a list item's soft-broken text and nested children; returns the
    index of the first line after it."""
    n = len(lines)
    i += 1
    # Lines right below the item that open no block of their own continue its
    # text. Notion writes a Shift+Enter inside a list item that way, often
    # without indenting the second line.
    text = [item.text] if item.text else []
    while i < n and lines[i].strip() and not _starts_block(lines, i):
        text.append(lines[i].strip())
        i += 1
    item.text = "\n".join(text)
    # Children: everything indented deeper than the marker, blank lines allowed
    # in between (Notion leaves whitespace-only lines between nested images).
    j = last = i
    while j < n:
        if not lines[j].strip():
            j += 1
            continue
        if _indent(lines[j]) > ind:
            j += 1
            last = j
            continue
        break
    if last > i:
        item.children = _parse(_dedent_block(lines[i:last]))
    return last


def _grid(first: str, inner: list[str]) -> BlockNode:
    """A grid from its opening line and the lines up to ``</grid>``.

    Blocks between the cells (outside every ``<cell>``) make a cell of their
    own, and a grid without ``columns`` has as many as it has cells (DESIGN
    §2, Grids). The cells are found by parsing rather than by looking for
    ``<cell>`` lines, so a nested grid, toggle or code block between them
    stays in one piece."""
    cells: list[BlockNode] = []
    loose: BlockNode | None = None  # the cell the blocks between cells go into
    for b in _parse(_dedent_block(inner), cells=True):
        if b.type == "grid_cell":
            cells.append(b)
            loose = None
        elif loose is None:
            loose = BlockNode("grid_cell", "", {}, [b])
            cells.append(loose)
        else:
            loose.children.append(b)
    m = COLUMNS_RE.search(first.split(">", 1)[0])
    if m is None:
        count = len(cells)
    else:
        # Three digits are past 6 already, and a few thousand make int() raise.
        count = int(m.group(1)) if len(m.group(1)) < 3 else 6
    return BlockNode("grid", "", {"columns": min(max(count, 1), 6)}, cells)


def parse_markdown(md: str) -> list[BlockNode]:
    """Parse a Markdown document into block trees (see the module docstring)."""
    lines = (md or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    # Trailing whitespace carries no meaning here (a Markdown hard break is a
    # soft break in a block's text anyway). Code keeps its own lines untouched:
    # only lines outside fences are stripped.
    cleaned = []
    fence: str | None = None
    for ln in lines:
        s = ln.strip()
        if fence is None:
            m = FENCE_RE.match(s)
            if m:
                fence = m.group(1)
            cleaned.append(ln.rstrip())
        else:
            if s.startswith(fence) and set(s) == {fence[0]}:
                fence = None
                cleaned.append(ln.rstrip())
            else:
                cleaned.append(ln)
    return _parse(cleaned)


# --- Writing -------------------------------------------------------------------

TitleLookup = Callable[[str], str | None]


def _indent_lines(md: str) -> str:
    return "\n".join(INDENT + ln if ln.strip() else "" for ln in md.split("\n"))


def _cell(text: str) -> str:
    return (text or "").replace("|", "\\|").replace("\n", "<br>").strip()


def _table_md(rows: list[list[str]]) -> str:
    rows = [[str(c) if c is not None else "" for c in r] for r in rows if isinstance(r, list)]
    if not rows:
        return ""
    width = max(len(r) for r in rows) or 1
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(_cell(c) for c in rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    out += ["| " + " | ".join(_cell(c) for c in r) + " |" for r in rows[1:]]
    return "\n".join(out)


def _media_url(props: dict) -> str:
    if props.get("file_id"):
        return f"/api/files/{props['file_id']}"
    return str(props.get("url") or "")


def grid_columns(props: dict) -> int:
    """A grid's column count (DESIGN §2): ``columns`` clamped to 1 to 6, and 2
    when it is not a whole number (a bool is not one, 3.0 is). The same rule
    as app/render.py and app.mdblocks.js ``gridColumns``."""
    v = props.get("columns") if isinstance(props, dict) else None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return min(max(v, 1), 6) if isinstance(v, int) and not isinstance(v, bool) else 2


def _render(node: BlockNode, number: int, titles: TitleLookup | None) -> str:
    t = node.type
    text = node.text or ""
    props = node.props or {}
    if t.startswith("heading_") and t[-1] in "123":
        return "#" * int(t[-1]) + (" " + text.replace("\n", " ") if text else "")
    if t in LIST_TYPES:
        if t == "to_do":
            marker = "- [x]" if props.get("checked") else "- [ ]"
        elif t == "numbered_list":
            marker = f"{number}."
        else:
            marker = "-"
        first, *rest = text.split("\n") if text else [""]
        md = marker + (" " + first if first else "")
        for line in rest:
            md += "\n" + (INDENT + line if line.strip() else INDENT)
        if node.children:
            # A paragraph right under an item would read as more of its text,
            # so it is set off by a blank line. Nested items need none.
            sep = "\n" if node.children[0].type in LIST_TYPES else "\n\n"
            md += sep + _indent_lines(blocks_to_markdown(node.children, titles).rstrip("\n"))
        return md
    if t == "quote":
        return "\n".join("> " + ln if ln else ">" for ln in text.split("\n"))
    if t == "toggle":
        md = "<details>\n<summary>" + text + "</summary>\n\n"
        if node.children:
            md += blocks_to_markdown(node.children, titles).rstrip("\n") + "\n\n"
        return md + "</details>"
    if t == "callout":
        icon = props.get("icon")
        body = (f"{icon} {text}" if text else icon) if icon else text
        md = "<aside>\n" + body
        if node.children:
            md += "\n\n" + blocks_to_markdown(node.children, titles).rstrip("\n")
        return md + "\n</aside>"
    if t == "grid":
        # Each tag on a line of its own, the content not indented. A child
        # that is not a cell is written as a cell holding it.
        cells = []
        for c in node.children:
            body = blocks_to_markdown(c.children if c.type == "grid_cell" else [c], titles).rstrip("\n")
            cells.append(f"<cell>\n\n{body}\n\n</cell>" if body else "<cell>\n</cell>")
        return "\n".join([f'<grid columns="{grid_columns(props)}">', *cells, "</grid>"])
    if t == "grid_cell":
        # Only a grid writes a cell's tags; a cell on its own is its content.
        return blocks_to_markdown(node.children, titles).rstrip("\n")
    if t == "code":
        fence = "```"
        while fence in text:
            fence += "`"
        lang = props.get("language") or ""
        return f"{fence}{'' if lang == 'plain' else lang}\n{text}\n{fence}"
    if t == "equation":
        return "$$\n" + text + "\n$$"
    if t == "divider":
        return "---"
    if t == "table":
        return _table_md(props.get("rows") or [])
    if t == "image":
        # Without a caption the file name is the alt text (what Notion writes).
        return f"![{text or props.get('name') or ''}]({_media_url(props)})"
    if t == "file":
        name = props.get("name") or text or "file"
        return f"[{name}]({_media_url(props)})"
    if t in ("bookmark", "embed"):
        url = str(props.get("url") or "")
        return f"[{text or props.get('title') or url}]({url})" if url else text
    if t in ("page", "database"):
        pid = props.get("page_id") or ""
        title = (titles(pid) if titles and pid else None) or "Untitled"
        return f"[{title}](/p/{pid})"
    # paragraph, and any type this file does not know: its text.
    md = text
    if node.children:
        md += "\n\n" + _indent_lines(blocks_to_markdown(node.children, titles).rstrip("\n"))
    return md


def blocks_to_markdown(nodes: list[BlockNode], titles: TitleLookup | None = None) -> str:
    """Write block trees as Markdown; the inverse of ``parse_markdown``.

    ``titles`` maps a page id to its title for ``page`` and ``database`` blocks,
    which are written as ``[Title](/p/<id>)`` links."""
    parts: list[str] = []
    prev: BlockNode | None = None
    number = 0
    for node in nodes:
        number = number + 1 if node.type == "numbered_list" else 0
        md = _render(node, number, titles)
        if not md.strip():
            continue
        if prev is not None:
            # List items sit on consecutive lines (Notion's layout); every other
            # pair of blocks needs a blank line or it would merge on re-reading.
            tight = prev.type in LIST_TYPES and node.type in LIST_TYPES
            parts.append("\n" if tight else "\n\n")
        parts.append(md)
        prev = node
    return "".join(parts) + "\n" if parts else ""


# --- Exporting a page -------------------------------------------------------------


def _tree(blocks: list[Block]) -> list[BlockNode]:
    """Live blocks as trees, siblings by position. A block under a deleted or
    missing parent is hidden with it (as in the editor and app/render.py)."""
    live = {b.id: b for b in blocks if not b.deleted}
    kids: dict[str | None, list[Block]] = {}
    for b in live.values():
        kids.setdefault(b.parent_id, []).append(b)

    def build(parent_id: str | None, seen: frozenset) -> list[BlockNode]:
        out = []
        for b in sorted(kids.get(parent_id, []), key=lambda b: (b.position, b.created_at or 0, b.id)):
            if b.id in seen:
                continue  # a corrupt cycle must not hang the export
            out.append(BlockNode(b.type, b.text or "", dict(b.props or {}), build(b.id, seen | {b.id})))
        return out

    return build(None, frozenset())


def _number_str(v) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def value_to_text(prop: dict, value) -> str:
    """A database row value as plain text, the way Notion's CSV export writes it."""
    if value is None or value == "" or value == []:
        return ""
    kind = prop.get("type")
    if kind == "checkbox":
        return "Yes" if value else "No"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (int, float)):
        return _number_str(value)
    if isinstance(value, dict):
        if "start" in value:
            end = value.get("end")
            return f"{value.get('start') or ''} → {end}" if end else str(value.get("start") or "")
        return str(value.get("name") or value.get("url") or "")
    if isinstance(value, list):
        parts = []
        for v in value:
            if isinstance(v, dict):
                name = v.get("name") or v.get("url") or "file"
                url = f"/api/files/{v['file_id']}" if v.get("file_id") else v.get("url")
                parts.append(f"[{name}]({url})" if url else name)
            else:
                parts.append(str(v))
        return ", ".join(parts)
    return str(value)


def _rows_table(db: DBSession, page: Page) -> str:
    props = list((page.schema or {}).get("properties") or [])
    if not any(p.get("id") == "title" for p in props):
        props.insert(0, {"id": "title", "name": "Name", "type": "title"})
    rows = db.scalars(
        select(Page).where(Page.parent_id == page.id, Page.deleted.is_(False)).order_by(Page.position, Page.created_at)
    ).all()
    table = [[str(p.get("name") or "") for p in props]]
    for row in rows:
        if (row.options or {}).get("purged"):
            continue
        cells = []
        for p in props:
            if p.get("id") == "title":
                cells.append(f"[{row.title or 'Untitled'}](/p/{row.id})")
            elif p.get("type") in ("created_time", "last_edited_time"):
                ts = row.created_at if p["type"] == "created_time" else row.updated_at
                cells.append(ts.isoformat(timespec="minutes") if ts else "")
            else:
                cells.append(value_to_text(p, (row.props or {}).get(p.get("id"))))
        table.append(cells)
    return _table_md(table)


def page_to_markdown(db: DBSession, page: Page) -> str:
    """A stored page as one Markdown document: ``# Title``, its live blocks, and
    for a database its rows as a pipe table. Files link to ``/api/files/<id>``,
    other pages to ``/p/<id>``."""
    blocks = db.scalars(select(Block).where(Block.page_id == page.id)).all()
    nodes = _tree(list(blocks))

    ref_ids: set[str] = set()

    def collect(ns: list[BlockNode]) -> None:
        for nd in ns:
            if nd.type in ("page", "database") and nd.props.get("page_id"):
                ref_ids.add(str(nd.props["page_id"]))
            collect(nd.children)

    collect(nodes)
    titles: dict[str, str] = {}
    if ref_ids:
        for pid, title, owner, deleted in db.execute(
            select(Page.id, Page.title, Page.owner_id, Page.deleted).where(Page.id.in_(ref_ids))
        ).all():
            # Never leak the title of somebody else's page through a stale link.
            if owner == page.owner_id and not deleted:
                titles[pid] = title or "Untitled"

    parts = [f"# {page.title or 'Untitled'}"]
    body = blocks_to_markdown(nodes, titles.get).rstrip("\n")
    if body:
        parts.append(body)
    if page.kind == "database":
        parts.append(_rows_table(db, page))
    return "\n\n".join(parts) + "\n"
