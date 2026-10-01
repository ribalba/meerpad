"""Notion import: a "Markdown & CSV" export becomes a meerpad page tree.

The export format (what Notion writes, and what this reads):

* A page is ``Title <32 hex>.md``. Its first line is ``# Title`` (the real
  title; file names are sanitised and cut at about 50 characters), and its
  subpages and attachments sit in the sibling folder ``Title/`` (the file name
  without the id).
* A database is ``Title <id>.csv`` and/or ``Title <id>_all.csv`` (``_all`` has
  every row, not just the default view's), usually with a ``Title <id>.md``
  whose body is only a link to the CSV plus the view's filter and sort. Its row
  pages are the ``.md`` files in ``Title/``; each starts with ``# Title`` and
  then ``Key: value`` lines for the columns.
* Images and files are relative links, percent-encoded. Links to other pages
  are relative links to their ``.md`` (or to a database's ``.csv``).
* A big export is a zip of zips ("Export-x.zip" holding "Export-x-Part-1.zip").

How the import runs:

1. Unpack (nested zips included) into a temp folder under IMPORT_DIR, or read
   an already extracted folder in place. Nothing is written into the source.
2. Scan the tree into nodes (pages, databases, rows) and give every node its
   meerpad id up front, so a link can point at a page that is imported later.
3. Walk the tree parents first. Each page is parsed with app/mdblocks.py, its
   links are rewritten (``/p/<id>`` for pages, ``/api/files/<id>/<name>`` for
   attachments, which are uploaded through app/storage.py, a HEIC photo
   becoming a WebP one on the way), and it is written with its blocks.

It commits after every page (and every few hundred database rows), because
every write to pages and blocks takes the global revision counter's row lock
until commit (app/database.py): one transaction for a whole workspace would
stall every other user's sync for minutes. Each page's content also sits in a
savepoint, so a page that fails to import becomes a warning and an empty page,
never an aborted import.
"""

import csv
import hashlib
import logging
import os
import re
import secrets
import shutil
import tempfile
import unicodedata
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import InterfaceError, OperationalError

from .config import get_settings
from .database import SessionLocal
from .mdblocks import (
    INLINE_TYPES,
    BlockNode,
    Link,
    find_links,
    parse_markdown,
    whole_link,
)
from .models import Block, Page, User, Workspace
from .security import new_id
from .storage import create_file, path_for

settings = get_settings()
log = logging.getLogger(__name__)

Progress = Callable[[dict], None]

ID_RE = re.compile(r"^(?:(?P<stem>.*?)\s+)?(?P<id>[0-9a-f]{32})(?P<all>_all)?$")
HEX_ID_RE = re.compile(r"([0-9a-f]{32})(?:_all)?(?:\.(?:md|csv))?$")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
# Looks like a property line ("Key: value"), whether or not Key is a column.
KV_LINE_RE = re.compile(r"^[^\s:][^:\n]{0,60}:\s")
URL_IN_TEXT_RE = re.compile(r"(?:https?://|mailto:)(?:www\.)?([^\s/?#]+)\S*")

# Browsers render these in an <img>; any other attachment (TIFF included,
# which Notion showed as an image) becomes a file block to download. HEIC is
# stored as WebP (app/images.py), so it is an image by the time this is asked.
WEB_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"}
COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]

MAX_WARNINGS = 1000
# The database itself went away: no point carrying on page by page.
DB_GONE = (OperationalError, InterfaceError)
ROW_BATCH = 200  # database rows per commit


class ImportFailed(ValueError):
    """The export cannot be imported at all (as opposed to one page failing)."""


# --- Paths -------------------------------------------------------------------------


def _key(path) -> str:
    """Lookup key for a path: normalised, NFC (a zip made on a Mac stores
    decomposed umlauts while the links in the Markdown use composed ones)."""
    return unicodedata.normalize("NFC", os.path.normpath(str(path)))


def _norm_title(s: str) -> str:
    """Titles as Notion's file names keep them: casefolded letters and digits
    only (it drops ``/ . : ?`` and friends from names)."""
    s = unicodedata.normalize("NFKC", s or "").casefold()
    return "".join(ch for ch in s if ch.isalnum())


def _split_name(name: str) -> tuple[str, str | None, bool]:
    """``"Title 0123…ef_all.csv"`` -> ("Title", "0123…ef", True)."""
    base = name.rsplit(".", 1)[0]
    m = ID_RE.match(base)
    if m:
        return (m.group("stem") or "").strip(), m.group("id"), bool(m.group("all"))
    return base.strip(), None, False


# --- Unpacking ------------------------------------------------------------------------


def _zip_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if not info.flag_bits & 0x800:
        # No UTF-8 flag: zipfile decoded the name as cp437. Most tools wrote
        # UTF-8 anyway, so try to undo that.
        try:
            name = name.encode("cp437").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return unicodedata.normalize("NFC", name.replace("\\", "/"))


def _extract(zip_path: Path, dest: Path, budget: list[int], warnings: list[str]) -> None:
    """Unpack one zip into ``dest``. Refuses paths that climb out of it and
    stops once ``budget[0]`` bytes (uncompressed) are spent: a zip bomb must
    not fill the disk."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise ImportFailed(f"{zip_path.name} is not a valid zip file") from exc
    with zf:
        for info in zf.infolist():
            parts = [p for p in _zip_name(info).split("/") if p not in ("", ".")]
            if not parts or ".." in parts or parts[0] == "__MACOSX":
                continue
            target = dest.joinpath(*parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            budget[0] -= info.file_size
            if budget[0] < 0:
                raise ImportFailed("The export is too large to import")
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out, 1024 * 1024)
            except OSError as exc:  # a name too long for the disk, a file where a folder is
                warnings.append(f"{'/'.join(parts)}: not unpacked ({exc.strerror or exc})")


def _top_entries(root: Path) -> list[Path]:
    return [e for e in root.iterdir() if not e.name.startswith(".") and e.name != "__MACOSX"]


def _find_root(root: Path) -> Path:
    """Step into a lone wrapper folder ("Export-x/"): the export itself starts
    where the pages are."""
    for _ in range(5):
        entries = _top_entries(root)
        if len(entries) == 1 and entries[0].is_dir():
            root = entries[0]
        else:
            break
    return root


def _prepare(source: Path, work: Path, warnings: list[str]) -> Path:
    """The folder to import from: ``source`` itself, or its unpacked copy in
    ``work``. Zips at the top of the export are Notion's parts and unpacked
    too; a zip deeper down is an attachment and stays one."""
    budget = [settings.max_import_bytes * 2]
    if source.is_dir():
        root = _find_root(source)
        zips = [e for e in _top_entries(root) if e.suffix.lower() == ".zip"]
        if not zips or any(e.suffix.lower() in (".md", ".csv") for e in _top_entries(root)):
            return root
        for z in zips:
            _extract(z, work, budget, warnings)
    else:
        _extract(source, work, budget, warnings)
    root = work
    for _ in range(3):
        root = _find_root(root)
        inner = sorted(e for e in _top_entries(root) if e.is_file() and e.suffix.lower() == ".zip")
        if not inner or any(e.suffix.lower() in (".md", ".csv") for e in _top_entries(root)):
            break
        for z in inner:
            _extract(z, root, budget, warnings)
            z.unlink()
    return _find_root(root)


# --- Scanning -----------------------------------------------------------------------


@dataclass(eq=False)
class _Node:
    kind: str                       # "page" | "database"
    title: str
    dir: Path                       # the folder its .md/.csv sits in
    stem: str                       # Notion's file-name title
    notion_id: str | None = None
    md: Path | None = None
    csv: Path | None = None
    id: str = field(default_factory=new_id)
    parent: "_Node | None" = None
    children: list["_Node"] = field(default_factory=list)
    row: bool = False
    # Filled for rows while their database is imported.
    kv: dict = field(default_factory=dict)
    body: str | None = None
    props: dict = field(default_factory=dict)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _md_title(text: str) -> str | None:
    for line in text.split("\n"):
        if line.strip():
            return line[2:].strip() if line.startswith("# ") else None
    return None


class _Export:
    """The scanned export: its nodes, and indexes to resolve links against."""

    def __init__(self, root: Path):
        self.root = root
        self.nodes: list[_Node] = []
        self.by_path: dict[str, _Node] = {}           # .md / .csv path -> node
        self.by_notion_id: dict[str, _Node] = {}
        self.files: dict[str, Path] = {}              # attachments by path
        self.by_tail: dict[str, list[Path]] = {}      # "folder/name" -> attachments
        self.by_name: dict[str, list[Path]] = {}      # "name" -> attachments
        self.stems: dict[tuple[str, str], list[_Node]] = {}
        self.folder_nodes: dict[str, _Node] = {}
        self._links: dict[int, set[str]] = {}
        self.warnings: list[str] = []
        self._scan()

    def rel(self, path: Path | None) -> str:
        if path is None:
            return "?"
        try:
            return str(path.relative_to(self.root))
        except ValueError:
            return str(path)

    # Scanning ------------------------------------------------------------

    def _scan(self) -> None:
        mds: list[Path] = []
        dbs: dict[tuple[str, str], dict] = {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d != "__MACOSX")
            here = Path(dirpath)
            for name in sorted(filenames):
                if name.startswith("."):
                    continue
                path = here / name
                low = name.lower()
                stem, nid, is_all = _split_name(name)
                if low.endswith(".md"):
                    mds.append(path)
                elif low.endswith(".csv") and nid:
                    slot = dbs.setdefault((_key(here), nid), {"dir": here, "stem": stem, "csv": None, "all": False})
                    # Prefer _all.csv: the plain one only has the default view's rows.
                    if slot["csv"] is None or (is_all and not slot["all"]):
                        slot["csv"], slot["all"] = path, is_all
                else:
                    self.files[_key(path)] = path
                    self.by_tail.setdefault(_key(Path(here.name) / name), []).append(path)
                    self.by_name.setdefault(unicodedata.normalize("NFC", name), []).append(path)

        for (dkey, nid), slot in dbs.items():
            node = _Node("database", slot["stem"], slot["dir"], slot["stem"], nid, csv=slot["csv"])
            self._add(node)
            for variant in (f"{slot['stem']} {nid}.csv", f"{slot['stem']} {nid}_all.csv"):
                self.by_path[_key(slot["dir"] / variant)] = node

        for path in mds:
            stem, nid, _ = _split_name(path.name)
            try:
                title = _md_title(_read(path))
            except OSError as exc:
                self.warnings.append(f"{self.rel(path)}: unreadable ({exc.strerror or exc})")
                title = None
            db = self.by_notion_id.get(nid) if nid else None
            if db is not None and db.kind == "database" and db.dir == path.parent:
                db.md = path
                db.title = title or db.title
                self.by_path[_key(path)] = db
                continue
            node = _Node("page", title or stem, path.parent, stem, nid, md=path)
            self._add(node)
            self.by_path[_key(path)] = node

        for node in list(self.nodes):
            node.parent = self._parent_of(node.md or node.csv)
        for node in self.nodes:
            if node.parent is not None and node.parent.kind == "database":
                if node.kind == "database":
                    # Not a row: a database cannot sit in another one. Keep it
                    # beside its container instead.
                    node.parent = node.parent.parent
                else:
                    node.row = True
            if node.parent is not None:
                node.parent.children.append(node)

    def _add(self, node: _Node) -> None:
        self.nodes.append(node)
        if node.notion_id:
            self.by_notion_id.setdefault(node.notion_id, node)
        self.stems.setdefault((_key(node.dir), node.stem), []).append(node)

    def _parent_of(self, path: Path) -> _Node | None:
        """The node owning the folder ``path`` sits in (None at the top)."""
        folder = path.parent
        if _key(folder) == _key(self.root):
            return None
        cands = self.stems.get((_key(folder.parent), folder.name.strip()))
        if cands:
            return self._pick(cands, path)
        return self._folder_node(folder)

    def _folder_node(self, folder: Path) -> _Node:
        """A folder with pages in it but no page of its own (its .md is missing):
        it becomes a page named after the folder."""
        k = _key(folder)
        if k not in self.folder_nodes:
            node = _Node("page", folder.name, folder.parent, folder.name.strip())
            self.folder_nodes[k] = node
            self.nodes.append(node)
            self.stems.setdefault((_key(folder.parent), node.stem), []).append(node)
            node.parent = self._parent_of(folder)
        return self.folder_nodes[k]

    def _pick(self, cands: list[_Node], path: Path) -> _Node:
        """Several pages share a folder name (two "Untitled" siblings): the one
        whose Markdown links to ``path`` owns it; else a database (its rows are
        never linked); else the first."""
        if len(cands) == 1:
            return cands[0]
        target = _key(path)
        for c in cands:
            links = self._links_of(c)
            if target in links or any(k.startswith(target + os.sep) for k in links):
                return c
        dbs = [c for c in cands if c.kind == "database"]
        return dbs[0] if dbs else cands[0]

    def _links_of(self, node: _Node) -> set[str]:
        if id(node) not in self._links:
            keys = set()
            if node.md is not None:
                try:
                    text = _read(node.md)
                except OSError:
                    text = ""
                for link in find_links(text):
                    rel = _local_target(link.target)
                    if rel is not None:
                        keys.add(_key(node.md.parent / rel))
            self._links[id(node)] = keys
        return self._links[id(node)]

    # Resolving -------------------------------------------------------------

    def resolve(self, target: str, base: Path) -> tuple[str, object]:
        """What a link target points at: ("node", _Node), ("file", Path),
        ("missing", rel) or ("external", target)."""
        target = target.strip()
        if target.startswith("<") and target.endswith(">"):
            target = target[1:-1]
        rel = _local_target(target)
        if rel is None:
            nid = _notion_url_id(target)
            if nid and nid in self.by_notion_id:
                return "node", self.by_notion_id[nid]
            return "external", target
        k = _key(base / rel)
        if k in self.by_path:
            return "node", self.by_path[k]
        if k in self.files:
            return "file", self.files[k]
        # The right id under a different file name (a link to the plain .csv
        # when only the _all one was exported). A .csv must be a database: a
        # page's .md shares its id with the CSV of the database it once was.
        m = HEX_ID_RE.search(rel)
        node = self.by_notion_id.get(m.group(1)) if m else None
        low = rel.lower()
        if node is not None and (low.endswith(".md") or (low.endswith(".csv") and node.kind == "database")):
            return "node", node
        # Notion writes some paths relative to the wrong folder (file columns in
        # a CSV are one level off). The last two parts are specific enough.
        parts = Path(rel).parts
        if len(parts) >= 2:
            hits = self.by_tail.get(_key(Path(parts[-2]) / parts[-1]), [])
            if len(hits) >= 1:
                return "file", hits[0]
        if parts:
            hits = self.by_name.get(unicodedata.normalize("NFC", parts[-1]), [])
            if len(hits) == 1:
                return "file", hits[0]
        return "missing", rel


def _local_target(target: str) -> str | None:
    """The decoded relative path of a link into the export, or None for a URL,
    an anchor or an absolute path."""
    if not target or SCHEME_RE.match(target) or target.startswith(("#", "/", "//")):
        return None
    raw = target.split("#", 1)[0].split("?", 1)[0]
    if not raw:
        return None
    return unquote(raw)


def _notion_url_id(url: str) -> str | None:
    """The page id in a notion.so link (``…/Title-<32 hex>?pvs=21``)."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if not (host == "notion.so" or host.endswith((".notion.so", ".notion.site"))):
        return None
    m = re.search(r"([0-9a-f]{32})$", parts.path.replace("-", "")[-40:])
    return m.group(1) if m else None


# --- Database values -------------------------------------------------------------------

MONTHS = {
    m: i + 1 for i, m in enumerate(
        ["january", "february", "march", "april", "may", "june", "july", "august",
         "september", "october", "november", "december"]
    )
}
DATE_WORDS_RE = re.compile(
    r"^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$"
)
DATE_ISO_RE = re.compile(
    r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$"
)
DATE_SLASH_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$")
TZ_SUFFIX_RE = re.compile(r"\s*\((?:GMT|UTC)[^)]*\)\s*$")
NUMBER_RE = re.compile(r"^([€$£¥]\s?)?(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(\s?[€$£¥])?$")
EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")
URL_RE = re.compile(r"^https?://\S+$")
CURRENCY = {"€": "euro", "$": "dollar", "£": "pound", "¥": "yen"}
SELECT_HINTS = ("status", "priority", "prio", "type", "typ", "art", "kategorie", "category", "stage",
                "phase", "tag", "tags", "label", "labels")
MULTI_HINTS = ("tag", "tags", "label", "labels", "kategorien", "categories", "assign", "people", "person")


def _hm(hour: str | None, minute: str | None, ampm: str | None) -> tuple[int, int] | None:
    if hour is None:
        return None
    h, m = int(hour), int(minute)
    if ampm:
        h = h % 12 + (12 if ampm.lower() == "pm" else 0)
    if h > 23 or m > 59:
        raise ValueError("time")
    return h, m


def _fmt_date(y: int, mo: int, d: int, hm: tuple[int, int] | None) -> str:
    date(y, mo, d)  # validates (raises ValueError on 2022-02-30)
    out = f"{y:04d}-{mo:02d}-{d:02d}"
    return out + (f"T{hm[0]:02d}:{hm[1]:02d}" if hm else "")


def _parse_date(value: str, day_first: bool = True) -> str | None:
    """One Notion date as ISO: "October 24, 2022 9:58 PM", "2022/10/24",
    "24/10/2022", ISO, with an optional leading "@" (a date mention) and a
    trailing "(GMT+2)"."""
    s = TZ_SUFFIX_RE.sub("", value.strip().lstrip("@").strip())
    try:
        m = DATE_WORDS_RE.match(s)
        if m and m.group(1).lower() in MONTHS:
            return _fmt_date(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2)),
                             _hm(m.group(4), m.group(5), m.group(6)))
        m = DATE_ISO_RE.match(s)
        if m:
            return _fmt_date(int(m.group(1)), int(m.group(2)), int(m.group(3)), _hm(m.group(4), m.group(5), None))
        m = DATE_SLASH_RE.match(s)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            d, mo = (a, b) if day_first else (b, a)
            return _fmt_date(int(m.group(3)), mo, d, _hm(m.group(4), m.group(5), m.group(6)))
    except ValueError:
        return None
    return None


def _date_value(value: str, day_first: bool):
    """A date or a Notion range ("A → B") as DESIGN §4 stores it."""
    if "→" in value:
        start, _, end = value.partition("→")
        a, b = _parse_date(start, day_first), _parse_date(end, day_first)
        if a and b:
            return {"start": a, "end": b}
        return None
    return _parse_date(value, day_first)


def _day_first(values: list[str]) -> bool:
    """Slash dates are ambiguous (08/03/2025). A column is read one way only:
    day first unless some value proves the month comes first."""
    for v in values:
        m = DATE_SLASH_RE.match(TZ_SUFFIX_RE.sub("", v.strip().lstrip("@").strip()))
        if m and int(m.group(1)) > 12:
            return True
        if m and int(m.group(2)) > 12:
            return False
    return True


def _number(value: str) -> tuple[float | int, str | None] | None:
    m = NUMBER_RE.match(value.strip())
    if not m:
        return None
    digits = m.group(2).replace(",", "")
    if re.match(r"^-?0\d", digits):
        return None  # a phone number or an id, not a quantity
    cur = (m.group(1) or m.group(3) or "").strip()
    num = float(digits) if "." in digits else int(digits)
    return num, CURRENCY.get(cur)


def _split_multi(value: str) -> list[str]:
    return [t.strip() for t in value.split(",") if t.strip()]


def _hinted(name: str, hints: tuple[str, ...]) -> bool:
    words = re.findall(r"[a-zäöü]+", name.casefold())
    return any(w in hints for w in words)


def _options(names: list[str]) -> list[dict]:
    return [{"id": secrets.token_hex(4), "name": n, "color": COLORS[i % len(COLORS)]} for i, n in enumerate(names)]


def _infer(name: str, values: list[str], is_file: Callable[[str], bool]) -> dict:
    """A property definition from a column's values (DESIGN §4 types)."""
    vals = [v.strip() for v in values if v and v.strip()]
    prop: dict = {"name": name, "type": "text"}
    if not vals:
        return prop
    if all(v in ("Yes", "No") for v in vals):
        prop["type"] = "checkbox"
        return prop
    day_first = _day_first(vals)
    if all(_date_value(v, day_first) is not None for v in vals):
        prop["type"] = "date"
        prop["_day_first"] = day_first
        return prop
    nums = [_number(v) for v in vals]
    if all(n is not None for n in nums):
        prop["type"] = "number"
        formats = {n[1] for n in nums}
        if len(formats) == 1 and None not in formats:
            prop["number_format"] = formats.pop()
        return prop
    if all(URL_RE.match(v) for v in vals):
        prop["type"] = "url"
        return prop
    if all(EMAIL_RE.match(v) for v in vals):
        prop["type"] = "email"
        return prop
    if all(all(is_file(p) for p in _split_multi(v)) for v in vals):
        prop["type"] = "files"
        return prop
    single_line = all("\n" not in v and len(v) <= 80 for v in vals)
    if single_line and any("," in v for v in vals):
        tokens = [t for v in vals for t in _split_multi(v)]
        vocab = list(dict.fromkeys(tokens))
        counts = {t: tokens.count(t) for t in vocab}
        repeated = sum(1 for t in vocab if counts[t] > 1)
        if (len(vocab) <= 40 and all(len(t) <= 50 for t in vocab)
                and (repeated * 2 >= len(vocab) or _hinted(name, MULTI_HINTS))):
            prop["type"] = "multi_select"
            prop["options"] = _options(vocab)
            return prop
    distinct = list(dict.fromkeys(vals))
    if single_line and len(distinct) <= 12 and (len(distinct) < len(vals) or _hinted(name, SELECT_HINTS)):
        prop["type"] = "select"
        prop["options"] = _options(distinct)
    return prop


# --- The importer -------------------------------------------------------------------------


class _Importer:
    def __init__(self, user: User, workspace_id: str, parent_page_id: str, export: _Export,
                 progress: Progress | None):
        self.user_id = user.id
        self.actor = user.email
        self.workspace_id = workspace_id
        self.parent_page_id = parent_page_id
        self.ex = export
        self.progress = progress
        self.db = SessionLocal()
        self.stats = {"pages": 0, "databases": 0, "rows": 0, "blocks": 0, "files": 0,
                      "warnings": list(export.warnings)}
        self.dropped_warnings = 0
        self.done = 0
        self.total = len(export.nodes)
        self.uploads: dict[tuple[str, str], dict] = {}    # (path key, page id) -> file info
        self.by_sha: dict[tuple[str, str], dict] = {}     # (sha256, page id) -> file info
        self._page_files: list[tuple[str, str]] = []      # (file id, stored name) in the open savepoint
        self.pending = 0

    # Bookkeeping ---------------------------------------------------------

    def warn(self, msg: str) -> None:
        if len(self.stats["warnings"]) < MAX_WARNINGS:
            self.stats["warnings"].append(msg)
        else:
            self.dropped_warnings += 1

    def report(self, phase: str = "importing") -> None:
        if self.progress is not None:
            self.progress({"phase": phase, "done": self.done, "total": self.total, **self.result()})

    def result(self) -> dict:
        out = dict(self.stats)
        out["warnings"] = list(self.stats["warnings"])
        if self.dropped_warnings:
            out["warnings"].append(f"… and {self.dropped_warnings} more warnings")
        return out

    def commit(self) -> None:
        self.db.commit()
        # Nothing is read back from the ORM objects, so drop them: an import of
        # tens of thousands of blocks keeps a flat memory profile.
        self.db.expunge_all()
        self.pending = 0

    # The walk -------------------------------------------------------------

    def run(self) -> dict:
        try:
            top = sorted((n for n in self.ex.nodes if n.parent is None), key=lambda n: (n.title.casefold(), n.id))
            last = self.db.scalar(
                select(func.max(Page.position)).where(Page.parent_id == self.parent_page_id, Page.deleted.is_(False))
            ) or 0.0
            # After whatever the parent page already holds.
            for i, node in enumerate(top):
                self.import_node(node, self.parent_page_id, float(last) + i + 1)
            self.commit()
            self.report("done")
            return self.result()
        finally:
            self.db.close()

    def import_node(self, node: _Node, parent_id: str, position: float) -> None:
        if node.kind == "database":
            self.import_database(node, parent_id, position)
        else:
            self.import_page(node, parent_id, position)

    def _order(self, node: _Node, refs: list[_Node]) -> list[_Node]:
        """Child pages in the order the parent's text links to them, the rest
        alphabetically after."""
        seen = []
        for r in refs:
            if r.parent is node and r not in seen:
                seen.append(r)
        rest = sorted((c for c in node.children if c not in seen), key=lambda c: (c.title.casefold(), c.id))
        return [c for c in seen if not c.row] + [c for c in rest if not c.row]

    def _new_page(self, node: _Node, parent_id: str, position: float, kind: str = "page",
                  schema: dict | None = None) -> bool:
        page = Page(
            id=node.id, workspace_id=self.workspace_id, parent_id=parent_id, owner_id=self.user_id,
            kind=kind, title=node.title or "", position=position, props=node.props or {},
            schema=schema, options={}, clock={}, last_edited_by=self.actor,
        )
        try:
            with self.db.begin_nested():
                self.db.add(page)
        except DB_GONE:
            raise
        except Exception as exc:  # one page must not end the import
            log.exception("notion import: page %s", node.title)
            self.warn(f"{self.ex.rel(node.md or node.csv)}: page not imported ({exc.__class__.__name__}: {exc})")
            return False
        self.pending += 1
        return True

    def import_page(self, node: _Node, parent_id: str, position: float) -> None:
        self.done += 1
        if not self._new_page(node, parent_id, position):
            return
        self.stats["rows" if node.row else "pages"] += 1
        refs: list[_Node] = []
        if node.md is not None or node.body is not None:
            self._page_files = []
            try:
                with self.db.begin_nested():
                    text = node.body if node.body is not None else _strip_title(_read(node.md))
                    blocks = self.convert(parse_markdown(text), node, refs)
                    added = self.add_blocks(node.id, blocks)
                self.stats["blocks"] += added
            except DB_GONE:
                raise
            except Exception as exc:
                log.exception("notion import: content of %s", node.title)
                self.warn(f"{self.ex.rel(node.md)}: content not imported ({exc.__class__.__name__}: {exc})")
                self._forget_page_files()
            self._page_files = []
        if not node.row or self.pending >= ROW_BATCH:
            self.commit()
            self.report()
        for i, child in enumerate(self._order(node, refs)):
            self.import_node(child, node.id, float(i + 1))

    def add_blocks(self, page_id: str, nodes: list[BlockNode], parent_id: str | None = None) -> int:
        count = 0
        for i, n in enumerate(nodes):
            bid = new_id()
            self.db.add(Block(id=bid, page_id=page_id, parent_id=parent_id, type=n.type, text=n.text or "",
                              props=n.props or {}, position=float(i + 1), clock={}))
            count += 1 + self.add_blocks(page_id, n.children, bid)
        self.pending += count
        return count

    # Databases -------------------------------------------------------------

    def import_database(self, node: _Node, parent_id: str, position: float) -> None:
        self.done += 1
        try:
            header, csv_rows = _read_csv(node.csv)
        except (OSError, csv.Error) as exc:
            self.warn(f"{self.ex.rel(node.csv)}: unreadable CSV ({exc})")
            header, csv_rows = [], []
        title_name = header[0] if header else "Name"
        keys = list(header[1:])
        rows = self._match_rows(node, keys, csv_rows)

        base = node.csv.parent if node.csv else node.dir

        def is_file(value: str) -> bool:
            kind, _ = self.ex.resolve(value, base)
            return kind == "file"

        props = [{"id": "title", "name": title_name, "type": "title"}]
        used = {"title"}
        for k in keys:
            prop = _infer(k, [r.kv.get(k, "") for r in rows], is_file)
            pid = "p_" + secrets.token_hex(4)
            while pid in used:
                pid = "p_" + secrets.token_hex(4)
            used.add(pid)
            props.append({"id": pid, **prop})

        view = {"id": "v_" + secrets.token_hex(4), "name": "Table", "type": "table"}
        sort = self._view_sort(node, props)
        if sort:
            view["sort"] = sort
        schema = {"properties": [{k: v for k, v in p.items() if not k.startswith("_")} for p in props],
                  "views": [view]}
        if not self._new_page(node, parent_id, position, kind="database", schema=schema):
            return
        self.stats["databases"] += 1
        self.commit()
        self.report()

        for i, row in enumerate(rows):
            self._page_files = []
            try:
                with self.db.begin_nested():
                    row.props = self._row_props(row, props, base)
            except DB_GONE:
                raise
            except Exception as exc:
                log.exception("notion import: row values of %s", row.title)
                self.warn(f"{self.ex.rel(row.md or node.csv)}: row values not imported ({exc})")
                self._forget_page_files()
                row.props = {}
            self._page_files = []
            self.import_page(row, node.id, float(i + 1))
        self.commit()
        self.report()

    def _match_rows(self, node: _Node, keys: list[str], csv_rows: list[list[str]]) -> list[_Node]:
        """Pair CSV rows with row pages; each side may lack the other.

        By title first. What the title pass leaves over is paired by property
        values: where a title holds a link, the CSV has the link's URL and the
        page its text ("https://g-e-h.de/…" against "Altsteirer")."""
        keyset = set(keys)
        pages = [c for c in node.children if c.row]
        for c in pages:
            if c.md is not None:
                try:
                    title, kv, body = _split_row(_read(c.md), keyset)
                except OSError as exc:
                    self.warn(f"{self.ex.rel(c.md)}: unreadable ({exc.strerror or exc})")
                    continue
                c.title = title if title is not None else c.title
                c.kv, c.body = kv, body
        by_title: dict[str, list[_Node]] = {}
        for c in pages:
            by_title.setdefault(_norm_title(c.title) or "untitled", []).append(c)
        taken: set[int] = set()

        def claim(cands: list[_Node], values: dict) -> _Node:
            best = max(cands, key=lambda c: _agreement(c.kv, values))
            taken.add(id(best))
            return best

        parsed: list[tuple[str, dict]] = []
        slots: list[_Node | None] = []
        for cells in csv_rows:
            title = cells[0].strip() if cells else ""
            values = {k: (cells[i + 1] if i + 1 < len(cells) else "").strip() for i, k in enumerate(keys)}
            parsed.append((title, values))
            nt = _norm_title(title) or "untitled"
            cands = [c for c in by_title.get(nt, []) if id(c) not in taken]
            if not cands and len(nt) >= 8:
                # File names (and so titles of pages without a "# " line) are cut short.
                cands = [c for c in pages if id(c) not in taken and len(_norm_title(c.title)) >= 8
                         and nt.startswith(_norm_title(c.title))]
            slots.append(claim(cands, values) if cands else None)

        for i, (title, values) in enumerate(parsed):
            free = [c for c in pages if id(c) not in taken]
            # Only a title with a URL in it explains a missed match. Anything
            # else pairing up by values alone (a template page with the same
            # Status as a CSV-only row) would be a guess.
            if slots[i] is not None or not free or not URL_IN_TEXT_RE.search(title):
                continue
            hosts = _norm_title(_urls_to_hosts(title))
            cands = [c for c in free if hosts and _norm_title(c.title) == hosts]
            if not cands:
                scored = sorted(((_agreement(c.kv, values), c) for c in free), key=lambda t: -t[0])
                score, best = scored[0]
                filled = sum(1 for v in best.kv.values() if v.strip())
                unique = len(scored) == 1 or scored[1][0] < score
                if score >= 1 and score * 2 >= filled and unique:
                    cands = [best]
            if cands:
                slots[i] = claim(cands, values)

        out: list[_Node] = []
        for (title, values), row in zip(parsed, slots):
            if row is None:
                row = _Node("page", title, node.dir, title, parent=node, row=True, kv=values, body="")
                node.children.append(row)
                self.total += 1
            else:
                for k, v in values.items():
                    if v or k not in row.kv:
                        row.kv[k] = v
                row.title = row.title or title
            out.append(row)
        rest = sorted((c for c in pages if id(c) not in taken), key=lambda c: (c.title.casefold(), c.id))
        return out + rest

    def _view_sort(self, node: _Node, props: list[dict]) -> list[dict]:
        """The default view's sort, from the database page's "sort:" section."""
        if node.md is None:
            return []
        lines = _read(node.md).split("\n")
        by_name = {p["name"]: p["id"] for p in props}
        out = []
        for i, line in enumerate(lines):
            if line.strip() == "sort:":
                for nxt in lines[i + 1:]:
                    name, sep, direction = nxt.rpartition(":")
                    direction = direction.strip().lower()
                    if not sep or direction not in ("ascending", "descending") or name.strip() not in by_name:
                        break
                    out.append({"property": by_name[name.strip()],
                                "direction": "asc" if direction == "ascending" else "desc"})
        return out

    def _row_props(self, row: _Node, props: list[dict], base: Path) -> dict:
        out = {}
        for p in props:
            if p["id"] == "title":
                continue
            raw = (row.kv.get(p["name"]) or "").strip()
            if not raw:
                continue
            kind = p["type"]
            if kind == "checkbox":
                out[p["id"]] = raw == "Yes"
            elif kind == "number":
                n = _number(raw)
                if n is not None:
                    out[p["id"]] = n[0]
            elif kind == "date":
                v = _date_value(raw, p.get("_day_first", True))
                if v is not None:
                    out[p["id"]] = v
            elif kind == "multi_select":
                out[p["id"]] = _split_multi(raw)
            elif kind == "files":
                files = []
                row_base = row.md.parent if row.md is not None else base
                for part in _split_multi(raw):
                    kind2, target = self.ex.resolve(part, row_base)
                    if kind2 != "file":
                        kind2, target = self.ex.resolve(part, base)
                    info = self.upload(target, row.id) if kind2 == "file" else None
                    if info is None:
                        self.warn(f"{self.ex.rel(row.md or base)}: file {unquote(part)!r} not found")
                        continue
                    files.append({"file_id": info["file_id"], "name": info["name"]})
                if files:
                    out[p["id"]] = files
            else:
                out[p["id"]] = raw
        return out

    # Content ----------------------------------------------------------------

    def convert(self, nodes: list[BlockNode], page: _Node, refs: list[_Node]) -> list[BlockNode]:
        """Rewrite parsed blocks for meerpad: links, attachments, child pages."""
        base = page.md.parent if page.md is not None else page.dir
        out: list[BlockNode] = []
        for n in nodes:
            n.children = self.convert(n.children, page, refs)
            if n.type == "paragraph" and not n.children:
                standalone = self._standalone(n.text, page, base, refs)
                if standalone is not None:
                    out.extend(standalone)
                    continue
            if n.type == "image":
                img = self._image(n, page, base)
                if img is not None:
                    out.append(img)
                continue
            if n.type in INLINE_TYPES:
                n.text = self.rewrite(n.text, page, base, refs)
            elif n.type == "table":
                rows = n.props.get("rows") or []
                n.props = {**n.props, "rows": [[self.rewrite(c, page, base, refs) for c in r] for r in rows]}
            out.append(n)
        return out

    def _standalone(self, text: str, page: _Node, base: Path, refs: list[_Node]) -> list[BlockNode] | None:
        """A paragraph made of nothing but links into the export, one per line,
        becomes page/database/file blocks. None when it is ordinary text."""
        links = [whole_link(line) for line in text.split("\n")]
        if not links or any(link is None or link.image for link in links):
            return None
        resolved = [self.ex.resolve(link.target, base) for link in links]
        if any(kind == "external" for kind, _ in resolved):
            return None
        out = []
        for link, (kind, target) in zip(links, resolved):
            if kind == "node":
                refs.append(target)
                if target.kind == "database":
                    out.append(BlockNode("database", "", {"page_id": target.id}))
                elif target.parent is page:
                    out.append(BlockNode("page", "", {"page_id": target.id}))
                else:
                    out.append(BlockNode("paragraph", f"[{link.text}](/p/{target.id})"))
            elif kind == "file":
                info = self.upload(target, page.id, link.text)
                if info is None:
                    out.append(BlockNode("paragraph", link.text))
                else:
                    out.append(self._media_block(info, link.text))
            else:
                self.warn(f"{self.ex.rel(page.md)}: link target {target!r} not in the export")
                if link.text.strip():
                    out.append(BlockNode("paragraph", link.text))
        return out

    def _media_block(self, info: dict, alt: str) -> BlockNode:
        # Notion writes the file name as the alt text when there is no caption.
        caption = "" if _looks_like_filename(alt) else alt
        # The stored name, not the export's: a HEIC came in as a WebP.
        ext = Path(info["name"]).suffix.lower().lstrip(".")
        if ext in WEB_IMAGE_EXTS:
            return BlockNode("image", caption, {"file_id": info["file_id"], "name": info["name"]})
        return BlockNode("file", caption, {
            "file_id": info["file_id"], "name": info["name"], "size": info["size"],
            "content_type": info["content_type"],
        })

    def _image(self, n: BlockNode, page: _Node, base: Path) -> BlockNode | None:
        src = str(n.props.get("url") or "")
        kind, target = self.ex.resolve(src, base)
        if kind == "external":
            caption = "" if _looks_like_filename(n.text) else n.text
            return BlockNode("image", caption, {"url": src})
        if kind == "file":
            info = self.upload(target, page.id, n.text)
            if info is not None:
                return self._media_block(info, n.text)
        elif kind == "node":
            return BlockNode("paragraph", f"[{n.text or target.title}](/p/{target.id})")
        else:
            self.warn(f"{self.ex.rel(page.md)}: image {target!r} not in the export")
        return BlockNode("paragraph", n.text) if n.text.strip() else None

    def rewrite(self, text: str, page: _Node, base: Path, refs: list[_Node]) -> str:
        """Point every link in inline text at meerpad: pages to ``/p/<id>``,
        attachments to ``/api/files/<id>/<name>``. A link to something the
        export does not contain keeps only its text."""
        if not text or "](" not in text:
            return text
        out, pos = [], 0
        for link in find_links(text):
            new = self._rewrite_link(link, page, base, refs)
            if new is None:
                continue
            out.append(text[pos:link.start])
            out.append(new)
            pos = link.end
        out.append(text[pos:])
        return "".join(out)

    def _rewrite_link(self, link: Link, page: _Node, base: Path, refs: list[_Node]) -> str | None:
        kind, target = self.ex.resolve(link.target, base)
        if kind == "external":
            return None
        if kind == "node":
            refs.append(target)
            return f"[{link.text or target.title}](/p/{target.id})"
        if kind == "file":
            info = self.upload(target, page.id, link.text)
            if info is not None:
                return f"[{link.text or info['name']}](/api/files/{info['file_id']}/{quote(info['name'])})"
            return link.text
        self.warn(f"{self.ex.rel(page.md)}: link target {target!r} not in the export")
        return link.text

    # Files --------------------------------------------------------------------

    def upload(self, path: Path, page_id: str, label: str = "") -> dict | None:
        """Store an attachment once per page (a page that shows the same file
        twice gets one file). Across pages each gets its own copy: a file row
        belongs to one page, which is what share links and published sites use
        to decide who may read it, and emptying the trash deletes it.

        ``label`` is the link text. Notion writes the original upload name
        there ("Screenshot 2025-10-27 at 16.19.20.png") and a sanitised one on
        disk (with underscores), so the label names the file when it is one."""
        pkey = (_key(path), page_id)
        if pkey in self.uploads:
            return self.uploads[pkey]
        try:
            digest = hashlib.sha256()
            with open(path, "rb") as fh:
                while chunk := fh.read(1024 * 1024):
                    digest.update(chunk)
            skey = (digest.hexdigest(), page_id)
            info = self.by_sha.get(skey)
            if info is None:
                label = (label or "").strip()
                same_ext = Path(label).suffix.lower() == path.suffix.lower()
                name = label if _looks_like_filename(label) and same_ext and "/" not in label else path.name
                with open(path, "rb") as fh:
                    # The import's own cap, not the per-upload one: a Notion
                    # attachment can be bigger than a drag-and-drop upload may be.
                    row = create_file(
                        self.db, self.user_id, iter(lambda: fh.read(1024 * 1024), b""), name, None,
                        page_id=page_id, max_bytes=settings.max_import_bytes,
                    )
                info = {"file_id": row.id, "name": row.filename, "size": row.size,
                        "content_type": row.content_type}
                self.by_sha[skey] = info
                self.stats["files"] += 1
                self._page_files.append((row.id, row.stored_name))
            self.uploads[pkey] = info
            return info
        except HTTPException as exc:
            self.warn(f"{self.ex.rel(path)}: not imported ({exc.detail})")
        except OSError as exc:
            self.warn(f"{self.ex.rel(path)}: unreadable ({exc.strerror or exc})")
        return None

    def _forget_page_files(self) -> None:
        """A savepoint rolled back: the file rows made inside it are gone, so
        their stored copies and every cache entry pointing at them go too."""
        dead = {file_id for file_id, _ in self._page_files}
        for _, stored in self._page_files:
            path_for(stored).unlink(missing_ok=True)
        if dead:
            self.stats["files"] -= len(dead)
            self.uploads = {k: v for k, v in self.uploads.items() if v["file_id"] not in dead}
            self.by_sha = {k: v for k, v in self.by_sha.items() if v["file_id"] not in dead}
        self._page_files = []


def _value_key(value: str) -> str:
    """A property value for comparing a CSV cell with a row page's line. File
    paths compare by their last two parts: the CSV writes them relative to
    another folder than the page does."""
    v = unquote(value.strip())
    if "/" in v and not SCHEME_RE.match(v):
        v = "/".join(v.split("/")[-2:])
    return v


def _agreement(kv: dict, values: dict) -> int:
    """How many non-empty properties a row page and a CSV row share."""
    return sum(1 for k, v in kv.items() if v.strip() and values.get(k) and _value_key(v) == _value_key(values[k]))


def _urls_to_hosts(text: str) -> str:
    """ "Brunnen http://brunnen-bau.com/ fragen" -> "Brunnen brunnen-bau.com fragen":
    the CSV spells a link in a title as its URL, the page as its (often the
    host's) text."""
    return URL_IN_TEXT_RE.sub(lambda m: m.group(1), text)


def _looks_like_filename(text: str) -> bool:
    return bool(re.search(r"\.[A-Za-z0-9]{2,5}$", (text or "").strip()))


def _strip_title(text: str) -> str:
    """The page body without its ``# Title`` line (the title is the page's own)."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.strip():
            return "\n".join(lines[i + 1:]) if line.startswith("# ") else text
    return text


def _split_row(text: str, keys: set[str]) -> tuple[str | None, dict, str]:
    """A row page's title, its ``Key: value`` lines (only columns of the
    database count), and the rest of its body."""
    lines = text.split("\n")
    i, n = 0, len(lines)
    while i < n and not lines[i].strip():
        i += 1
    title = None
    if i < n and lines[i].startswith("# "):
        title = lines[i][2:].strip()
        i += 1
    while i < n and not lines[i].strip():
        i += 1
    # Longest first: a column "Date Created" must not be read as "Date".
    ordered = sorted((k for k in keys if k), key=len, reverse=True)
    kv: dict[str, str] = {}
    last = None
    j = i
    while j < n and lines[j].strip():
        line = lines[j].strip()
        key = next((k for k in ordered if line.startswith(k + ":")), None)
        if key is not None:
            kv[key] = line[len(key) + 1:].strip()
            last = key
        elif last is not None and not KV_LINE_RE.match(line):
            kv[last] += "\n" + line  # a multi-line value (a text cell with line breaks)
        else:
            break  # content starts here (a "Key: value" of no column is text)
        j += 1
    body = "\n".join(lines[j:] if kv else lines[i:])
    return title, kv, body


def _read_csv(path: Path | None) -> tuple[list[str], list[list[str]]]:
    """Header and non-empty rows. utf-8-sig drops the BOM Notion writes."""
    if path is None:
        return [], []
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
        rows = list(csv.reader(fh))
    if not rows:
        return [], []
    header = [h.strip() for h in rows[0]]
    body = [r for r in rows[1:] if any(c.strip() for c in r)]
    return header, body


# --- Entry point ---------------------------------------------------------------------------


def import_notion(user_id: str, workspace_id: str, parent_page_id: str, source: Path,
                  progress: Progress | None = None) -> dict:
    """Import a Notion "Markdown & CSV" export (a zip, nested zips included, or
    an extracted folder) under ``parent_page_id``.

    Returns ``{"pages", "databases", "rows", "blocks", "files", "warnings"}``.
    Raises ImportFailed when nothing can be imported (bad zip, wrong target)."""
    source = Path(source)
    with SessionLocal() as db:
        user = db.get(User, user_id)
        ws = db.get(Workspace, workspace_id)
        parent = db.get(Page, parent_page_id)
        if user is None:
            raise ImportFailed("Unknown user")
        if ws is None or ws.owner_id != user.id or ws.deleted:
            raise ImportFailed("Workspace not found")
        if parent is None or parent.owner_id != user.id or parent.workspace_id != ws.id or parent.deleted:
            raise ImportFailed("Parent page not found in that workspace")
        if parent.kind == "database":
            raise ImportFailed("Cannot import into a database")
        db.expunge(user)

    if not source.exists():
        raise ImportFailed("The export was not found")
    settings.import_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="notion-", dir=settings.import_dir))
    try:
        if progress is not None:
            progress({"phase": "extracting"})
        unpack_warnings: list[str] = []
        root = _prepare(source, work, unpack_warnings)
        if progress is not None:
            progress({"phase": "scanning"})
        export = _Export(root)
        export.warnings[:0] = unpack_warnings
        if not export.nodes:
            raise ImportFailed("No Notion pages found (expected .md and .csv files)")
        return _Importer(user, workspace_id, parent_page_id, export, progress).run()
    finally:
        shutil.rmtree(work, ignore_errors=True)
