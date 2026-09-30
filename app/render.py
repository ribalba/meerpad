"""Blocks to HTML, for published websites (docs/DESIGN.md §2, §4 and §9).

A published site is rendered entirely on the server: a visitor (or a search
engine) gets finished HTML and needs no JavaScript to read it. This module
turns a page's block tree into that HTML. It knows nothing about hosts, paths
or the database; everything that depends on where the page is shown comes in
through a ``RenderContext``:

* ``file_url(file_id, name)``: where a file is served (``/_files/<id>/<name>``
  on a site host, ``/site/<sub>/_files/...`` in a preview), or None when the
  file may not be shown here (it belongs to a page outside the site);
* ``page_path(page_id)`` and ``page(page_id)``: where a page lives on the
  site, and its title and icon, or None when it is not part of the site. Link
  cards to such pages are left out and inline ``/p/`` links lose their link;
* ``database(page_id)``: a database page and its live rows, for inline tables.

app/sites.py implements it against the database; tests use small fakes.

Safety rules, because every string here comes from a user:

* All text goes through ``esc`` or the inline Markdown renderer (which
  escapes everything it does not generate itself).
* URLs in attributes are either built here from validated parts (embed IDs,
  file ids) or pass ``safe_url`` (http, https, mailto only).
* Class names and inline styles are only ever taken from allow-lists or from
  numbers parsed here (a colour name, an image width), never copied verbatim.
"""

import math
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlparse

from markupsafe import Markup

# Optional at import time: a dev container started from an image built before
# Pygments joined requirements.txt must still boot (it bind-mounts app/ and
# reloads on edits). Without it, code on published sites is shown plain.
try:
    from pygments import highlight as pygments_highlight
    from pygments.formatters import HtmlFormatter
    from pygments.lexers import get_lexer_by_name
    from pygments.util import ClassNotFound
except ImportError:  # pragma: no cover - only in a stale image
    pygments_highlight = None

from .mdinline import esc, inline_html, inline_text

COLOR_NAMES = ("gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red")

# page.cover "gradient:<n>". Kept in one place so the templates and the favicon
# agree; the app's cover picker should offer the same eight.
GRADIENTS = (
    "linear-gradient(135deg, #f6d365 0%, #fda085 100%)",                 # 0 sunrise
    "linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)",                 # 1 sky
    "linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)",                 # 2 lagoon
    "linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)",                 # 3 lavender
    "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",                 # 4 indigo
    "linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)",                 # 5 blossom
    "linear-gradient(135deg, #43cea2 0%, #185a9d 100%)",                 # 6 ocean
    "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)",    # 7 night
)

# Deeper nesting than this is not rendered. Real pages never get close; the cap
# only stops a pathological tree from exhausting Python's recursion limit.
MAX_DEPTH = 48
MAX_TABLE_ROWS = 2000
MAX_TABLE_COLS = 100

PAGE_GLYPH = (
    '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.2l3.3 3.3V14a.5.5 0 0 1-.5.5H4'
    'a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M9 '
    '1.8V5h3.2M5.6 8.2h4.8M5.6 10.7h4.8" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>'
)
TABLE_GLYPH = (
    '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" '
    'fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M1.8 6h12.4M1.8 9.7h12.4M6 6v7.5" fill="none" '
    'stroke="currentColor" stroke-width="1.1"/></svg>'
)
FILE_GLYPH = (
    '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.6 '
    '2.6 0 0 0-3.7-3.7l-5 5a3.8 3.8 0 0 0 5.4 5.4l4.3-4.3" fill="none" stroke="currentColor" stroke-width="1.2" '
    'stroke-linecap="round"/></svg>'
)
LINK_GLYPH = (
    '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5M7 4.5l1.2-1.2a2.8 2.8 0 0 1 '
    '4 4L11 8.5M9 11.5l-1.2 1.2a2.8 2.8 0 0 1-4-4L5 7.5" fill="none" stroke="currentColor" stroke-width="1.2" '
    'stroke-linecap="round"/></svg>'
)


# --- The block tree ------------------------------------------------------------


@dataclass
class BlockNode:
    id: str
    type: str
    text: str
    props: dict
    children: list["BlockNode"] = field(default_factory=list)


def _f(obj: Any, name: str, default: Any = None) -> Any:
    """A field of an ORM row or of a plain dict (tests and fakes use dicts)."""
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def build_tree(blocks) -> list[BlockNode]:
    """Top-level nodes of a page, children attached, siblings in position order.

    Deleted blocks are dropped, and so is everything nested under a block that
    is missing or deleted: in the editor, deleting a toggle takes its content
    with it, and a published page must not resurrect it."""
    live = [b for b in blocks if not _f(b, "deleted", False)]
    nodes: dict[str, BlockNode] = {}
    parent_of: dict[str, str | None] = {}
    order: dict[str, tuple] = {}
    for b in live:
        bid = str(_f(b, "id"))
        props = _f(b, "props") or {}
        nodes[bid] = BlockNode(
            id=bid,
            type=str(_f(b, "type") or "paragraph"),
            text=str(_f(b, "text") or ""),
            props=props if isinstance(props, dict) else {},
        )
        parent_of[bid] = _f(b, "parent_id")
        pos = _f(b, "position", 0.0)
        order[bid] = (pos if isinstance(pos, (int, float)) and math.isfinite(pos) else 0.0, bid)
    kids: dict[str | None, list[str]] = {}
    for bid, pid in parent_of.items():
        kids.setdefault(pid, []).append(bid)
    for ids in kids.values():
        ids.sort(key=lambda i: order[i])

    def attach(bid: str, seen: set[str]) -> BlockNode:
        node = nodes[bid]
        seen.add(bid)
        node.children = [attach(c, seen) for c in kids.get(bid, []) if c not in seen]
        return node

    seen: set[str] = set()
    # Starting only from parent_id = None means orphans (parent deleted or on
    # another page) and corrupt cycles are simply never reached.
    return [attach(bid, seen) for bid in kids.get(None, [])]


# --- Context -------------------------------------------------------------------


class RenderContext:
    """What rendering needs from its surroundings. This base class has nothing
    to offer (no files, no page links, no databases); app/sites.py subclasses
    it. Rendering also records facts the page template needs afterwards:
    whether to load mermaid or KaTeX, and the headings for a table of contents.
    """

    def __init__(self) -> None:
        self.needs_mermaid = False
        self.needs_math = False
        self.headings: list[dict] = []
        self.linked_page_ids: set[str] = set()
        # Link cards to these pages are not rendered: the template already
        # shows them (a blog's post list, a landing page's feature cards).
        self.skip_page_ids: set[str] = set()
        self._anchors: set[str] = set()

    # Overridden by app/sites.py.
    def file_url(self, file_id: str, name: str | None = None) -> str | None:
        return None

    def page_path(self, page_id: str) -> str | None:
        return None

    def page(self, page_id: str) -> Any | None:
        """An object with ``title`` and ``icon`` (and ``kind``), or None."""
        return None

    def database(self, page_id: str) -> tuple[Any, list] | None:
        """``(database_page, rows)``: the page has ``schema``, ``title`` and
        ``icon``; rows have ``id, title, icon, props, created_at, updated_at``
        and come in position order."""
        return None

    # Helpers built on the above.
    def inline(self, text: str | None) -> str:
        return inline_html(text, self.page_path)

    def anchor_for(self, text: str) -> str:
        base = slugify(text, 50) or "section"
        anchor, n = base, 2
        while anchor in self._anchors:
            anchor, n = f"{base}-{n}", n + 1
        self._anchors.add(anchor)
        return anchor


# --- Small helpers -------------------------------------------------------------

_TRANSLIT = str.maketrans({
    "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "æ": "ae", "ø": "oe", "å": "aa",
    "œ": "oe", "þ": "th", "ð": "d", "ł": "l", "đ": "d", "ı": "i",
})


def slugify(text: str | None, max_len: int = 60) -> str:
    """ASCII URL slug: "Hühner & Gänse!" becomes "huehner-gaense". German
    umlauts are transliterated the German way; other accents are dropped
    ("Café" is "cafe"); anything else that is not a letter or digit becomes a
    dash. Can return "" (an all-emoji or all-CJK title): callers pick a
    fallback."""
    s = (text or "").lower().translate(_TRANSLIT)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:max_len].rstrip("-")


def color_class(props: dict) -> str:
    c = props.get("color") if isinstance(props, dict) else None
    if not isinstance(c, str):
        return ""
    if c in COLOR_NAMES:
        return f"c-{c}"
    if c.endswith("_bg") and c[:-3] in COLOR_NAMES:
        return f"bg-{c[:-3]}"
    return ""


def _cls(*names: str) -> str:
    joined = " ".join(n for n in names if n)
    return f' class="{joined}"' if joined else ""


def _str(v: Any) -> str:
    return v if isinstance(v, str) else ""


def _http_url(u: Any) -> str | None:
    """An http(s) URL, or None. For src attributes (mailto makes no sense there)."""
    u = _str(u).strip()
    return u if re.match(r"^https?://[^\s]+$", u, re.IGNORECASE) else None


def media_url(props: dict, ctx: RenderContext) -> str | None:
    """Where a media block's content is: its uploaded file, else its URL."""
    fid = props.get("file_id")
    if isinstance(fid, str) and fid:
        return ctx.file_url(fid, _str(props.get("name")) or None)
    return _http_url(props.get("url"))


def human_size(n: Any) -> str:
    if isinstance(n, bool) or not isinstance(n, (int, float)) or n < 0:
        return ""
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" or size >= 100 else f"{size:.1f} {unit}"
        size /= 1024
    return ""


def truncate(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",.;:-")
    return cut + "…"


def icon_html(icon: str | None, ctx: RenderContext, cls: str = "icon") -> Markup:
    """A page or callout icon: an emoji, ``file:<id>``, or an http(s) image."""
    icon = (icon or "").strip()
    if not icon:
        return Markup("")
    if icon.startswith("file:"):
        url = ctx.file_url(icon[5:])
        return Markup(f'<img class="{cls} icon-img" src="{esc(url)}" alt="">') if url else Markup("")
    if icon.lower().startswith(("http://", "https://")):
        url = _http_url(icon)
        if not url:
            return Markup("")
        return Markup(f'<img class="{cls} icon-img" src="{esc(url)}" alt="" referrerpolicy="no-referrer">')
    if len(icon) > 16:  # an emoji is a few code points; anything longer is not an icon
        return Markup("")
    return Markup(f'<span class="{cls} icon-emoji" aria-hidden="true">{esc(icon)}</span>')


def cover_info(cover: str | None, ctx: RenderContext) -> dict | None:
    """``{"kind": "image", "url"}`` or ``{"kind": "gradient", "css"}``, or None."""
    cover = (cover or "").strip()
    if not cover:
        return None
    if cover.startswith("gradient:"):
        try:
            n = int(cover[9:])
        except ValueError:
            return None
        return {"kind": "gradient", "css": GRADIENTS[n % len(GRADIENTS)]}
    if cover.startswith("file:"):
        url = ctx.file_url(cover[5:])
        return {"kind": "image", "url": url} if url else None
    url = _http_url(cover)
    return {"kind": "image", "url": url} if url else None


def _is_blank(n: BlockNode) -> bool:
    return n.type == "paragraph" and not n.text.strip() and not n.children


def first_paragraph(nodes: list[BlockNode]) -> BlockNode | None:
    """The page's opening paragraph: the first block that is not an empty
    line, if that block is a paragraph. Used as a landing page's lead."""
    for n in nodes:
        if _is_blank(n):
            continue
        return n if n.type == "paragraph" and n.text.strip() else None
    return None


def excerpt(nodes: list[BlockNode], limit: int = 200) -> str:
    """Plain text of the first paragraph with words in it, shortened."""
    for n in nodes:
        if n.type == "paragraph" and n.text.strip():
            return truncate(inline_text(n.text), limit)
    return ""


# --- Blocks --------------------------------------------------------------------


def render_blocks(nodes: list[BlockNode], ctx: RenderContext) -> Markup:
    """A block tree (``build_tree``) as HTML. Leading and trailing empty
    paragraphs are dropped: they are spacing in the editor, not content."""
    nodes = list(nodes)
    while nodes and _is_blank(nodes[0]):
        nodes.pop(0)
    while nodes and _is_blank(nodes[-1]):
        nodes.pop()
    return Markup(_render_nodes(nodes, ctx, 0, 0))


_LIST_TYPES = ("bulleted_list", "numbered_list", "to_do")


def _render_nodes(nodes: list[BlockNode], ctx: RenderContext, depth: int, ldepth: int) -> str:
    """Siblings in order. Consecutive list items of one type are grouped into
    one <ul>/<ol>, which is also what makes numbering restart after anything
    else ("numbering is computed from consecutive siblings")."""
    if depth > MAX_DEPTH:
        return ""
    out: list[str] = []
    i = 0
    while i < len(nodes):
        n = nodes[i]
        if n.type in _LIST_TYPES:
            j = i
            while j < len(nodes) and nodes[j].type == n.type:
                j += 1
            out.append(_render_list(n.type, nodes[i:j], ctx, depth, ldepth))
            i = j
            continue
        fn = _RENDERERS.get(n.type, _render_unknown)
        out.append(fn(n, ctx, depth))
        i += 1
    return "".join(out)


def _kids(n: BlockNode, ctx: RenderContext, depth: int, wrap: str = "indent") -> str:
    """Nested blocks of a block that is not a container by nature (Notion lets
    any block have children; they show indented)."""
    if not n.children:
        return ""
    inner = _render_nodes(n.children, ctx, depth + 1, 0)
    return f'<div class="{wrap}">{inner}</div>' if wrap else inner


_OL_STYLES = ("decimal", "alpha", "roman")
_UL_STYLES = ("disc", "circle", "square")


def _render_list(kind: str, items: list[BlockNode], ctx: RenderContext, depth: int, ldepth: int) -> str:
    lis = []
    for n in items:
        kids = _render_nodes(n.children, ctx, depth + 1, ldepth + 1) if n.children else ""
        text = ctx.inline(n.text)
        if kind == "to_do":
            checked = n.props.get("checked") is True
            box = f'<input type="checkbox" disabled{" checked" if checked else ""} aria-label="{"Done" if checked else "Not done"}">'
            lis.append(
                f'<li{_cls("todo", "checked" if checked else "", color_class(n.props))}>'
                f'<span class="todo-row">{box}<span class="todo-text">{text}</span></span>{kids}</li>'
            )
        else:
            lis.append(f"<li{_cls(color_class(n.props))}>{text}{kids}</li>")
    if kind == "to_do":
        return f'<ul class="todo-list">{"".join(lis)}</ul>'
    if kind == "numbered_list":
        return f'<ol class="ol-{_OL_STYLES[ldepth % 3]}">{"".join(lis)}</ol>'
    return f'<ul class="ul-{_UL_STYLES[ldepth % 3]}">{"".join(lis)}</ul>'


def _render_paragraph(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    if not n.text.strip():
        return '<div class="blank" aria-hidden="true"></div>' + _kids(n, ctx, depth)
    return f"<p{_cls(color_class(n.props))}>{ctx.inline(n.text)}</p>" + _kids(n, ctx, depth)


def _render_heading(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    # The page title is the page's one <h1>, so heading_1 is an <h2>.
    level = {"heading_1": 1, "heading_2": 2, "heading_3": 3}[n.type]
    tag = f"h{level + 1}"
    plain = inline_text(n.text)
    if not plain:
        return _kids(n, ctx, depth)
    anchor = ctx.anchor_for(plain)
    ctx.headings.append({"level": level, "text": plain, "id": anchor})
    return (
        f'<{tag} id="{esc(anchor)}"{_cls("heading", color_class(n.props))}>{ctx.inline(n.text)}'
        f'<a class="anchor" href="#{esc(anchor)}" aria-label="Link to this section">#</a></{tag}>'
        + _kids(n, ctx, depth)
    )


def _render_toggle(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    body = _render_nodes(n.children, ctx, depth + 1, 0) if n.children else ""
    summary = ctx.inline(n.text) or "&nbsp;"
    return (
        f'<details{_cls("toggle", color_class(n.props))}><summary>{summary}</summary>'
        f'<div class="toggle-body">{body}</div></details>'
    )


def _render_quote(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    kids = _render_nodes(n.children, ctx, depth + 1, 0) if n.children else ""
    return f"<blockquote{_cls(color_class(n.props))}><p>{ctx.inline(n.text)}</p>{kids}</blockquote>"


def _render_callout(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    color = color_class(n.props) or "bg-gray"
    icon = icon_html(_str(n.props.get("icon")) or "💡", ctx, "callout-icon")
    kids = _render_nodes(n.children, ctx, depth + 1, 0) if n.children else ""
    text = f"<p>{ctx.inline(n.text)}</p>" if n.text.strip() else ""
    return f'<aside class="callout {color}">{icon}<div class="callout-body">{text}{kids}</div></aside>'


_LANG_LABELS = {
    "js": "JavaScript", "javascript": "JavaScript", "ts": "TypeScript", "typescript": "TypeScript",
    "py": "Python", "python": "Python", "sh": "Shell", "bash": "Bash", "shell": "Shell", "html": "HTML",
    "css": "CSS", "json": "JSON", "yaml": "YAML", "yml": "YAML", "sql": "SQL", "go": "Go", "rust": "Rust",
    "c": "C", "cpp": "C++", "c++": "C++", "csharp": "C#", "c#": "C#", "java": "Java", "kotlin": "Kotlin",
    "php": "PHP", "ruby": "Ruby", "swift": "Swift", "markdown": "Markdown", "md": "Markdown", "xml": "XML",
    "toml": "TOML", "dockerfile": "Dockerfile", "diff": "Diff", "tex": "TeX", "latex": "LaTeX",
}


# Code on published sites is highlighted here, server-side, so a site needs no
# JavaScript for it. The token classes (prefixed tok-) are coloured in
# _blocks.css with the same palette the app's editor uses for highlight.js.
_CODE_FORMATTER = HtmlFormatter(nowrap=True, classprefix="tok-") if pygments_highlight else None
_NO_HIGHLIGHT = {"plain", "plaintext", "text", "mermaid"}
# Beyond this a block is shown plain: highlighting runs on every page view.
MAX_HIGHLIGHT_CHARS = 100_000


@lru_cache(maxsize=512)
def highlight_code(code: str, lang: str) -> str | None:
    """Highlighted, escaped HTML for ``code`` (spans only), or None when the
    language is unknown or not worth it; the caller escapes the text itself."""
    if _CODE_FORMATTER is None or lang in _NO_HIGHLIGHT or not code or len(code) > MAX_HIGHLIGHT_CHARS:
        return None
    try:
        lexer = get_lexer_by_name(lang, stripnl=False, ensurenl=False)
    except ClassNotFound:
        return None
    out = pygments_highlight(code, lexer, _CODE_FORMATTER)
    # Some lexers end every token stream with a newline whatever ensurenl says;
    # the rendered text has to be exactly the source.
    if not code.endswith("\n") and out.endswith("\n"):
        out = out[:-1]
    return out


def _render_code(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    lang = re.sub(r"[^a-z0-9+#-]", "", _str(n.props.get("language")).lower())[:30] or "plain"
    if lang == "mermaid":
        ctx.needs_mermaid = True
        # mermaid reads the element's text, so escaped source is exactly right,
        # and without JavaScript the diagram's source is still readable.
        return f'<div class="mermaid-wrap"><pre class="mermaid">{esc(n.text)}</pre></div>'
    label = "" if lang in ("plain", "plaintext", "text") else _LANG_LABELS.get(lang, lang)
    head = f'<div class="code-lang">{esc(label)}</div>' if label else ""
    safe_lang = lang.replace("+", "p").replace("#", "sharp")
    caption = f"<figcaption>{ctx.inline(_str(n.props.get('caption')))}</figcaption>" if n.props.get("caption") else ""
    body = highlight_code(n.text, lang) or esc(n.text)
    return (
        f'<figure class="code">{head}<pre><code class="language-{safe_lang}">{body}</code></pre>'
        f"{caption}</figure>"
    )


def _render_divider(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    return "<hr>"


def _caption(n: BlockNode, ctx: RenderContext) -> str:
    return f"<figcaption>{ctx.inline(n.text)}</figcaption>" if n.text.strip() else ""


def _render_image(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    src = media_url(n.props, ctx)
    if not src:
        return ""
    width = n.props.get("width")
    style = ""
    if isinstance(width, (int, float)) and not isinstance(width, bool) and math.isfinite(width) and width >= 40:
        style = f' style="width:{min(int(width), 2400)}px"'
    alt = inline_text(n.text) or _str(n.props.get("name"))
    return (
        f'<figure class="image"{style}><img src="{esc(src)}" alt="{esc(alt)}" loading="lazy" decoding="async">'
        f"{_caption(n, ctx)}</figure>"
    )


def _render_file(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    url = media_url(n.props, ctx)
    name = _str(n.props.get("name")) or (urlparse(url).path.rsplit("/", 1)[-1] if url else "") or "File"
    if not url:
        return ""
    ctype = _str(n.props.get("content_type")).lower()
    is_pdf = ctype == "application/pdf" or name.lower().endswith(".pdf")
    local = bool(n.props.get("file_id"))
    size = human_size(n.props.get("size"))
    meta = f'<span class="file-size">{esc(size)}</span>' if size else ""
    ext = "" if local else ' target="_blank" rel="noopener noreferrer"'
    dl = " download" if local else ""
    link = f'<a class="file-link" href="{esc(url)}"{dl}{ext}>{FILE_GLYPH}<span class="file-name">{esc(name)}</span>{meta}</a>'
    if is_pdf and local:
        # Only our own files are framed: the file route serves PDFs inline and
        # without the sandbox CSP (Chrome's viewer refuses to run sandboxed).
        return (
            f'<figure class="pdf"><iframe src="{esc(url)}" title="{esc(name)}" loading="lazy"></iframe>'
            f"<figcaption>{link}{(' ' + ctx.inline(n.text)) if n.text.strip() else ''}</figcaption></figure>"
        )
    return f'<figure class="file">{link}{_caption(n, ctx)}</figure>'


def _bookmark_card(url: str, title: str, desc: str, caption: str) -> str:
    host = (urlparse(url).hostname or "").removeprefix("www.")
    desc_html = f'<span class="bm-desc">{esc(desc)}</span>' if desc else ""
    cap = f"<figcaption>{caption}</figcaption>" if caption else ""
    return (
        f'<figure class="bookmark"><a href="{esc(url)}" target="_blank" rel="noopener noreferrer">'
        f'<span class="bm-title">{esc(title or host or url)}</span>{desc_html}'
        f'<span class="bm-url">{LINK_GLYPH}{esc(host or url)}</span></a>{cap}</figure>'
    )


def _render_bookmark(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    url = _http_url(n.props.get("url"))
    if not url:
        return ""
    return _bookmark_card(
        url,
        truncate(_str(n.props.get("title")), 140),
        truncate(_str(n.props.get("description")), 260),
        ctx.inline(n.text) if n.text.strip() else "",
    )


# --- Embeds ---------------------------------------------------------------------

_YT_ID = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
_VIMEO_ID = re.compile(r"^\d{4,12}$")
_LOOM_ID = re.compile(r"^[0-9a-f]{16,40}$")
_SAFE_Q = re.compile(r"^[^<>\"'`\\]{1,300}$")

# Every host an embed iframe may point at. The site's CSP frame-src lists the
# same hosts (app/sites.py), so a new provider needs both.
EMBED_HOSTS = (
    "https://www.youtube-nocookie.com",
    "https://player.vimeo.com",
    "https://www.loom.com",
    "https://www.google.com",
    "https://maps.google.com",
    "https://codepen.io",
    "https://www.figma.com",
)


def _start_seconds(t: str) -> int | None:
    m = re.match(r"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$", t or "")
    if not m or not any(m.groups()):
        return None
    h, mi, s = (int(x or 0) for x in m.groups())
    return h * 3600 + mi * 60 + s


def embed_src(url: str) -> tuple[str, str] | None:
    """``(provider, iframe src)`` for a URL on the embed allow-list, else None.

    The src is always rebuilt from a validated ID rather than copied, so no
    part of the user's URL reaches the iframe unchecked."""
    u = urlparse(url)
    if u.scheme not in ("http", "https"):
        return None
    host = (u.hostname or "").lower()
    for prefix in ("www.", "m."):
        host = host.removeprefix(prefix)
    parts = [p for p in u.path.split("/") if p]
    q = parse_qs(u.query)

    if host in ("youtube.com", "youtu.be", "music.youtube.com", "youtube-nocookie.com"):
        vid = None
        if host == "youtu.be" and parts:
            vid = parts[0]
        elif parts[:1] == ["watch"]:
            vid = (q.get("v") or [None])[0]
        elif len(parts) >= 2 and parts[0] in ("embed", "shorts", "live", "v"):
            vid = parts[1]
        if vid and _YT_ID.match(vid):
            start = _start_seconds((q.get("t") or q.get("start") or [""])[0])
            return "youtube", f"https://www.youtube-nocookie.com/embed/{vid}" + (f"?start={start}" if start else "")
        return None

    if host in ("vimeo.com", "player.vimeo.com"):
        ids = [p for p in parts if _VIMEO_ID.match(p)]
        if not ids:
            return None
        src = f"https://player.vimeo.com/video/{ids[0]}"
        rest = parts[parts.index(ids[0]) + 1:] if host == "vimeo.com" else []
        h = rest[0] if rest else (q.get("h") or [""])[0]
        if h and re.match(r"^[0-9a-f]{6,20}$", h):
            src += f"?h={h}"
        return "vimeo", src

    if host == "loom.com" and len(parts) >= 2 and parts[0] in ("share", "embed") and _LOOM_ID.match(parts[1]):
        return "loom", f"https://www.loom.com/embed/{parts[1]}"

    if host in ("google.com", "maps.google.com") and (host == "maps.google.com" or parts[:1] == ["maps"]):
        if parts[:2] == ["maps", "embed"]:
            pb = (q.get("pb") or [""])[0]
            if pb and re.match(r"^[A-Za-z0-9!._:%-]{1,4000}$", pb):
                return "maps", "https://www.google.com/maps/embed?" + urlencode({"pb": pb})
            return None
        query = (q.get("q") or q.get("query") or [""])[0]
        if not query and len(parts) >= 3 and parts[1] in ("place", "search"):
            query = parts[2].replace("+", " ")
        at = next((p for p in parts if p.startswith("@")), "")
        m = re.match(r"^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?", at)
        params = {}
        if query and _SAFE_Q.match(query):
            params["q"] = query
        elif m:
            params["q"] = f"{m.group(1)},{m.group(2)}"
        if not params:
            return None
        if m and m.group(3):
            params["z"] = str(int(float(m.group(3))))
        params["output"] = "embed"
        return "maps", "https://maps.google.com/maps?" + urlencode(params)

    # The same two rules as the editor's (app.editor.media.js), so a page embeds
    # the same things in the app and on its published site.
    if (host == "codepen.io" and len(parts) >= 3 and parts[1] in ("pen", "embed", "full", "details")
            and re.match(r"^[A-Za-z0-9_-]{1,40}$", parts[0]) and re.match(r"^[A-Za-z0-9]{3,20}$", parts[2])):
        return "codepen", f"https://codepen.io/{parts[0]}/embed/{parts[2]}?default-tab=result"

    if (host == "figma.com" and len(parts) >= 2 and parts[0] in ("file", "design", "proto", "board")
            and re.match(r"^[A-Za-z0-9]{10,40}$", parts[1])):
        clean = "https://www.figma.com/" + "/".join(quote(p, safe="") for p in parts[:3])
        if u.query:
            clean += "?" + urlencode(parse_qs(u.query), doseq=True)
        return "figma", "https://www.figma.com/embed?" + urlencode({"embed_host": "meerpad", "url": clean})
    return None


def _render_embed(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    url = _http_url(n.props.get("url"))
    if not url:
        return ""
    found = embed_src(url)
    caption = ctx.inline(n.text) if n.text.strip() else ""
    if not found:
        # Not on the allow-list: a link card, never an iframe to anywhere.
        return _bookmark_card(url, truncate(_str(n.props.get("title")), 140), "", caption)
    provider, src = found
    title = {"youtube": "YouTube video", "vimeo": "Vimeo video", "loom": "Loom video", "maps": "Map",
             "codepen": "CodePen", "figma": "Figma file"}[provider]
    cap = f"<figcaption>{caption}</figcaption>" if caption else ""
    return (
        f'<figure class="embed embed-{provider}"><div class="embed-frame">'
        f'<iframe src="{esc(src)}" title="{title}" loading="lazy" '
        'sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" '
        'allow="fullscreen; picture-in-picture; encrypted-media" referrerpolicy="strict-origin-when-cross-origin">'
        f"</iframe></div>{cap}</figure>"
    )


def _render_table(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    rows = n.props.get("rows")
    if not isinstance(rows, list):
        return ""
    rows = [r for r in rows[:MAX_TABLE_ROWS] if isinstance(r, list)]
    if not rows:
        return ""
    width = min(max(len(r) for r in rows), MAX_TABLE_COLS)
    header_row = n.props.get("header_row") is True
    header_col = n.props.get("header_col") is True

    def cell(v: Any) -> str:
        return ctx.inline(v if isinstance(v, str) else ("" if v is None else str(v)))

    def tr(r: list, head: bool) -> str:
        cells = []
        for i in range(width):
            v = r[i] if i < len(r) else ""
            if head:
                cells.append(f'<th scope="col">{cell(v)}</th>')
            elif header_col and i == 0:
                cells.append(f'<th scope="row">{cell(v)}</th>')
            else:
                cells.append(f"<td>{cell(v)}</td>")
        return f"<tr>{''.join(cells)}</tr>"

    head = f"<thead>{tr(rows[0], True)}</thead>" if header_row else ""
    body = "".join(tr(r, False) for r in (rows[1:] if header_row else rows))
    return f'<div class="table-wrap"><table class="simple-table">{head}<tbody>{body}</tbody></table></div>'


def _render_page_link(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    pid = _str(n.props.get("page_id"))
    if not pid:
        return ""
    ctx.linked_page_ids.add(pid)
    if pid in ctx.skip_page_ids:
        return ""
    page = ctx.page(pid)
    path = ctx.page_path(pid)
    if page is None or path is None:
        return ""  # not part of the site: say nothing about it
    icon = icon_html(_f(page, "icon"), ctx, "pl-icon") or Markup(
        TABLE_GLYPH if _f(page, "kind") == "database" else PAGE_GLYPH
    )
    title = _f(page, "title") or "Untitled"
    return f'<a class="page-link" href="{esc(path)}">{icon}<span class="pl-title">{esc(title)}</span></a>'


def _render_database(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    pid = _str(n.props.get("page_id"))
    data = ctx.database(pid) if pid else None
    if not data:
        return ""
    ctx.linked_page_ids.add(pid)
    db_page, rows = data
    return render_database(db_page, rows, ctx, view_id=_str(n.props.get("view_id")) or None,
                           title_href=ctx.page_path(pid))


def _render_equation(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    if not n.text.strip():
        return ""
    ctx.needs_math = True
    return f'<div class="equation"><code class="math">{esc(n.text)}</code></div>'


def _render_unknown(n: BlockNode, ctx: RenderContext, depth: int) -> str:
    """A block type this server does not know (a newer client wrote it): show
    its text as a paragraph rather than losing it."""
    text = f"<p>{ctx.inline(n.text)}</p>" if n.text.strip() else ""
    return text + _kids(n, ctx, depth)


_RENDERERS = {
    "paragraph": _render_paragraph,
    "heading_1": _render_heading,
    "heading_2": _render_heading,
    "heading_3": _render_heading,
    "toggle": _render_toggle,
    "quote": _render_quote,
    "callout": _render_callout,
    "code": _render_code,
    "divider": _render_divider,
    "image": _render_image,
    "file": _render_file,
    "bookmark": _render_bookmark,
    "embed": _render_embed,
    "table": _render_table,
    "page": _render_page_link,
    "database": _render_database,
    "equation": _render_equation,
}


# --- Databases (§4) ------------------------------------------------------------


def schema_properties(schema: Any) -> list[dict]:
    """The schema's properties, always with the title property present."""
    props = []
    if isinstance(schema, dict) and isinstance(schema.get("properties"), list):
        props = [p for p in schema["properties"] if isinstance(p, dict) and isinstance(p.get("id"), str)]
    if not any(p["id"] == "title" for p in props):
        props.insert(0, {"id": "title", "name": "Name", "type": "title"})
    return props


def pick_view(schema: Any, view_id: str | None = None) -> dict:
    """The view a database block names, else the first table view, else the
    first view of any kind, else none ({}): every property, position order."""
    views = []
    if isinstance(schema, dict) and isinstance(schema.get("views"), list):
        views = [v for v in schema["views"] if isinstance(v, dict)]
    if view_id:
        for v in views:
            if v.get("id") == view_id:
                return v
    for v in views:
        if v.get("type") == "table":
            return v
    return views[0] if views else {}


def raw_value(row: Any, prop: dict) -> Any:
    ptype = prop.get("type")
    if prop["id"] == "title" or ptype == "title":
        return _f(row, "title") or ""
    if ptype == "created_time":
        return _f(row, "created_at")
    if ptype == "last_edited_time":
        return _f(row, "updated_at")
    values = _f(row, "props") or {}
    return values.get(prop["id"]) if isinstance(values, dict) else None


def _is_empty(v: Any) -> bool:
    return v is None or v == "" or v == [] or v == {} or v is False


def _as_text(v: Any) -> str:
    if isinstance(v, list):
        return ", ".join(_as_text(x) for x in v)
    if isinstance(v, dict):
        return _str(v.get("name")) or _str(v.get("start"))
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return "" if v is None else str(v)


def _number(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    if isinstance(v, str):
        try:
            f = float(v.strip())
            return f if math.isfinite(f) else None
        except ValueError:
            return None
    return None


def _matches(row: Any, prop: dict, op: str, value: Any) -> bool:
    v = raw_value(row, prop)
    if op == "empty":
        return _is_empty(v)
    if op == "not_empty":
        return not _is_empty(v)
    if op == "checked":
        return v is True
    if op == "unchecked":
        return v is not True
    needle = _as_text(value).casefold()
    if op == "contains":
        if isinstance(v, list):
            return any(needle in _as_text(x).casefold() for x in v)
        return needle in _as_text(v).casefold()
    if op in ("eq", "neq"):
        if isinstance(v, list):
            hit = any(_as_text(x).casefold() == needle for x in v)
        elif prop.get("type") == "number" and _number(v) is not None and _number(value) is not None:
            hit = _number(v) == _number(value)
        elif prop.get("type") == "checkbox":
            hit = (v is True) == (value is True or needle == "true")
        else:
            hit = _as_text(v).casefold() == needle
        return hit if op == "eq" else not hit
    return True  # an operator this server does not know hides nothing


def _sort_key(prop: dict):
    ptype = prop.get("type")
    options = [o.get("name") for o in prop.get("options") or [] if isinstance(o, dict)]

    def key(row: Any):
        v = raw_value(row, prop)
        if ptype == "number":
            return _number(v) or 0.0
        if ptype == "checkbox":
            return 1 if v is True else 0
        if ptype in ("select", "status"):
            return options.index(v) if v in options else len(options)
        if ptype == "multi_select" and isinstance(v, list):
            return tuple(options.index(x) if x in options else len(options) for x in v)
        if ptype == "date" and isinstance(v, dict):
            return _str(v.get("start"))
        return _as_text(v).casefold()

    return key


def apply_view(rows: list, props_by_id: dict[str, dict], view: dict) -> list:
    """Rows filtered (all conditions must hold) and sorted as the view says.
    Empty values sort last in either direction, like Notion."""
    out = list(rows)
    for f in view.get("filter") or []:
        if not isinstance(f, dict):
            continue
        prop = props_by_id.get(f.get("property"))
        if prop is not None and isinstance(f.get("op"), str):
            out = [r for r in out if _matches(r, prop, f["op"], f.get("value"))]
    sorts = [s for s in view.get("sort") or [] if isinstance(s, dict) and s.get("property") in props_by_id]
    for s in reversed(sorts):  # stable sorts, last key first
        prop = props_by_id[s["property"]]
        key = _sort_key(prop)
        full = [r for r in out if not _is_empty(raw_value(r, prop))]
        empty = [r for r in out if _is_empty(raw_value(r, prop))]
        if prop.get("type") == "checkbox":
            full, empty = out, []
        try:
            full.sort(key=key, reverse=s.get("direction") == "desc")
        except TypeError:  # mixed value types in one column: leave that key unsorted
            pass
        out = full + empty
    return out


def view_columns(props: list[dict], view: dict) -> list[dict]:
    by_id = {p["id"]: p for p in props}
    order = [pid for pid in view.get("order") or [] if isinstance(pid, str) and pid in by_id]
    ordered = [by_id[pid] for pid in dict.fromkeys(order)] + [p for p in props if p["id"] not in order]
    hidden = {h for h in view.get("hidden") or [] if isinstance(h, str)}
    return [p for p in ordered if p["id"] == "title" or p["id"] not in hidden]


_CURRENCIES = {
    "dollar": "$", "euro": "€", "pound": "£", "yen": "¥", "yuan": "CN¥", "rupee": "₹", "won": "₩",
    "franc": "CHF ", "real": "R$", "ruble": "₽", "peso": "$", "krona": "kr ", "canadian_dollar": "CA$",
    "australian_dollar": "A$",
}


def format_number(v: Any, fmt: Any) -> str:
    n = _number(v)
    if n is None:
        return ""
    fmt = fmt if isinstance(fmt, str) else "number"
    if fmt in _CURRENCIES:
        decimals = 0 if fmt in ("yen", "won") else 2
        return f"{_CURRENCIES[fmt]}{n:,.{decimals}f}"
    if fmt == "percent":
        return f"{n:g}%"
    if fmt == "number_with_commas":
        return f"{n:,.2f}".rstrip("0").rstrip(".") if n != int(n) else f"{int(n):,}"
    return str(int(n)) if n == int(n) and abs(n) < 1e15 else f"{n:g}"


def _parse_dt(s: str) -> datetime | date | None:
    s = s.strip()
    try:
        if len(s) == 10:
            return date.fromisoformat(s)
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def format_date(v: Any) -> str:
    """"Sep 30, 2026", "Sep 30, 2026 14:05", or a range "Sep 1, 2026 → Sep 3, 2026"."""
    if isinstance(v, dict):
        start, end = format_date(v.get("start")), format_date(v.get("end"))
        return f"{start} → {end}" if start and end else start
    if isinstance(v, str):
        parsed = _parse_dt(v)
        if parsed is None:
            return v
        v = parsed
    if isinstance(v, datetime):
        return f"{v:%b} {v.day}, {v.year} {v:%H:%M}" if (v.hour, v.minute) != (0, 0) else f"{v:%b} {v.day}, {v.year}"
    if isinstance(v, date):
        return f"{v:%b} {v.day}, {v.year}"
    return ""


def long_date(v: datetime | date | None) -> str:
    return f"{v:%B} {v.day}, {v.year}" if isinstance(v, (datetime, date)) else ""


def _option_color(prop: dict, name: str) -> str:
    for o in prop.get("options") or []:
        if isinstance(o, dict) and o.get("name") == name and o.get("color") in COLOR_NAMES:
            return o["color"]
    return "gray"


def _pill(prop: dict, name: Any) -> str:
    name = _as_text(name)
    return f'<span class="pill pill-{_option_color(prop, name)}">{esc(name)}</span>' if name else ""


def value_html(prop: dict, row: Any, ctx: RenderContext) -> str:
    """One property value as HTML (a table cell, a row page's property list)."""
    ptype = prop.get("type")
    v = raw_value(row, prop)
    if ptype == "title" or prop["id"] == "title":
        title = esc(_as_text(v) or "Untitled")
        path = ctx.page_path(str(_f(row, "id")))
        icon = icon_html(_f(row, "icon"), ctx, "row-icon")
        return f'<a class="row-link" href="{esc(path)}">{icon}{title}</a>' if path else f"{icon}{title}"
    if _is_empty(v) and ptype != "checkbox":
        return ""
    if ptype == "number":
        return f'<span class="num">{esc(format_number(v, prop.get("number_format")))}</span>'
    if ptype in ("select", "status"):
        return _pill(prop, v)
    if ptype == "multi_select":
        return "".join(_pill(prop, x) for x in (v if isinstance(v, list) else [v]))
    if ptype == "date":
        return f'<span class="date">{esc(format_date(v))}</span>'
    if ptype in ("created_time", "last_edited_time"):
        return f'<span class="date">{esc(format_date(v))}</span>'
    if ptype == "checkbox":
        on = v is True
        return f'<input type="checkbox" disabled{" checked" if on else ""} aria-label="{"Yes" if on else "No"}">'
    if ptype == "url":
        s = _as_text(v).strip()
        href = s if re.match(r"^https?://", s, re.IGNORECASE) else f"https://{s}"
        href = _http_url(href)
        shown = re.sub(r"^https?://(www\.)?", "", s).rstrip("/")
        if not href:
            return esc(s)
        return f'<a href="{esc(href)}" target="_blank" rel="noopener noreferrer">{esc(shown)}</a>'
    if ptype == "email":
        s = _as_text(v).strip()
        if re.match(r"^[^\s@<>\"']+@[^\s@<>\"']+$", s):
            return f'<a href="mailto:{esc(s)}">{esc(s)}</a>'
        return esc(s)
    if ptype == "phone":
        s = _as_text(v).strip()
        if re.match(r"^[+0-9 ()./-]{3,40}$", s):
            return f'<a href="tel:{esc(re.sub(r"[^+0-9]", "", s))}">{esc(s)}</a>'
        return esc(s)
    if ptype == "files":
        links = []
        for item in v if isinstance(v, list) else []:
            if not isinstance(item, dict):
                continue
            name = _str(item.get("name")) or "File"
            url = media_url(item, ctx)
            links.append(f'<a class="file-chip" href="{esc(url)}">{esc(name)}</a>' if url else esc(name))
        return " ".join(links)
    if ptype == "text":
        return ctx.inline(_as_text(v))
    return esc(_as_text(v))


def _db_title_html(db_page: Any, ctx: RenderContext, title_href: str | None) -> str:
    title = esc(_f(db_page, "title") or "Untitled")
    icon = icon_html(_f(db_page, "icon"), ctx, "db-icon") or Markup(TABLE_GLYPH)
    inner = f'<a href="{esc(title_href)}">{title}</a>' if title_href else title
    return f'<div class="db-title">{icon}<span>{inner}</span></div>'


def _db_count_html(n: int) -> str:
    return f'<div class="db-count">{n} {"entry" if n == 1 else "entries"}</div>'


def render_database(db_page: Any, rows: list, ctx: RenderContext, view_id: str | None = None,
                    title_href: str | None = None, show_title: bool = True,
                    today: date | None = None) -> Markup:
    """A database as an HTML table: the chosen view's visible columns, its
    filter and sort, each row's title linking to the row's page. Board and
    gallery views render as a table too; a static page cannot drag cards.
    A database shown with a Gantt view (the one the block names, else its
    first view) renders as a static timeline instead, while it has any row
    with dates to draw (see ``render_gantt``)."""
    schema = _f(db_page, "schema") or {}
    title_html = _db_title_html(db_page, ctx, title_href) if show_title else ""
    gview = gantt_view(schema, view_id)
    if gview is not None:
        gantt = render_gantt(db_page, rows, ctx, gview, today=today)
        if gantt is not None:
            html, shown = gantt
            return Markup(f'<section class="database database-gantt">{title_html}{html}{_db_count_html(shown)}</section>')
    props = schema_properties(schema)
    view = pick_view(schema, view_id)
    columns = view_columns(props, view)
    rows = apply_view(rows, {p["id"]: p for p in props}, view)
    head = "".join(f'<th scope="col" class="col-{esc(_str(p.get("type")) or "text")}">{esc(_str(p.get("name")) or "Untitled")}</th>'
                   for p in columns)
    body = []
    for r in rows:
        cells = []
        for p in columns:
            cls = "cell-title" if p["id"] == "title" else f"cell-{esc(_str(p.get('type')) or 'text')}"
            cells.append(f'<td class="{cls}">{value_html(p, r, ctx)}</td>')
        body.append(f"<tr>{''.join(cells)}</tr>")
    if not body:
        body.append(f'<tr><td class="db-empty" colspan="{len(columns)}">No entries yet</td></tr>')
    return Markup(
        f'<section class="database">{title_html}<div class="table-wrap"><table class="db-table">'
        f"<thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table></div>{_db_count_html(len(rows))}</section>"
    )


# --- Gantt views (§4) --------------------------------------------------------------

# A range longer than this (a typo such as the year 0206 makes one) is cut to
# its last stretch this long; bars before it are left out.
MAX_GANTT_DAYS = 366 * 30


def _day(v: Any) -> date | None:
    """The calendar day of a stored date: "YYYY-MM-DD", with or without a time."""
    if not isinstance(v, str) or len(v) < 10:
        return None
    try:
        return date.fromisoformat(v[:10])
    except ValueError:
        return None


def _month_start(d: date, add: int = 0) -> date:
    n = d.year * 12 + d.month - 1 + add
    return date(n // 12, n % 12 + 1, 1)


def gantt_view(schema: Any, view_id: str | None = None) -> dict | None:
    """The Gantt view a database is shown with, or None: the view the block
    names when that is a Gantt, else the database's first view when it is."""
    views = schema.get("views") if isinstance(schema, dict) else None
    views = [v for v in views if isinstance(v, dict)] if isinstance(views, list) else []
    if view_id:
        named = next((v for v in views if v.get("id") == view_id), None)
        if named is not None:
            return named if named.get("type") == "gantt" else None
    return views[0] if views and views[0].get("type") == "gantt" else None


def gantt_span(row: Any, start_prop: dict, end_prop: dict | None = None) -> tuple[date, date, bool] | None:
    """A row's ``(start, end, milestone)`` in whole days, or None without a
    start. The end is the date's own ``end``, or the end property's date. A
    single date is a milestone; an end before the start is read the other
    way round, as the app does."""
    v = raw_value(row, start_prop)
    start, end = (v.get("start"), v.get("end")) if isinstance(v, dict) else (v, None)
    s = _day(start)
    if s is None:
        return None
    if end_prop is not None:
        ev = raw_value(row, end_prop)
        end = ev.get("start") if isinstance(ev, dict) else ev
    e = _day(end)
    if e is None:
        return s, s, True
    return (s, e, False) if e >= s else (e, s, False)


def render_gantt(db_page: Any, rows: list, ctx: RenderContext, view: dict,
                 today: date | None = None) -> tuple[str, int] | None:
    """A Gantt view as static HTML: row titles (linking to their pages) beside
    a timeline of whole months, one bar per row placed by percentage (a single
    date is a diamond), coloured by the view's ``color_by`` option, and a line
    on today. Returns ``(html, rows shown)``, or None when no row has a date
    (the caller falls back to the table)."""
    schema = _f(db_page, "schema") or {}
    props = schema_properties(schema)
    by_id = {p["id"]: p for p in props}

    def prop_of(key: str, types: tuple[str, ...]) -> dict | None:
        p = by_id.get(view.get(key)) if isinstance(view.get(key), str) else None
        return p if p is not None and p.get("type") in types else None

    start = prop_of("date_property", ("date",)) or next((p for p in props if p.get("type") == "date"), None)
    if start is None:
        return None
    end = prop_of("end_property", ("date",))
    if end is start:
        end = None
    color = prop_of("color_by", ("select", "status"))
    shown = apply_view(rows, by_id, view)
    spans = [(r, gantt_span(r, start, end)) for r in shown]
    dated = [(r, sp) for r, sp in spans if sp is not None]
    if not dated:
        return None

    # Whole months, first to last; a very long range keeps its last stretch.
    hi = _month_start(max(sp[1] for _, sp in dated), 1) - timedelta(days=1)
    lo = _month_start(max(min(sp[0] for _, sp in dated), hi - timedelta(days=MAX_GANTT_DAYS)))
    total = (hi - lo).days + 1

    def pct(d: date) -> float:
        return (d - lo).days / total * 100

    # The scale: months, or years once there are too many months to name.
    months = (hi.year - lo.year) * 12 + hi.month - lo.month + 1
    by_year = months > 14
    segs = []
    m = lo
    while m <= hi:
        nxt = date(m.year + 1, 1, 1) if by_year else _month_start(m, 1)
        seg_end = min(nxt, hi + timedelta(days=1))
        if by_year:
            label = str(m.year)
        else:
            label = f"{m:%b} {m.year}" if m == lo or m.month == 1 else f"{m:%b}"
        segs.append((pct(m), (seg_end - m).days / total * 100, label))
        m = nxt
    scale = "".join(f'<span class="gantt-seg" style="left:{a:.4f}%;width:{w:.4f}%">{esc(label)}</span>'
                    for a, w, label in segs)
    lines = "".join(f'<span class="gantt-line" style="left:{a:.4f}%"></span>' for a, _, _ in segs[1:])
    today = today or datetime.now(UTC).date()
    if lo <= today <= hi:
        lines += f'<span class="gantt-today" style="left:{(pct(today) + 50 / total):.4f}%"></span>'

    title_prop = by_id["title"]
    out = []
    for r, sp in spans:
        bar = ""
        if sp is not None and sp[1] >= lo:
            s, e, milestone = max(sp[0], lo), sp[1], sp[2]
            name = _as_text(raw_value(r, title_prop)) or "Untitled"
            if color is None:
                tone = "accent"
            else:
                value = raw_value(r, color)
                tone = _option_color(color, _as_text(value)) if not _is_empty(value) else "none"
            when = format_date(s) if milestone else f"{format_date(s)} → {format_date(e)}"
            path = ctx.page_path(str(_f(r, "id")))
            tag, href = ("a", f' href="{esc(path)}"') if path else ("span", "")
            left = pct(s) + (50 / total if milestone else 0)
            width = ((e - s).days + 1) / total * 100
            tip = esc(f"{name}: {when}")
            # The title goes inside a bar wide enough for it; otherwise beside
            # it, after it or (near the end) before it, cut to the room there.
            inner = note = ""
            if not milestone and width >= 22:
                inner = f'<span class="gantt-label">{esc(name)}</span>'
            else:
                gap = ".9em" if milestone else ".5em"
                end = left if milestone else left + width
                if end > 72:
                    note = (f'<span class="gantt-note gantt-note-left" style="right:calc({100 - left:.4f}% + {gap})" '
                            f'aria-hidden="true">{esc(name)}</span>')
                else:
                    note = f'<span class="gantt-note" style="left:calc({end:.4f}% + {gap})" aria-hidden="true">{esc(name)}</span>'
            kind = "gantt-ms" if milestone else "gantt-bar"
            style = f"left:{left:.4f}%" if milestone else f"left:{left:.4f}%;width:{width:.4f}%"
            bar = f'<{tag} class="{kind} gb-{tone}"{href} style="{style}" title="{tip}" aria-label="{tip}">{inner}</{tag}>{note}'
        out.append(f'<div class="gantt-row"><div class="gantt-name">{value_html(title_prop, r, ctx)}</div>'
                   f'<div class="gantt-track">{bar}</div></div>')
    corner = esc(_str(title_prop.get("name")) or "Name")
    html = (
        f'<div class="gantt-wrap"><div class="gantt">'
        f'<div class="gantt-head"><div class="gantt-corner">{corner}</div><div class="gantt-scale">{scale}</div></div>'
        f'<div class="gantt-body"><div class="gantt-grid" aria-hidden="true">{lines}</div>{"".join(out)}</div>'
        f"</div></div>"
    )
    return html, len(shown)


def render_properties(db_page: Any, row: Any, ctx: RenderContext) -> Markup:
    """A row page's own property values (all but the title), as Notion shows
    them above the row's content. Empty values are left out, and so are the
    properties the database's main view hides: in the app a hidden column is
    one click away, but on a public website "hidden" should mean not shown."""
    schema = _f(db_page, "schema")
    hidden = {h for h in pick_view(schema).get("hidden") or [] if isinstance(h, str)}
    items = []
    for p in schema_properties(schema):
        if p["id"] == "title" or p["id"] in hidden:
            continue
        html = value_html(p, row, ctx)
        if not html or (p.get("type") == "checkbox" and raw_value(row, p) is not True):
            continue
        items.append(f'<div class="prop"><dt>{esc(_str(p.get("name")) or "Untitled")}</dt><dd>{html}</dd></div>')
    return Markup(f'<dl class="props">{"".join(items)}</dl>') if items else Markup("")


def row_date(db_page: Any, row: Any) -> Any:
    """The first date property's value of a row (a blog post's date), or None."""
    for p in schema_properties(_f(db_page, "schema")):
        if p.get("type") == "date":
            v = raw_value(row, p)
            if isinstance(v, dict):
                v = v.get("start")
            if isinstance(v, str) and (parsed := _parse_dt(v)) is not None:
                return parsed
    return None


def file_path_segment(name: str) -> str:
    return quote(name or "file", safe="")
