"""Published-site rendering without a database: inline Markdown (meerail's
dialect), every block type, databases, and escaping of hostile input."""

import re
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest

from app.mdinline import inline_html, inline_text
from app.render import (
    BlockNode,
    RenderContext,
    build_tree,
    embed_src,
    excerpt,
    first_paragraph,
    icon_html,
    render_blocks,
    render_database,
    render_properties,
    slugify,
)

PAGES = {
    "p-child": SimpleNamespace(id="p-child", title="Chickens", icon="🐔", kind="page"),
    "p-db": SimpleNamespace(id="p-db", title="Diary", icon=None, kind="database"),
}
PATHS = {"p-child": "/chickens", "p-db": "/diary", "r1": "/diary/frost", "r2": "/diary/coop", "r3": "/diary/fest"}
FILES = {"f-img": "meadow.jpg", "f-pdf": "prices.pdf"}

SCHEMA = {
    "properties": [
        {"id": "title", "name": "Entry", "type": "title"},
        {"id": "p_date", "name": "Date", "type": "date"},
        {"id": "p_status", "name": "Status", "type": "select",
         "options": [{"id": "o1", "name": "Draft", "color": "gray"}, {"id": "o2", "name": "Done", "color": "green"}]},
        {"id": "p_eggs", "name": "Eggs", "type": "number", "number_format": "number_with_commas"},
        {"id": "p_secret", "name": "Secret", "type": "text"},
        {"id": "p_ok", "name": "Checked", "type": "checkbox"},
        {"id": "p_url", "name": "Link", "type": "url"},
    ],
    "views": [{"id": "v1", "name": "All", "type": "table", "hidden": ["p_secret"],
               "sort": [{"property": "p_eggs", "direction": "desc"}]}],
}


def row(rid, title, **props):
    return SimpleNamespace(id=rid, title=title, icon=None, props=props,
                           created_at=datetime(2026, 9, 1, tzinfo=UTC), updated_at=datetime(2026, 9, 2, tzinfo=UTC))


ROWS = [
    row("r1", "Frost", p_date="2026-09-28", p_status="Done", p_eggs=1200, p_secret="hush", p_ok=True,
        p_url="example.com/a"),
    row("r2", "Coop", p_date="2026-09-14", p_status="Draft", p_eggs=55),
    row("r3", "Fest", p_eggs=None),
]


class FakeCtx(RenderContext):
    def file_url(self, file_id, name=None):
        return f"/_files/{file_id}/{FILES[file_id]}" if file_id in FILES else None

    def page_path(self, page_id):
        return PATHS.get(page_id)

    def page(self, page_id):
        return PAGES.get(page_id)

    def database(self, page_id):
        if page_id != "p-db":
            return None
        return SimpleNamespace(id="p-db", title="Diary", icon="📔", schema=SCHEMA), list(ROWS)


def node(type_, text="", children=None, **props):
    return BlockNode(id=type_ + text[:5], type=type_, text=text, props=props, children=children or [])


def render(*nodes, ctx=None):
    ctx = ctx or FakeCtx()
    return str(render_blocks(list(nodes), ctx)), ctx


# --- Inline Markdown ----------------------------------------------------------


def test_inline_rules_match_meerail():
    out = inline_html("**bold** *em* _em_ ~~gone~~ ==hi== `**code**` snake_case_name *.txt")
    assert "<strong>bold</strong>" in out
    assert out.count("<em>em</em>") == 2
    assert "<del>gone</del>" in out and "<mark>hi</mark>" in out
    assert '<code class="md-code">**code**</code>' in out  # nothing inside code is Markdown
    assert "snake_case_name" in out and "*.txt" in out  # emphasis needs word boundaries
    assert inline_html("**bold *and em***") == "<strong>bold <em>and em</em></strong>"
    assert inline_html("a\nb") == "a<br>b"


def test_inline_links_and_urls():
    out = inline_html("[the **site**](https://example.com) or https://example.com/x.")
    assert '<a href="https://example.com" target="_blank" rel="noopener noreferrer">the <strong>site</strong></a>' in out
    assert '>https://example.com/x</a>.' in out  # the full stop stays outside
    assert inline_html("[me](mailto:a@b.c)") == '<a href="mailto:a@b.c">me</a>'


def test_internal_links_use_the_resolver():
    assert inline_html("[A](/p/abc)") == '<a href="/p/abc">A</a>'
    assert inline_html("[A](/p/abc#part)", lambda pid: "/a") == '<a href="/a#part">A</a>'
    # Not part of the site: the words stay, the link goes.
    assert inline_html("see [A **b**](/p/abc)", lambda pid: None) == "see A <strong>b</strong>"


def test_inline_text_strips_markers():
    assert inline_text("**a** [b](https://x) `c` ==d==\n_e_") == "a b c d e"


@pytest.mark.parametrize("src", [
    "[x](javascript:alert(1))",
    "[x](JavaScript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](//evil.example/)",
    "[x](vbscript:msgbox)",
])
def test_unsafe_link_schemes_become_hash(src):
    out = inline_html(src)
    assert re.findall(r'href="([^"]*)"', out) == ["#"]
    assert "<script" not in out


def test_inline_escapes_everything():
    out = inline_html('<script>alert(1)</script> & "quotes" <img src=x onerror=alert(1)>')
    assert "<script" not in out and "<img" not in out
    assert "&lt;script&gt;" in out and "&amp;" in out and "&quot;quotes&quot;" in out
    # A quote cannot break out of the href attribute.
    out = inline_html('[x](https://a.example/"onmouseover="alert(1))')
    assert 'onmouseover="' not in out


# --- Tree -----------------------------------------------------------------------


def test_build_tree_orders_and_drops_deleted_subtrees():
    blocks = [
        {"id": "b", "type": "paragraph", "text": "second", "position": 2},
        {"id": "a", "type": "toggle", "text": "first", "position": 1},
        {"id": "a1", "parent_id": "a", "type": "paragraph", "text": "inside", "position": 1},
        {"id": "gone", "type": "toggle", "text": "deleted", "position": 3, "deleted": True},
        {"id": "orphan", "parent_id": "gone", "type": "paragraph", "text": "under deleted", "position": 1},
        {"id": "x", "parent_id": "y", "type": "paragraph", "position": 1},  # a cycle nobody reaches
        {"id": "y", "parent_id": "x", "type": "paragraph", "position": 1},
    ]
    tree = build_tree(blocks)
    assert [n.id for n in tree] == ["a", "b"]
    assert [n.id for n in tree[0].children] == ["a1"]
    html, _ = render(*tree)
    assert "under deleted" not in html and "deleted" not in html


# --- Every block type -------------------------------------------------------------


def test_text_blocks_and_colors():
    html, ctx = render(
        node("paragraph", "Hello **world**", color="red"),
        node("heading_1", "Big"),
        node("heading_2", "Medium", color="blue_bg"),
        node("heading_3", "Small"),
        node("quote", "Wise words"),
        node("callout", "Careful", color="yellow_bg"),
        node("callout", "With icon", icon="🔥"),
        node("divider"),
        node("paragraph", "bad color", color='red" onclick="x'),
    )
    assert '<p class="c-red">Hello <strong>world</strong></p>' in html
    assert '<h2 id="big" class="heading">Big' in html
    assert '<h3 id="medium" class="heading bg-blue">' in html
    assert '<h4 id="small" class="heading">' in html
    assert "<blockquote><p>Wise words</p></blockquote>" in html
    assert '<aside class="callout bg-yellow">' in html and "💡" in html and "🔥" in html
    assert "<hr>" in html
    assert "onclick" not in html
    assert [h["id"] for h in ctx.headings] == ["big", "medium", "small"]


def test_lists_group_nest_and_restart_numbering():
    tree = [
        node("numbered_list", "one", [node("numbered_list", "one-a"), node("numbered_list", "one-b")]),
        node("numbered_list", "two"),
        node("paragraph", "break"),
        node("numbered_list", "again"),
        node("bulleted_list", "dot", [node("bulleted_list", "inner")]),
        node("to_do", "done", checked=True),
        node("to_do", "open"),
    ]
    html, _ = render(*tree)
    assert html.count('<ol class="ol-decimal">') == 2  # the paragraph restarts the numbering
    assert '<ol class="ol-alpha"><li>one-a</li><li>one-b</li></ol>' in html
    assert "<li>one<ol" in html  # nested inside its parent item
    assert '<ul class="ul-disc"><li>dot<ul class="ul-circle"><li>inner</li></ul></li></ul>' in html
    assert html.count('<ul class="todo-list">') == 1
    assert 'class="todo checked"' in html and "disabled checked" in html
    assert html.count('type="checkbox" disabled') == 2


def test_toggle_code_mermaid_equation():
    html, ctx = render(
        node("toggle", "More", [node("paragraph", "hidden inside")]),
        node("code", "print('<b>')", language="python"),
        node("code", "graph LR\n A-->B", language="mermaid"),
        node("code", "x", language='py" onload="alert(1)'),
        node("equation", "E = mc^2"),
    )
    assert '<details class="toggle"><summary>More</summary><div class="toggle-body"><p>hidden inside</p></div></details>' in html
    assert '<code class="language-python"><span class="tok-nb">print</span>' in html
    assert "&lt;b&gt;" in html and "<b>" not in html
    assert '<pre class="mermaid">graph LR\n A--&gt;B</pre>' in html
    # The language is reduced to an inert class name; no attribute escapes.
    assert 'onload="' not in html and 'class="language-pyonloadalert1"' in html
    assert '<code class="math">E = mc^2</code>' in html
    assert ctx.needs_mermaid and ctx.needs_math


def test_code_is_highlighted_server_side():
    html, ctx = render(
        node("code", "def f(x):\n    return \"</code><script>\"  # hi", language="python"),
        node("code", "echo $HOME", language="shell"),
        node("code", "just words", language="plain"),
        node("code", "whatever", language="klingon"),
    )
    assert '<span class="tok-k">def</span>' in html and '<span class="tok-c1"># hi</span>' in html
    assert '<span class="tok-nb">echo</span>' in html
    # Everything inside is escaped; nothing closes the <code> early.
    assert "<script>" not in html and "&lt;/code&gt;&lt;script&gt;" in html
    # No language, or one Pygments does not know: plain escaped text.
    assert '<code class="language-plain">just words</code>' in html
    assert '<code class="language-klingon">whatever</code>' in html
    # And no JavaScript is needed for any of it.
    assert not ctx.needs_mermaid and not ctx.needs_math


def test_highlighting_keeps_the_text_exactly():
    import html as htmlmod

    from app.render import highlight_code

    for code, lang in [("def f(x):\n    return 1", "python"), ("\n  echo $HOME\n", "shell"),
                       ("a\n\n\nb\n\n", "javascript"), ("<p>x</p>", "html")]:
        out = highlight_code(code, lang)
        assert htmlmod.unescape(re.sub(r"<[^>]+>", "", out)) == code


def test_no_scripts_needed_without_mermaid_or_math():
    _, ctx = render(node("code", "x = 1", language="python"), node("paragraph", "$x$"))
    assert not ctx.needs_mermaid and not ctx.needs_math


def test_media_blocks():
    html, _ = render(
        node("image", "A **meadow**", file_id="f-img", width=480),
        node("image", "external", url="https://example.com/a.png"),
        node("image", "not on this site", file_id="f-unknown"),
        node("image", "evil", url="javascript:alert(1)"),
        node("image", "css", file_id="f-img", width="480px;background:url(x)"),
        node("file", "The prices", file_id="f-pdf", name="prices.pdf", content_type="application/pdf", size=184320),
        node("file", "", url="https://example.com/doc.zip", name="doc.zip"),
        node("bookmark", "cap", url="https://example.com/post", title="A post", description="About things"),
        node("bookmark", "", url="javascript:alert(1)"),
    )
    assert '<figure class="image" style="width:480px"><img src="/_files/f-img/meadow.jpg" alt="A meadow"' in html
    assert "<figcaption>A <strong>meadow</strong></figcaption>" in html
    assert 'src="https://example.com/a.png"' in html
    assert "f-unknown" not in html and "not on this site" not in html
    assert "javascript" not in html and "background:url" not in html
    assert '<iframe src="/_files/f-pdf/prices.pdf" title="prices.pdf"' in html and "180 KB" in html
    assert 'href="https://example.com/doc.zip"' in html and "<iframe src=\"https://example.com" not in html
    assert '<span class="bm-title">A post</span>' in html and "example.com" in html


def test_embeds_use_the_allow_list():
    html, _ = render(
        node("embed", "Tour", url="https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90"),
        node("embed", "", url="https://youtu.be/dQw4w9WgXcQ"),
        node("embed", "", url="https://vimeo.com/76979871"),
        node("embed", "", url="https://www.loom.com/share/0123456789abcdef0123456789abcdef"),
        node("embed", "", url="https://www.google.com/maps/place/Lüneburg/@53.25,10.41,13z"),
        node("embed", "Other", url="https://evil.example/frame"),
    )
    assert 'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90"' in html
    assert html.count("youtube-nocookie.com/embed/dQw4w9WgXcQ") == 2
    assert 'src="https://player.vimeo.com/video/76979871"' in html
    assert 'src="https://www.loom.com/embed/0123456789abcdef0123456789abcdef"' in html
    assert 'src="https://maps.google.com/maps?q=L%C3%BCneburg&amp;z=13&amp;output=embed"' in html
    assert 'sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"' in html
    # Not on the list: a link, never an iframe.
    assert '<iframe src="https://evil.example' not in html and 'href="https://evil.example/frame"' in html


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=\"><script>",
    "https://www.youtube.com/embed/abc\"onload=x",
    "javascript://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
])
def test_embed_ids_are_validated(url):
    assert embed_src(url) is None


def test_simple_table():
    html, _ = render(node("table", rows=[["Name", "**Eggs**"], ["Frieda", "<b>7</b>"], ["Ragged"]],
                          header_row=True, header_col=True))
    assert '<thead><tr><th scope="col">Name</th><th scope="col"><strong>Eggs</strong></th></tr></thead>' in html
    assert '<th scope="row">Frieda</th><td>&lt;b&gt;7&lt;/b&gt;</td>' in html
    assert '<th scope="row">Ragged</th><td></td>' in html  # padded to the widest row
    assert render(node("table", rows="nope"))[0] == ""


def test_page_links_only_for_pages_on_the_site():
    html, ctx = render(node("page", page_id="p-child"), node("page", page_id="p-elsewhere"))
    assert '<a class="page-link" href="/chickens">' in html and "Chickens" in html
    assert "p-elsewhere" not in html
    assert ctx.linked_page_ids == {"p-child", "p-elsewhere"}
    ctx = FakeCtx()
    ctx.skip_page_ids = {"p-child"}
    assert render(node("page", page_id="p-child"), ctx=ctx)[0] == ""


def test_database_block_respects_view():
    html, _ = render(node("database", page_id="p-db"), node("database", page_id="p-missing"))
    assert html.count('<section class="database">') == 1
    assert "Secret" not in html and "hush" not in html  # hidden in the view
    # Sorted by eggs, descending, empty last; rows link to their pages.
    assert html.index("Frost") < html.index("Coop") < html.index("Fest")
    assert '<a class="row-link" href="/diary/frost">Frost</a>' in html
    assert '<span class="pill pill-green">Done</span>' in html
    assert "1,200" in html and "Sep 28, 2026" in html
    assert 'href="https://example.com/a"' in html
    assert '<a href="/diary">Diary</a>' in html


def test_database_filter_and_properties():
    db_page = SimpleNamespace(title="Diary", icon=None, schema={
        **SCHEMA, "views": [{"id": "v", "type": "table", "filter": [{"property": "p_status", "op": "eq", "value": "Draft"}]}],
    })
    html = str(render_database(db_page, list(ROWS), FakeCtx()))
    assert "Coop" in html and "Frost" not in html and "1 entry" in html
    props = str(render_properties(SimpleNamespace(schema=SCHEMA), ROWS[0], FakeCtx()))
    assert "Status" in props and "Done" in props and "Secret" not in props and "hush" not in props


def test_unknown_block_type_keeps_its_text():
    html, _ = render(node("fancy_new_thing", "still **here**"))
    assert "<p>still <strong>here</strong></p>" in html


def test_every_documented_block_type_renders():
    kinds = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list", "numbered_list", "to_do",
             "toggle", "quote", "callout", "code", "divider", "image", "file", "bookmark", "embed", "table",
             "page", "database", "equation"]
    props = {"image": {"file_id": "f-img"}, "file": {"file_id": "f-pdf", "name": "a.txt"},
             "bookmark": {"url": "https://a.example"}, "embed": {"url": "https://youtu.be/dQw4w9WgXcQ"},
             "table": {"rows": [["a"]]}, "page": {"page_id": "p-child"}, "database": {"page_id": "p-db"}}
    for kind in kinds:
        html, _ = render(node(kind, "text", **props.get(kind, {})))
        assert html.strip(), kind


# --- Gantt views -------------------------------------------------------------------

GANTT_SCHEMA = {
    "properties": [
        {"id": "title", "name": "Task", "type": "title"},
        {"id": "p_dates", "name": "Dates", "type": "date"},
        {"id": "p_status", "name": "Status", "type": "status",
         "options": [{"id": "o1", "name": "Doing", "color": "blue"}, {"id": "o2", "name": "Done", "color": "green"}]},
        {"id": "p_due", "name": "Due", "type": "date"},
    ],
    "views": [
        {"id": "vg", "name": "Gantt", "type": "gantt", "date_property": "p_dates", "color_by": "p_status", "zoom": "week"},
        {"id": "vt", "name": "Table", "type": "table"},
    ],
}
GANTT_ROWS = [
    row("r1", "Frost", p_dates={"start": "2026-09-01", "end": "2026-09-30"}, p_status="Done"),
    row("r2", "Coop", p_dates="2026-10-15T09:30", p_status="Doing"),  # a single date: a milestone
    row("r3", "Fest"),  # no dates yet
]
TODAY = date(2026, 9, 30)


def gantt_db(schema=GANTT_SCHEMA):
    return SimpleNamespace(title="Plan", icon=None, schema=schema)


def test_gantt_bars_are_placed_by_percentage():
    html = str(render_database(gantt_db(), list(GANTT_ROWS), FakeCtx(), title_href="/diary", today=TODAY))
    assert '<section class="database database-gantt">' in html and "<table" not in html
    assert '<a href="/diary">Plan</a>' in html
    # Whole months: September and October 2026 are 61 days, September 30 of them.
    assert '<span class="gantt-seg" style="left:0.0000%;width:49.1803%">Sep 2026</span>' in html
    assert '<span class="gantt-seg" style="left:49.1803%;width:50.8197%">Oct</span>' in html
    assert '<span class="gantt-line" style="left:49.1803%"></span>' in html
    # A range is a bar from its first to its last day, coloured by its status,
    # linking to the row's page, with the title inside.
    assert ('<a class="gantt-bar gb-green" href="/diary/frost" style="left:0.0000%;width:49.1803%" '
            'title="Frost: Sep 1, 2026 → Sep 30, 2026" aria-label="Frost: Sep 1, 2026 → Sep 30, 2026">'
            '<span class="gantt-label">Frost</span></a>') in html
    # A single date (here with a time of day) is a diamond in the middle of
    # its day; near the end of the range its title goes before it.
    assert '<a class="gantt-ms gb-blue" href="/diary/coop" style="left:72.9508%" title="Coop: Oct 15, 2026"' in html
    assert '<span class="gantt-note gantt-note-left" style="right:calc(27.0492% + .9em)" aria-hidden="true">Coop</span>' in html
    # Today, in the middle of its day.
    assert '<span class="gantt-today" style="left:48.3607%"></span>' in html
    # Every row is listed and links to its page, the undated one without a bar.
    for path, name in (("/diary/frost", "Frost"), ("/diary/coop", "Coop"), ("/diary/fest", "Fest")):
        assert f'<div class="gantt-name"><a class="row-link" href="{path}">{name}</a></div>' in html
    assert html.count('class="gantt-row"') == 3 and html.count("gantt-bar ") == 1 and html.count("gantt-ms ") == 1
    assert html.index("Frost") < html.index("Coop") < html.index("Fest")
    assert "3 entries" in html


def test_gantt_end_property_filter_and_narrow_bars():
    view = {"id": "vg", "type": "gantt", "date_property": "p_dates", "end_property": "p_due",
            "filter": [{"property": "p_status", "op": "eq", "value": "Doing"}]}
    schema = {**GANTT_SCHEMA, "views": [{"id": "vt", "type": "table"}, view]}
    rows = [row("r1", "Frost", p_dates="2026-09-10", p_due="2026-09-05", p_status="Doing"),
            row("r2", "Coop", p_dates="2026-09-01", p_status="Done")]
    # The block names the Gantt view, which is not the first one.
    html = str(render_database(gantt_db(schema), rows, FakeCtx(), view_id="vg", today=date(2027, 1, 1)))
    # An end before the start is read the other way round: Sep 5 to 10, 6 of
    # September's 30 days. Too short for its title, which goes after it; and
    # without a colour property the bar takes the site's accent.
    assert '<a class="gantt-bar gb-accent" href="/diary/frost" style="left:13.3333%;width:20.0000%"' in html
    assert '<span class="gantt-note" style="left:calc(33.3333% + .5em)" aria-hidden="true">Frost</span>' in html
    assert "Coop" not in html and "1 entry" in html  # filtered out
    assert "gantt-today" not in html  # today is outside the range


def test_gantt_long_ranges_are_labelled_by_year_and_capped():
    rows = [row("r1", "Frost", p_dates={"start": "2026-01-01", "end": "2026-03-31"}),
            row("r2", "Coop", p_dates="2027-12-24")]
    html = str(render_database(gantt_db(), rows, FakeCtx(), today=TODAY))
    assert ">2026</span>" in html and ">2027</span>" in html and ">Jan" not in html
    assert '<a class="gantt-bar gb-none" href="/diary/frost" style="left:0.0000%;width:12.3288%"' in html
    # A typo in a year cannot make a strip of centuries: the range keeps its
    # last thirty years, and a bar before that is left out.
    rows.append(row("r3", "Fest", p_dates="0206-05-01"))
    html = str(render_database(gantt_db(), rows, FakeCtx(), today=TODAY))
    assert html.count('class="gantt-seg"') <= 31 and html.count("gantt-bar ") == 1 and "/diary/fest" in html


def test_gantt_escapes_everything():
    evil = '<script>alert(1)</script>'
    schema = {
        "properties": [
            {"id": "title", "name": evil, "type": "title"},
            {"id": "p_dates", "name": evil, "type": "date"},
            {"id": "p_status", "name": "Status", "type": "select",
             "options": [{"id": "o1", "name": evil, "color": 'red" onmouseover="alert(1)'}]},
        ],
        # No date_property: the first date property draws the bars.
        "views": [{"id": "vg", "type": "gantt", "color_by": "p_status"}],
    }
    rows = [row("r1", evil, p_dates={"start": "2026-09-01", "end": '2026-09-03"><img src=x onerror=alert(1)>'}, p_status=evil),
            row("r2", "Coop", p_dates='"><b>not a date</b>')]
    html = str(render_database(gantt_db(schema), rows, FakeCtx(), today=TODAY))
    assert "gantt-bar" in html
    assert "<script" not in html and "<img" not in html and "<b>" not in html and "onmouseover" not in html
    assert "&lt;script&gt;" in html
    assert "gb-gray" in html  # an unknown colour falls back to gray, never into the class


def test_gantt_falls_back_to_the_table():
    # No row with a date: the table, with every row.
    html = str(render_database(gantt_db(), [GANTT_ROWS[2]], FakeCtx(), today=TODAY))
    assert 'class="db-table"' in html and "gantt" not in html and "Fest" in html
    # No date property at all.
    no_dates = {**GANTT_SCHEMA, "properties": [GANTT_SCHEMA["properties"][0], GANTT_SCHEMA["properties"][2]]}
    html = str(render_database(gantt_db(no_dates), list(GANTT_ROWS), FakeCtx(), today=TODAY))
    assert 'class="db-table"' in html and "gantt" not in html
    # A block that names the table view shows the table, Gantt first or not.
    html = str(render_database(gantt_db(), list(GANTT_ROWS), FakeCtx(), view_id="vt", today=TODAY))
    assert 'class="db-table"' in html and "gantt-bar" not in html
    # A Gantt that is not the first view is not what a plain database shows.
    later = {**GANTT_SCHEMA, "views": list(reversed(GANTT_SCHEMA["views"]))}
    html = str(render_database(gantt_db(later), list(GANTT_ROWS), FakeCtx(), today=TODAY))
    assert 'class="db-table"' in html and "gantt-bar" not in html


# --- Escaping of everything else -------------------------------------------------


def test_icons_and_captions_are_escaped():
    ctx = FakeCtx()
    assert str(icon_html('<img src=x onerror=1>', ctx)) == ""  # too long to be an emoji
    assert "&lt;b&gt;" in str(icon_html("<b>", ctx))
    assert str(icon_html("javascript:alert(1)", ctx)) == ""
    assert 'src="https://x.example/i.png"' in str(icon_html("https://x.example/i.png", ctx))
    quoted = str(icon_html("https://x.example/\"onerror=\"1", ctx))
    assert 'onerror="' not in quoted and "&quot;onerror=&quot;1" in quoted
    html, _ = render(node("callout", "x", icon='"><script>alert(1)</script>'))
    assert "<script" not in html


def test_script_in_every_text_field_is_escaped():
    evil = '<script>alert(1)</script>'
    html, _ = render(
        node("paragraph", evil), node("heading_1", evil), node("toggle", evil), node("quote", evil),
        node("callout", evil), node("code", evil), node("image", evil, file_id="f-img"),
        node("bookmark", evil, url="https://a.example", title=evil, description=evil),
        node("table", rows=[[evil]]), node("equation", evil), node("to_do", evil), node("bulleted_list", evil),
    )
    assert "<script" not in html


# --- Helpers ------------------------------------------------------------------------


def test_slugify():
    assert slugify("Hühner & Gänse!") == "huehner-gaense"
    assert slugify("Straße über Café") == "strasse-ueber-cafe"
    assert slugify("  Hello,   World  ") == "hello-world"
    assert slugify("🐔🐔") == ""
    assert len(slugify("x" * 200)) == 60


def test_excerpt_and_first_paragraph():
    tree = [node("paragraph", ""), node("paragraph", "The **first** words."), node("paragraph", "More")]
    assert first_paragraph(tree).text == "The **first** words."
    assert excerpt(tree) == "The first words."
    assert first_paragraph([node("heading_1", "Title"), node("paragraph", "p")]) is None
