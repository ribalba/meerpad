"""Page history diffs (app/history.py), on plain snapshots: no database."""

from app.history import diff, is_empty, ordered, segments


def snap(blocks, **page) -> dict:
    return {"page": {"title": "", "kind": "page", "props": {}, "options": {}, **page}, "blocks": ordered(blocks)}


def blk(id, text="", parent=None, pos=1.0, type="paragraph", **props) -> dict:
    return {"id": id, "parent_id": parent, "type": type, "text": text, "props": props, "position": pos}


def test_ordered_is_document_order_with_depth_and_drops_orphans():
    out = ordered([
        blk("b", pos=2), blk("a", pos=1), blk("a2", parent="a", pos=2), blk("a1", parent="a", pos=1),
        blk("lost", parent="nowhere"),
    ])
    assert [(b["id"], b["depth"]) for b in out] == [("a", 0), ("a1", 1), ("a2", 1), ("b", 0)]


def test_segments_are_word_level_and_join_rewritten_phrases():
    assert segments("the quick brown fox", "the quick brown fox") == [{"op": "same", "text": "the quick brown fox"}]
    assert segments("the quick brown fox", "the slow red fox") == [
        {"op": "same", "text": "the "},
        {"op": "removed", "text": "quick brown"},
        {"op": "added", "text": "slow red"},
        {"op": "same", "text": " fox"},
    ]
    assert segments("", "neu") == [{"op": "added", "text": "neu"}]
    assert segments("alt", "") == [{"op": "removed", "text": "alt"}]


def test_added_removed_changed_and_removed_blocks_stay_in_place():
    old = snap([blk("a", "one", pos=1), blk("b", "two", pos=2), blk("c", "three", pos=3)])
    new = snap([blk("a", "one", pos=1), blk("c", "three!", pos=3), blk("d", "four", pos=4)])
    d = diff(old, new)
    assert [(e["id"], e["status"]) for e in d["blocks"]] == [
        ("a", "same"), ("b", "removed"), ("c", "changed"), ("d", "added"),
    ]
    c = d["blocks"][2]
    assert c["old"] == {"type": "paragraph", "text": "three", "props": {}}
    assert c["segments"][-1] == {"op": "added", "text": "!"}
    assert d["stats"] == {"added": 1, "removed": 1, "changed": 1, "moved": 0, "page": 0}


def test_moves_count_once_and_not_for_children_travelling_along():
    old = snap([blk("a", pos=1), blk("b", pos=2), blk("b1", parent="b"), blk("c", pos=3)])
    # b (with its child) moves to the top; c is indented under a.
    new = snap([blk("b", pos=0), blk("b1", parent="b"), blk("a", pos=1), blk("c", parent="a")])
    moved = {e["id"] for e in diff(old, new)["blocks"] if e["moved"]}
    assert "b1" not in moved and "c" in moved
    assert len(moved & {"a", "b"}) == 1  # one of the two swapped places
    assert all(e["status"] == "same" for e in diff(old, new)["blocks"])


def test_renumbered_positions_and_empty_values_are_no_change():
    old = snap([blk("a", pos=1e-7), blk("b", pos=2e-7, type="to_do")], props={"p_x": ""})
    new = snap([blk("a", pos=1), blk("b", pos=2, type="to_do", checked=False)], options={"full_width": False})
    assert is_empty(diff(old, new))


def test_page_fields_props_schema_and_options():
    schema_old = {"properties": [{"id": "title", "name": "Name", "type": "title"},
                                 {"id": "p_s", "name": "Status", "type": "status"},
                                 {"id": "p_gone", "name": "Old", "type": "text"}],
                  "views": [{"id": "v1", "name": "Table", "type": "table"}]}
    schema_new = {"properties": [{"id": "title", "name": "Name", "type": "title"},
                                 {"id": "p_s", "name": "State", "type": "status"},
                                 {"id": "p_new", "name": "Owner", "type": "person"}],
                  "views": [{"id": "v1", "name": "Table", "type": "table", "hidden": ["p_s"]}]}
    old = snap([], title="Hühner", icon="🐔", props={"p_s": "Todo"}, schema=schema_old, kind="database")
    new = snap([], title="Enten", icon="🦆", cover="gradient:2", props={"p_s": "Done", "p_n": 3},
               schema=schema_new, kind="database", options={"font": "serif"})
    page = {c["field"]: c for c in diff(old, new)["page"]}
    assert page["title"]["from"] == "Hühner" and page["title"]["to"] == "Enten"
    assert page["icon"] == {"field": "icon", "from": "🐔", "to": "🦆"}
    assert page["cover"] == {"field": "cover", "from": None, "to": "gradient:2"}
    assert "kind" not in page
    assert page["props"]["changes"] == [{"key": "p_s", "from": "Todo", "to": "Done"},
                                        {"key": "p_n", "from": None, "to": 3}]
    assert {(c["kind"], c["change"], c["name"]) for c in page["schema"]["changes"]} == {
        ("property", "renamed", "State"), ("property", "added", "Owner"), ("property", "removed", "Old"),
        ("view", "changed", "Table"),
    }
    assert page["options"]["changes"] == [{"key": "font", "from": None, "to": "serif"}]


def test_against_nothing_is_an_empty_page_of_the_same_kind():
    new = snap([blk("a", "hi")], title="Tasks", kind="database")
    d = diff(None, new)
    assert [c["field"] for c in d["page"]] == ["title"]
    assert [(e["id"], e["status"]) for e in d["blocks"]] == [("a", "added")]
