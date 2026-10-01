#!/usr/bin/env python3
"""Build the data behind meerpad's icon picker: Tabler Icons and every emoji.

    python3 tools/build_icons.py        # standard library only; needs the network

Downloads two pinned npm packages and writes, into app/static/vendor:

  tabler/icons.json   {"version", "icons": {name: inner SVG markup}}
                      What the app and the published sites draw an
                      "icon:<name>" page icon from (docs/DESIGN.md §1).
  tabler/index.json   {"version", "categories": [[name, [icon, ...]], ...],
                       "tags": {icon: "space separated words"}}
                      The picker's sections and search words; only it loads this.
  tabler/LICENSE
  emoji/emoji.json    {"version", "groups": [[name, [[emoji, label, tags,
                       version, skins?], ...]], ...]}
                      skins, when the emoji has them: its five skin tone
                      variants, light to dark.
  emoji/LICENSE

To update, change the versions below, run this, and look at the picker.
Renamed or removed Tabler icons stop drawing on pages that use them.
"""

import io
import json
import tarfile
import urllib.request
from pathlib import Path

TABLER_VERSION = "3.48.0"
EMOJIBASE_VERSION = "17.0.0"

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "app" / "static" / "vendor"

# emojibase's group numbers; 2 ("component": skin tones and hair styles on
# their own) is not something to pick.
EMOJI_GROUPS = {
    0: "Smileys & emotion",
    1: "People & body",
    3: "Animals & nature",
    4: "Food & drink",
    5: "Travel & places",
    6: "Activities",
    7: "Objects",
    8: "Symbols",
    9: "Flags",
}


def npm_package(name: str, version: str) -> tarfile.TarFile:
    base = name.rsplit("/", 1)[-1]
    url = f"https://registry.npmjs.org/{name}/-/{base}-{version}.tgz"
    with urllib.request.urlopen(url, timeout=60) as resp:
        return tarfile.open(fileobj=io.BytesIO(resp.read()), mode="r:gz")


def member(tar: tarfile.TarFile, path: str) -> bytes:
    return tar.extractfile(f"package/{path}").read()


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(f"{path.relative_to(ROOT)}  {len(data) // 1024} KB")


def write_json(path: Path, obj) -> None:
    write(path, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode())


def tabler() -> None:
    tar = npm_package("@tabler/icons", TABLER_VERSION)
    nodes = json.loads(member(tar, "tabler-nodes-outline.json"))
    meta = json.loads(member(tar, "icons.json"))

    def markup(children) -> str:
        out = []
        for tag, attrs in children:
            a = " ".join(f'{k}="{v}"' for k, v in attrs.items() if k != "key")
            out.append(f"<{tag} {a}/>")
        return "".join(out)

    icons = {name: markup(nodes[name]) for name in sorted(nodes)}
    write_json(VENDOR / "tabler" / "icons.json", {"version": TABLER_VERSION, "icons": icons})

    by_cat: dict[str, list[str]] = {}
    tags: dict[str, str] = {}
    for name in icons:
        m = meta.get(name) or {}
        by_cat.setdefault(m.get("category") or "Other", []).append(name)
        words = set(name.split("-"))
        extra = []
        for t in m.get("tags") or []:
            t = str(t).strip().lower()
            if t and t not in words and t not in extra:
                extra.append(t)
        if extra:
            tags[name] = " ".join(extra)
    # Alphabetical, but the long runs of near-alike glyphs (arrows, letters,
    # digits, logos) after the pictures people look for.
    late = ["Arrows", "Letters", "Numbers", "Extensions", "Brand", "Other"]
    cats = sorted(by_cat.items(), key=lambda kv: (late.index(kv[0]) if kv[0] in late else -1, kv[0]))
    write_json(VENDOR / "tabler" / "index.json", {"version": TABLER_VERSION, "categories": cats, "tags": tags})
    write(VENDOR / "tabler" / "LICENSE", member(tar, "LICENSE"))


def emoji() -> None:
    tar = npm_package("emojibase-data", EMOJIBASE_VERSION)
    data = json.loads(member(tar, "en/data.json"))

    def uniform_skins(e) -> list[str] | None:
        out = {}
        for s in e.get("skins") or []:
            tone = s.get("tone")
            tones = tone if isinstance(tone, list) else [tone]
            if len(set(tones)) == 1 and tones[0] in range(1, 6):
                out.setdefault(tones[0], s["emoji"])
        return [out[t] for t in range(1, 6)] if len(out) == 5 else None

    groups: dict[int, list] = {g: [] for g in EMOJI_GROUPS}
    for e in sorted(data, key=lambda e: e.get("order", 1 << 30)):
        g = e.get("group")
        if g not in groups:
            continue
        label = e["label"]
        words = set(label.lower().replace(":", " ").split())
        tags = " ".join(t for t in e.get("tags") or [] if t.lower() not in words)
        item = [e["emoji"], label, tags, e.get("version", 0)]
        skins = uniform_skins(e)
        if skins:
            item.append(skins)
        groups[g].append(item)
    out = [[EMOJI_GROUPS[g], items] for g, items in groups.items()]
    write_json(VENDOR / "emoji" / "emoji.json", {"version": EMOJIBASE_VERSION, "groups": out})
    notice = (f"Emoji names and keywords: emojibase-data {EMOJIBASE_VERSION}, https://emojibase.dev\n"
              "(from Unicode CLDR, Unicode License v3).\n\n").encode()
    write(VENDOR / "emoji" / "LICENSE", notice + member(tar, "LICENSE"))


def main() -> None:
    tabler()
    emoji()


if __name__ == "__main__":
    main()
