"""Inline Markdown to HTML, in meerail's dialect (docs/DESIGN.md §3).

A port of the reader half of meerail's ``app/static/js/app.markdown.js``:
``inlineHtml`` with ``keep = false``, so markers are consumed and ``**a**``
becomes a bold "a". Published websites render pages on the server (search
engines and visitors without JavaScript get real HTML), and they must read a
block's text exactly the way the editor does, or a page would change its look
the moment it is published.

How the parser works (the same loop as meerail's): at each step every rule is
tried against the rest of the string and the match that *starts earliest*
wins, ties going to the rule listed first. That is why code spans come first:
nothing inside a code span is Markdown. The text before the match is escaped,
the match is rendered, and parsing carries on after it. Nested markers (bold
inside a link, emphasis inside bold) are handled by recursing into the matched
inner text. Every character of input reaches the output escaped or not at all.

Deliberate differences from meerail:

* ``==highlight==`` is a meerpad addition and renders as ``<mark>``.
* ``\\n`` inside a block is a soft line break (Shift+Enter) and becomes
  ``<br>``. meerail splits a mail into lines before it ever calls inlineHtml.
* meerail prints a link's address after its text, for plain-text mail readers
  (``hrefTag``). A web page has no such reader, so that part is left out.
* Internal links, ``[Title](/p/<page_id>)``, are allowed next to http, https
  and mailto. Where they point is up to the caller's ``link_resolver``: a
  published site maps them to its own paths, or drops the link (keeping the
  text) when the page is not part of the site.
"""

import re
from collections.abc import Callable
from html import escape

LinkResolver = Callable[[str], str | None]

# JavaScript's \w is ASCII only and Python's is Unicode, so the word-boundary
# classes are spelled out. With \w, "grüße_x_" would stop matching emphasis in
# Python while the editor (JS) still italicises it.
_W = "A-Za-z0-9_"

# (kind, pattern). Order matters only for ties at the same start index.
_RULES: list[tuple[str, re.Pattern]] = [
    # Code first: nothing inside a code span is Markdown.
    ("code", re.compile(r"`([^`\n]+)`")),
    # The trailing lookahead makes the lazy match skip a closing run that is
    # really a longer delimiter, so `**bold *and em***` closes where it should.
    ("strong", re.compile(r"\*\*(\S(?:[^\n]*?\S)?)\*\*(?!\*)")),
    ("del", re.compile(r"~~(\S(?:[^\n]*?\S)?)~~(?!~)")),
    ("mark", re.compile(r"==(\S(?:[^\n]*?\S)?)==(?!=)")),
    # Emphasis needs the delimiter on a word boundary, or every snake_case
    # identifier and *.txt glob turns italic.
    ("em", re.compile(rf"(?<![{_W}*])\*(\S(?:[^\n*]*?\S)?)\*(?![{_W}*])")),
    ("em", re.compile(rf"(?<![{_W}])_(\S(?:[^\n_]*?\S)?)_(?![{_W}])")),
    ("link", re.compile(r"\[([^\]\n]*)\]\(([^)\s]+)\)")),
    # Bare URLs. The last-character class keeps sentence punctuation out of
    # the link, which would otherwise swallow the full stop after a URL.
    ("url", re.compile(rf"(?<![{_W}@.])(https?://[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'\"])")),
]

_TAGS = {"strong": "strong", "del": "del", "mark": "mark", "em": "em"}

# /p/<page_id>, optionally with a #fragment (a heading anchor on that page).
_INTERNAL = re.compile(r"^/p/([A-Za-z0-9-]{1,64})(#[A-Za-z0-9_-]{1,100})?$")
_SAFE_SCHEME = re.compile(r"^(https?:|mailto:)", re.IGNORECASE)


def esc(s: str) -> str:
    """HTML-escape text and attribute values (quotes included)."""
    return escape(s, quote=True)


def safe_url(url: str) -> str:
    """The URL itself if it is http, https or mailto, else ``#``.

    javascript:, data: and friends must never survive into an href. Relative
    and protocol-relative URLs (``//evil.example``) are refused too: the
    contract only allows the three schemes and ``/p/`` (handled separately)."""
    url = (url or "").strip()
    return url if _SAFE_SCHEME.match(url) else "#"


def internal_page_id(url: str) -> tuple[str, str] | None:
    """``(page_id, fragment)`` for an internal ``/p/<id>`` link, else None."""
    m = _INTERNAL.match(url or "")
    return (m.group(1), m.group(2) or "") if m else None


def _next_match(rest: str) -> tuple[str, re.Match] | None:
    best = None
    for kind, rx in _RULES:
        m = rx.search(rest)
        if m and (best is None or m.start() < best[1].start()):
            best = (kind, m)
    return best


def _link_html(inner_src: str, url: str, resolver: LinkResolver | None) -> str:
    inner = _line_html(inner_src, resolver)
    internal = internal_page_id(url)
    if internal:
        page_id, frag = internal
        if resolver is None:
            return f'<a href="{esc(url)}">{inner}</a>'
        target = resolver(page_id)
        if target is None:
            # The page is not reachable from here (not part of a published
            # site): keep the words, drop the link.
            return inner
        return f'<a href="{esc(target + frag)}">{inner}</a>'
    href = safe_url(url)
    if href == "#":
        return f'<a href="#">{inner}</a>'
    if href.lower().startswith("mailto:"):
        return f'<a href="{esc(href)}">{inner}</a>'
    return f'<a href="{esc(href)}" target="_blank" rel="noopener noreferrer">{inner}</a>'


def _line_html(src: str, resolver: LinkResolver | None) -> str:
    """One line (no newlines) to HTML. Slices the rest of the string on every
    step, like meerail: a lookbehind then only ever sees the unparsed part, so
    ``**a**_b_`` italicises ``b`` in both implementations."""
    out: list[str] = []
    rest = src
    while rest:
        found = _next_match(rest)
        if found is None:
            out.append(esc(rest))
            break
        kind, m = found
        out.append(esc(rest[: m.start()]))
        if kind == "code":
            out.append(f'<code class="md-code">{esc(m.group(1))}</code>')
        elif kind in _TAGS:
            tag = _TAGS[kind]
            out.append(f"<{tag}>{_line_html(m.group(1), resolver)}</{tag}>")
        elif kind == "link":
            out.append(_link_html(m.group(1), m.group(2), resolver))
        else:  # bare url
            url = m.group(1)
            out.append(f'<a href="{esc(safe_url(url))}" target="_blank" rel="noopener noreferrer">{esc(url)}</a>')
        rest = rest[m.end():]
    return "".join(out)


def inline_html(text: str | None, link_resolver: LinkResolver | None = None) -> str:
    """Render a block's inline Markdown to safe HTML.

    ``link_resolver(page_id)`` maps an internal ``/p/<page_id>`` link to a URL,
    or returns None to render the link's text without a link. Without a
    resolver, internal links keep their ``/p/<page_id>`` address (the app's)."""
    if not text:
        return ""
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "<br>".join(_line_html(line, link_resolver) for line in lines)


def _line_text(src: str) -> str:
    out: list[str] = []
    rest = src
    while rest:
        found = _next_match(rest)
        if found is None:
            out.append(rest)
            break
        kind, m = found
        out.append(rest[: m.start()])
        if kind == "code":
            out.append(m.group(1))
        elif kind in _TAGS or kind == "link":
            out.append(_line_text(m.group(1)))
        else:
            out.append(m.group(1))
        rest = rest[m.end():]
    return "".join(out)


def inline_text(text: str | None) -> str:
    """The plain text a reader sees, markers removed (for <title>, meta
    descriptions, alt text and excerpts). Not escaped: the caller's template
    engine does that. Soft line breaks become spaces."""
    if not text:
        return ""
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return " ".join(_line_text(line) for line in lines).strip()
