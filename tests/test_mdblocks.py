"""Markdown to blocks and back (app/mdblocks.py): every construct of Notion's
export dialect, its quirks, and the round trip parse(write(parse(x))) == parse(x)."""

import pytest

from app.mdblocks import (
    BlockNode,
    blocks_to_markdown,
    find_links,
    parse_markdown,
    split_icon,
    value_to_text,
    whole_link,
)


def B(type, text="", props=None, children=None):  # a short name: the trees below read like the dataclass
    return BlockNode(type, text, props or {}, children or [])


def roundtrip(md: str) -> list[BlockNode]:
    tree = parse_markdown(md)
    assert parse_markdown(blocks_to_markdown(tree)) == tree
    return tree


# --- Parsing ------------------------------------------------------------------------


def test_headings_and_levels():
    tree = roundtrip("# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six\n\n#hashtag")
    assert [(b.type, b.text) for b in tree] == [
        ("heading_1", "One"), ("heading_2", "Two"), ("heading_3", "Three"),
        ("heading_3", "Four"), ("heading_3", "Six"), ("paragraph", "#hashtag"),
    ]


def test_paragraphs_join_lines_as_soft_breaks_and_strip_trailing_space():
    tree = roundtrip("First line  \nsecond **line**\t\n\nNext paragraph   \n")
    assert tree == [B("paragraph", "First line\nsecond **line**"), B("paragraph", "Next paragraph")]


def test_inline_markdown_is_kept_verbatim():
    src = "**bold** *em* _em_ ~~strike~~ `code **not bold**` [link](https://x.org) ==mark== snake_case"
    assert roundtrip(src) == [B("paragraph", src)]


def test_lists_todos_and_notion_double_space():
    tree = roundtrip("- a\n* b\n+ c\n1. one\n2. two\n- [ ]  open\n- [x] done\n- [X]  also done\n- [ ]")
    assert tree == [
        B("bulleted_list", "a"), B("bulleted_list", "b"), B("bulleted_list", "c"),
        B("numbered_list", "one"), B("numbered_list", "two"),
        B("to_do", "open", {"checked": False}), B("to_do", "done", {"checked": True}),
        B("to_do", "also done", {"checked": True}), B("to_do", "", {"checked": False}),
    ]


def test_nesting_by_four_or_two_spaces():
    four = roundtrip("- parent\n    - child\n        1. grandchild\n    - [x] task\n- next")
    assert four == [
        B("bulleted_list", "parent", children=[
            B("bulleted_list", "child", children=[B("numbered_list", "grandchild")]),
            B("to_do", "task", {"checked": True}),
        ]),
        B("bulleted_list", "next"),
    ]
    two = parse_markdown("- parent\n  - child\n    - grandchild\n- next")
    assert two == [
        B("bulleted_list", "parent", children=[B("bulleted_list", "child", children=[B("bulleted_list", "grandchild")])]),
        B("bulleted_list", "next"),
    ]


def test_list_item_soft_break_written_unindented():
    # Notion writes Shift+Enter inside an item as a bare next line.
    tree = roundtrip("2. Every month we meet.\nIn this session people gather.\n3. Next")
    assert tree == [
        B("numbered_list", "Every month we meet.\nIn this session people gather."),
        B("numbered_list", "Next"),
    ]


def test_empty_bullet_with_nested_images_and_whitespace_lines():
    md = "- Alle 2 Jahre mähen\n- \n    \n    ![Shot 1.png](Wiese/Shot_1.png)\n    \n    ![Shot 2.png](Wiese/Shot_2.png)"
    tree = roundtrip(md)
    assert tree == [
        B("bulleted_list", "Alle 2 Jahre mähen"),
        B("bulleted_list", "", children=[
            B("image", "Shot 1.png", {"url": "Wiese/Shot_1.png"}),
            B("image", "Shot 2.png", {"url": "Wiese/Shot_2.png"}),
        ]),
    ]


def test_list_item_with_paragraph_child():
    tree = roundtrip("- item\n\n    a paragraph under it\n- second")
    assert tree == [
        B("bulleted_list", "item", children=[B("paragraph", "a paragraph under it")]),
        B("bulleted_list", "second"),
    ]


def test_paren_numbers_are_not_a_list():
    assert parse_markdown("1) Pflügen\n2) Häufeln") == [B("paragraph", "1) Pflügen\n2) Häufeln")]


def test_quote_multiline_with_blank_line():
    tree = roundtrip("> “Quote”\n> \n> second **part**\n\nafter")
    assert tree == [B("quote", "“Quote”\n\nsecond **part**"), B("paragraph", "after")]


def test_fenced_code_keeps_source_exactly():
    md = "```python\ndef f():\n\treturn 1  \n# not a heading\n- not a list\n```\n\n```mermaid\ngraph TD\n```\n\n```\nplain\n```"
    tree = roundtrip(md)
    assert tree == [
        B("code", "def f():\n\treturn 1  \n# not a heading\n- not a list", {"language": "python"}),
        B("code", "graph TD", {"language": "mermaid"}),
        B("code", "plain", {"language": "plain"}),
    ]


def test_unclosed_fence_runs_to_the_end():
    assert parse_markdown("text\n\n```js\nlet a = 1\n\n# still code") == [
        B("paragraph", "text"), B("code", "let a = 1\n\n# still code", {"language": "js"}),
    ]


def test_code_containing_fences_round_trips():
    tree = [B("code", "```\ninner\n```", {"language": "markdown"})]
    assert parse_markdown(blocks_to_markdown(tree)) == tree


def test_dividers():
    assert [b.type for b in roundtrip("a\n\n---\n\n***\n\n___\n\n- - -")] == [
        "paragraph", "divider", "divider", "divider", "divider",
    ]


def test_pipe_table():
    md = "| Pillar | Papers | Nature |\n| --- | --- | --- |\n| **Instruments** | a \\| b | x<br>y |\n| short |"
    tree = roundtrip(md)
    assert tree == [B("table", "", {"rows": [
        ["Pillar", "Papers", "Nature"],
        ["**Instruments**", "a | b", "x\ny"],
        ["short", "", ""],
    ], "header_row": True})]


def test_single_cell_table_and_pipe_paragraph():
    assert parse_markdown("| **192.168.177.1** |\n| --- |")[0].props["rows"] == [["**192.168.177.1**"]]
    assert parse_markdown("| not a table") == [B("paragraph", "| not a table")]


def test_image_line_keeps_src_raw_even_with_parens():
    tree = roundtrip("![Bestellung (1).png](Project%20D%C3%A4cher/bestellung-6_(1).png)\n\ntext ![inline](x.png) here")
    assert tree == [
        B("image", "Bestellung (1).png", {"url": "Project%20D%C3%A4cher/bestellung-6_(1).png"}),
        B("paragraph", "text ![inline](x.png) here"),
    ]


def test_aside_becomes_callout_with_icon():
    md = "<aside>\n💡 Thank you for using it.\nSecond line with [link](https://x.org).\n\n</aside>\n\n<aside>\nPS: no icon here\n</aside>"
    tree = roundtrip(md)
    assert tree == [
        B("callout", "Thank you for using it.\nSecond line with [link](https://x.org).", {"icon": "💡"}),
        B("callout", "PS: no icon here"),
    ]


def test_aside_with_nested_blocks_and_same_line_form():
    tree = roundtrip("<aside>\n⚠️ Careful\n\n- one\n- two\n</aside>\n\n<aside>🐔 Hühner</aside>")
    assert tree == [
        B("callout", "Careful", {"icon": "⚠️"}, [B("bulleted_list", "one"), B("bulleted_list", "two")]),
        B("callout", "Hühner", {"icon": "🐔"}),
    ]


def test_details_becomes_toggle():
    md = "<details>\n<summary>More **info**</summary>\n\nHidden text\n\n- item\n\n</details>\n\n<details><summary>Short</summary>x</details>"
    tree = roundtrip(md)
    assert tree == [
        B("toggle", "More **info**", children=[B("paragraph", "Hidden text"), B("bulleted_list", "item")]),
        B("toggle", "Short", children=[B("paragraph", "x")]),
    ]


def test_nested_details():
    tree = roundtrip("<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ndeep\n\n</details>\n\n</details>")
    assert tree == [B("toggle", "Outer", children=[B("toggle", "Inner", children=[B("paragraph", "deep")])])]


def test_equations():
    tree = roundtrip("$$\nE = mc^2\n\\int x\n$$\n\n$$a^2+b^2=c^2$$\n\nInline $x$ stays.")
    assert tree == [
        B("equation", "E = mc^2\n\\int x"), B("equation", "a^2+b^2=c^2"), B("paragraph", "Inline $x$ stays."),
    ]


def test_html_leftovers_stay_text():
    md = '<div class="ui buttons"> <a href="x">y</a> </div>'
    assert roundtrip(md) == [B("paragraph", md)]


def test_crlf_input():
    assert parse_markdown("# T\r\n\r\n- a\r\n- b\r\n") == [B("heading_1", "T"), B("bulleted_list", "a"), B("bulleted_list", "b")]


# --- Links and icons ------------------------------------------------------------------


def test_find_links_balances_brackets_and_parens_and_skips_code():
    text = "See [[Archive] Hochebene](Hoch/x%20(1).md), `[not](a link)` and ![img](a.png)."
    links = list(find_links(text))
    assert [(link.text, link.target, link.image) for link in links] == [
        ("[Archive] Hochebene", "Hoch/x%20(1).md", False), ("img", "a.png", True),
    ]
    assert text[links[1].start:links[1].end] == "![img](a.png)"


def test_link_target_cut_short_by_notion():
    # The folder name lost its ")" to Notion's 50-character limit.
    text = "[KiZi.pdf](KiZi%20(brainstorming;%20Ma%C3%9Fe/KiZi.pdf)"
    [link] = find_links(text)
    assert link.target == "KiZi%20(brainstorming;%20Ma%C3%9Fe/KiZi.pdf"
    assert whole_link(text) is not None
    # With whitespace in it, an unbalanced "(" is prose, not a link.
    assert list(find_links("[a](b (c) d")) == []


def test_whole_link():
    assert whole_link("[Tasks](Tasks%20abc.md)").target == "Tasks%20abc.md"
    assert whole_link("[a](b) trailing") is None
    assert whole_link("plain") is None


@pytest.mark.parametrize("text,icon,rest", [
    ("💡 Idea", "💡", "Idea"),
    ("⚠️ Warn", "⚠️", "Warn"),
    ("👩‍💻 Dev", "👩‍💻", "Dev"),
    ("🇩🇪 Flag", "🇩🇪", "Flag"),
    ("👍🏽 ok", "👍🏽", "ok"),
    ("PS: none", None, "PS: none"),
    ("", None, ""),
])
def test_split_icon(text, icon, rest):
    assert split_icon(text) == (icon, rest)


# --- Writing ---------------------------------------------------------------------------


def test_blocks_to_markdown_layout():
    tree = [
        B("heading_1", "Title"),
        B("bulleted_list", "a", children=[B("bulleted_list", "a1"), B("numbered_list", "n1"), B("numbered_list", "n2")]),
        B("to_do", "t", {"checked": True}),
        B("paragraph", "para"),
        B("callout", "Note", {"icon": "🐔"}),
        B("toggle", "More", children=[B("paragraph", "inside")]),
        B("table", "", {"rows": [["a", "b|c"], ["1", "2"]], "header_row": True}),
        B("image", "Caption", {"file_id": "f1", "name": "x.png"}),
        B("file", "", {"file_id": "f2", "name": "doc.pdf"}),
        B("page", "", {"page_id": "p1"}),
        B("database", "", {"page_id": "d1"}),
        B("code", "x = 1", {"language": "plain"}),
        B("divider"),
        B("equation", "x^2"),
    ]
    titles = {"p1": "Child page", "d1": "Tasks"}.get
    assert blocks_to_markdown(tree, titles) == (
        "# Title\n\n"
        "- a\n    - a1\n    1. n1\n    2. n2\n"
        "- [x] t\n\n"
        "para\n\n"
        "<aside>\n🐔 Note\n</aside>\n\n"
        "<details>\n<summary>More</summary>\n\ninside\n\n</details>\n\n"
        "| a | b\\|c |\n| --- | --- |\n| 1 | 2 |\n\n"
        "![Caption](/api/files/f1)\n\n"
        "[doc.pdf](/api/files/f2)\n\n"
        "[Child page](/p/p1)\n\n"
        "[Tasks](/p/d1)\n\n"
        "```\nx = 1\n```\n\n"
        "---\n\n"
        "$$\nx^2\n$$\n"
    )


def test_everything_round_trips_together():
    md = """# Page

Intro with **bold** and a [link](/p/abc).

- one
    - [ ]  nested todo
        1. deep
- two
continued

> quote

<aside>
🔥 Hot
</aside>

<details>
<summary>Toggle</summary>

- inside

</details>

| h1 | h2 |
| --- | --- |
| c1 | c2 |

![](https://example.com/a.png)

```sh
echo hi
```

$$
x
$$

---
"""
    tree = roundtrip(md)
    assert [b.type for b in tree] == [
        "heading_1", "paragraph", "bulleted_list", "bulleted_list", "quote", "callout", "toggle",
        "table", "image", "code", "equation", "divider",
    ]
    assert tree[3].text == "two\ncontinued"


def test_empty_input():
    assert parse_markdown("") == []
    assert blocks_to_markdown([]) == ""


@pytest.mark.parametrize("prop,value,text", [
    ({"type": "checkbox"}, True, "Yes"),
    ({"type": "checkbox"}, False, "No"),
    ({"type": "number"}, 2.0, "2"),
    ({"type": "number"}, 2.5, "2.5"),
    ({"type": "multi_select"}, ["a", "b"], "a, b"),
    ({"type": "date"}, {"start": "2022-10-24", "end": "2022-10-26"}, "2022-10-24 → 2022-10-26"),
    ({"type": "files"}, [{"file_id": "f", "name": "x.pdf"}], "[x.pdf](/api/files/f)"),
    ({"type": "text"}, None, ""),
])
def test_value_to_text(prop, value, text):
    assert value_to_text(prop, value) == text
