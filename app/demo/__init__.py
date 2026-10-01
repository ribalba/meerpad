"""The demo workspace: Sunny Acre Farm, a made-up farm written down in meerpad
to show what it does.

The app offers it once, on an account's first start (app.welcome.js), and
Settings adds it at any time (routers/demo.py). ``create_demo`` writes it
straight into the database the way the Notion importer writes an import:
ordinary rows with an empty ``clock``, so any edit from a device wins, and
fresh revs, so the account's next pull brings it to every device. Once it
exists, nothing about it is special.

Each page shows a part of meerpad (docs/DESIGN.md is the contract it follows):

* Farm, the root page: the tour, as a table, to-dos and an inline database;
* Chickens: the everyday blocks, a picture beside its text in a grid, an
  equation, colours and links to pages; below it Breeds (a gallery, a picture
  on every card), the Egg log, and one page in the trash;
* Farm tasks and Season plan: board, table, list and Gantt views, filters;
* Farm shop: a PDF preview, a bookmark, a map, and the cover and subpages that
  make it a landing page once it is published;
* Coop door: highlighted code and a diagram drawn from text;
* Contacts: phone, email, URL and checkbox properties on a full-width page;
* Farm journal: a page set in a serif font.

Page text is the Markdown of app/mdblocks.py, plus nodes for the blocks
Markdown has no syntax for (links to pages, inline databases, files,
bookmarks, embeds, colours). Dates count from the day the demo is made, so the
task board and the Gantt chart look current. The pictures and the price list
are files in this directory; the hens are drawn here, one per breed.

It publishes nothing and turns on no share link: a demo must not put anything
on the public web, or take a site name someone else may want. The tour says
how to do both.
"""

import secrets
import textwrap
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from ..mdblocks import BlockNode, parse_markdown
from ..models import Block, File, Page, User, Workspace, utcnow
from ..storage import create_file, path_for

ASSETS = Path(__file__).resolve().parent
NAME = "Farm"
ICON = "🚜"

# The root page's table of contents: which page shows what. A table in the
# editor is as wide as its longest cell, so these stay short enough to fit.
TOUR = (
    ("chickens", "🐔 Chickens", "Headings, lists, to-dos, toggles, callouts, a grid, an equation"),
    ("tasks", "✅ Farm tasks", "A board, a table and a filtered list. Drag the cards around"),
    ("season", "📅 Season plan", "A Gantt chart: drag a bar to move it, or its end to stretch it"),
    ("breeds", "🐓 Breeds", "A gallery, with a picture on every card"),
    ("shop", "🏪 Farm shop", "A PDF, a bookmark and a map, on a page ready to be a website"),
    ("coop", "🔧 Coop door", "Code with syntax highlighting, and a diagram drawn from text"),
    ("contacts", "📇 Contacts", "Phone numbers, emails and links on a full-width page"),
    ("journal", "📓 Farm journal", "A page set in a serif font"),
)

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December")


def create_demo(db: DBSession, user: User) -> Workspace:
    """Add the demo workspace to ``user``'s account: flushed, not committed.

    Its files are written to disk as they are made. If anything fails they are
    removed again and the error goes up; the caller's rollback drops the rows."""
    farm = _Farm(db, user)
    try:
        return farm.build()
    except BaseException:
        for name in farm.stored:
            path_for(name).unlink(missing_ok=True)
        raise


# --- Building blocks ------------------------------------------------------------------------


def _id() -> str:
    return str(uuid.uuid4())


def _rid(prefix: str) -> str:
    """A schema id the way the client makes one (app.database.js ``rid``)."""
    return prefix + secrets.token_hex(5)


def md(text: str) -> list[BlockNode]:
    """Blocks from Markdown written indented in this file. A paragraph wraps
    over several lines here, but they are one line of text to the reader: the
    parser would keep each line break as a soft break (Shift+Enter)."""
    nodes = parse_markdown(textwrap.dedent(text).strip("\n"))

    def unwrap(ns: list[BlockNode]) -> None:
        for n in ns:
            if n.type == "paragraph":
                n.text = n.text.replace("\n", " ")
            unwrap(n.children)

    unwrap(nodes)
    return nodes


def node(type_: str, text: str = "", *children: BlockNode, **props) -> BlockNode:
    return BlockNode(type_, text, props, list(children))


def link(page_id: str, title: str) -> str:
    return f"[{title}](/p/{page_id})"


def prop(name: str, type_: str, **extra) -> dict:
    return {"id": _rid("p_"), "name": name, "type": type_, **extra}


def options(*pairs: tuple[str, str]) -> list[dict]:
    return [{"id": _rid("o_"), "name": name, "color": color} for name, color in pairs]


def view(name: str, type_: str, **keys) -> dict:
    return {"id": _rid("v_"), "name": name, "type": type_, **keys}


def _today(user: User) -> date:
    """The date where the account is: "due tomorrow" should mean its tomorrow."""
    try:
        return datetime.now(ZoneInfo(user.timezone or "UTC")).date()
    except (ZoneInfoNotFoundError, ValueError):
        return utcnow().date()


def spoken(d: date) -> str:
    """ "Tuesday 29 September", in English whatever the server's locale."""
    return f"{WEEKDAYS[d.weekday()]} {d.day} {MONTHS[d.month - 1]}"


# --- The hens ----------------------------------------------------------------------------------

# One picture per breed, for the gallery cards: the same hen in the breed's colours.
BREEDS = [
    {
        "title": "Sussex", "origin": "England", "egg": "Cream", "eggs": 250,
        "temperament": ["Calm", "Friendly"], "flock": True,
        "look": {"bg": "#e3eef7", "body": "#f7f4ee", "wing": "#e6e0d4", "tail": "#2f2f2f", "head": "#f7f4ee", "hackle": "#3d3d3d"},
        "text": "An old English breed and the backbone of our flock. Light Sussex are white, with a black-striped "
                "collar and a black tail. Calm, curious, and happy to be picked up.",
    },
    {
        "title": "Marans", "origin": "France", "egg": "Dark brown", "eggs": 200,
        "temperament": ["Hardy", "Calm"], "flock": True,
        "look": {"bg": "#f6e7da", "body": "#2e2724", "wing": "#3d322c", "tail": "#1c1918", "head": "#b8652a", "hackle": "#b8652a"},
        "text": "From the marshes around the town of Marans. Black copper hens lay the darkest brown eggs of "
                "the flock, and customers ask for them by name.",
    },
    {
        "title": "Leghorn", "origin": "Italy", "egg": "White", "eggs": 280,
        "temperament": ["Flighty", "Noisy"], "flock": True,
        "look": {"bg": "#e7f3e1", "body": "#fbfbf8", "wing": "#eceae4", "tail": "#f1efe9", "head": "#fbfbf8", "hackle": "#fbfbf8"},
        "text": "Light, quick and always on the move. Leghorns lay more eggs than any other breed we keep, and "
                "fly over any fence lower than two metres.",
    },
    {
        "title": "Orpington", "origin": "England", "egg": "Light brown", "eggs": 180,
        "temperament": ["Calm", "Friendly", "Broody"], "flock": True,
        "look": {"bg": "#fbf0d6", "body": "#e3b06a", "wing": "#d39a4e", "tail": "#c98a3e", "head": "#e8bb7b", "hackle": "#e8bb7b"},
        "text": "Big, fluffy and gentle. Buff Orpingtons go broody every summer, which makes them the best "
                "mothers on the farm.",
    },
    {
        "title": "Araucana", "origin": "Chile", "egg": "Blue", "eggs": 180,
        "temperament": ["Hardy", "Flighty"], "flock": False,
        "look": {"bg": "#e2e8f5", "body": "#8d97a8", "wing": "#798396", "tail": "#5f6878", "head": "#98a2b3", "hackle": "#98a2b3"},
        "text": "The hens with the blue eggs. Not in the flock yet: two pullets are on the list for next spring.",
    },
    {
        "title": "Brahma", "origin": "USA", "egg": "Light brown", "eggs": 150,
        "temperament": ["Calm", "Hardy"], "flock": False,
        "look": {"bg": "#efe8f4", "body": "#f2efe8", "wing": "#e2ddd2", "tail": "#2d2d2d", "head": "#f2efe8", "hackle": "#4a4a4a", "feathered": True},
        "text": "A giant with feathered feet, and lays right through the winter. We would need a bigger door "
                "for the hen house first.",
    },
]


def hen_svg(bg: str, body: str, wing: str, tail: str, head: str, hackle: str, feathered: bool = False) -> bytes:
    """A hen in a breed's colours, 480 by 320."""
    feet = (
        f'<ellipse cx="222" cy="268" rx="20" ry="13" fill="{body}"/><ellipse cx="262" cy="268" rx="20" ry="13" fill="{body}"/>'
        if feathered else ""
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320" width="480" height="320">
  <rect width="480" height="320" fill="{bg}"/>
  <ellipse cx="240" cy="290" rx="150" ry="14" fill="#000" opacity="0.07"/>
  <g stroke="#e0a526" stroke-width="7" stroke-linecap="round" fill="none">
    <path d="M222 230 L218 284 M218 284 L204 290 M218 284 L230 291"/>
    <path d="M262 230 L264 284 M264 284 L250 291 M264 284 L277 290"/>
  </g>
  {feet}
  <path d="M170 190 C 112 182, 86 128, 96 60 C 128 92, 160 116, 200 134 Z" fill="{tail}"/>
  <path d="M182 176 C 142 150, 128 108, 142 62 C 160 98, 182 118, 214 132 Z" fill="{tail}" opacity="0.85"/>
  <ellipse cx="238" cy="186" rx="96" ry="64" fill="{body}"/>
  <path d="M262 160 C 270 128, 284 104, 300 96 L 344 112 C 336 146, 322 172, 296 188 Z" fill="{hackle}"/>
  <circle cx="322" cy="92" r="31" fill="{head}"/>
  <path d="M298 70 C 298 52, 312 48, 314 64 C 316 46, 332 46, 332 63 C 338 50, 352 56, 344 74 Z" fill="#d8412f"/>
  <path d="M350 88 L376 97 L350 105 Z" fill="#f2a93b"/>
  <ellipse cx="346" cy="116" rx="7" ry="11" fill="#d8412f"/>
  <circle cx="331" cy="86" r="5" fill="#222"/>
  <circle cx="332.5" cy="84.5" r="1.6" fill="#fff"/>
  <path d="M188 182 C 208 150, 266 150, 284 182 C 266 218, 212 222, 188 182 Z" fill="{wing}"/>
  <path d="M206 186 C 226 196, 252 198, 272 188" stroke="{tail}" stroke-width="3" fill="none" opacity="0.35"/>
</svg>
""".encode()


# --- The farm ----------------------------------------------------------------------------------


class _Farm:
    def __init__(self, db: DBSession, user: User):
        self.db = db
        self.user = user
        self.today = _today(user)
        self.stored: list[str] = []   # files on disk, removed again if the demo fails
        # Every page that is linked to gets its id up front, so a page can link
        # to one that is made after it.
        self.ids = {key: _id() for key in (
            "root", "chickens", "breeds", "eggs", "old_plan", "tasks", "season",
            "shop", "shop_eggs", "shop_apples", "shop_find", "coop", "contacts", "journal",
        )}
        self.ws_id = _id()
        self.board_view = ""  # the tasks' board, which the root page shows inline

    # Helpers ------------------------------------------------------------------------

    def iso(self, days: int) -> str:
        return (self.today + timedelta(days=days)).isoformat()

    def page(self, parent_id: str | None, title: str, *, position: float, key: str | None = None,
             blocks: list[BlockNode] = (), deleted: bool = False, **fields) -> str:
        pid = self.ids[key] if key else _id()
        self.db.add(Page(
            id=pid, workspace_id=self.ws_id, parent_id=parent_id, owner_id=self.user.id,
            title=title, position=float(position), clock={}, last_edited_by=self.user.email,
            deleted=deleted, deleted_at=utcnow() if deleted else None,
            props=fields.pop("props", None) or {}, options=fields.pop("options", None) or {}, **fields,
        ))
        # Before its blocks, which name it in a foreign key.
        self.db.flush()
        self.add_blocks(pid, list(blocks))
        return pid

    def add_blocks(self, page_id: str, nodes: list[BlockNode], parent_id: str | None = None) -> None:
        for i, n in enumerate(nodes, 1):
            bid = _id()
            self.db.add(Block(id=bid, page_id=page_id, parent_id=parent_id, type=n.type, text=n.text or "",
                              props=n.props or {}, position=float(i), clock={}))
            self.add_blocks(page_id, n.children, bid)

    def file(self, page_id: str, name: str, data: bytes | None = None) -> File:
        """A file of the page ``page_id`` (who may read a file follows its page):
        ``data``, or the file ``name`` in this directory."""
        if data is None:
            data = (ASSETS / name).read_bytes()
        f = create_file(self.db, self.user.id, [data], name, None, page_id=page_id)
        self.stored.append(f.stored_name)
        return f

    def image(self, page_id: str, name: str, caption: str) -> BlockNode:
        f = self.file(page_id, name)
        return node("image", caption, file_id=f.id, name=f.filename, size=f.size, content_type=f.content_type)

    # The workspace --------------------------------------------------------------------

    def build(self) -> Workspace:
        last = self.db.scalar(select(func.max(Workspace.position)).where(
            Workspace.owner_id == self.user.id, Workspace.deleted.is_(False)))
        ws = Workspace(id=self.ws_id, owner_id=self.user.id, name=NAME, icon=ICON,
                       position=float(last) + 1 if last is not None else 0.0,
                       root_page_id=self.ids["root"], clock={})
        self.db.add(ws)
        self.db.flush()
        # Databases first: the root page shows the task board inline.
        root = self.ids["root"]
        self.tasks(root, 2)
        self.chickens(root, 1)
        self.season(root, 3)
        self.shop(root, 4)
        self.coop(root, 5)
        self.contacts(root, 6)
        self.journal(root, 7)
        self.root()
        self.db.flush()
        return ws

    def root(self) -> None:
        i = self.ids
        cover = self.file(i["root"], "fields.svg")
        blocks = [
            node("callout", "**Welcome to Sunny Acre Farm.** This workspace is a demo: a made-up farm, written "
                            "down in meerpad to show what it can do. Every page in it is an ordinary page, so "
                            "click around and change whatever you like. When you are done, delete the whole "
                            "workspace in Settings, Workspaces.", icon="👋", color="yellow_bg"),
            *md("""
                Sunny Acre is nine hectares of fields, an orchard, a kitchen garden and a flock of hens, run by
                three people and one very loud rooster. This is where they keep track of it all. Each page
                below shows a different part of meerpad.

                ## Take the tour
                """),
            node("table", "", header_row=True,
                 rows=[["Page", "What it shows"], *([link(i[key], title), text] for key, title, text in TOUR)]),
            *md(f"""
                ## Things to try

                - [x] Sign in to meerpad
                - [ ] Type `/` on an empty line: the menu of every kind of block
                - [ ] Type `[[` and a few letters to link to another page
                - [ ] Write Markdown as you go: `# ` makes a heading, `- ` a list, `[] ` a to-do and `>> ` a toggle
                - [ ] Hover over a block and drag it by the handle on its left
                - [ ] Choose **Edit as Markdown** in a page's `...` menu, and edit the whole page as text
                - [ ] Move a card on the {link(i["tasks"], "Farm tasks")} board to another column
                - [ ] Open a task: every row of a database is a page too, with room for notes and checklists
                - [ ] Stretch a bar in the {link(i["season"], "Season plan")}
                - [ ] Publish the {link(i["shop"], "Farm shop")} as a website: **Publish** at the top of the page
                - [ ] Send a page to someone with **Share**: a link to view it, or one to edit it
                - [ ] Find the old hen house plan in the **Trash** and restore it
                - [ ] Press `Ctrl+K` (`Cmd+K` on a Mac) to search every page
                - [ ] Switch off your network and keep writing: meerpad syncs when you are back online

                ## This week on the farm
                """),
            node("database", "", page_id=i["tasks"], view_id=self.board_view),
            node("divider"),
            node("paragraph", "Coming from Notion? Export a page or a whole workspace as *Markdown & CSV* and "
                              "choose **Import from Notion** in the sidebar: databases come along with their rows "
                              "and properties.", color="gray"),
        ]
        self.page(None, NAME, key="root", position=0, icon=ICON, cover=f"file:{cover.id}", blocks=blocks)

    # Chickens ------------------------------------------------------------------------

    def chickens(self, parent: str, position: float) -> None:
        i = self.ids
        blocks = [
            *md(f"""
                Twelve hens and Rudi the rooster live in the hen house between the kitchen garden and the
                barn. This page shows the everyday blocks. Text can be **bold**, *italic*, ~~crossed out~~,
                `code`, ==highlighted== or [a link](https://en.wikipedia.org/wiki/Chicken), and it can link
                to other pages, like the {link(i["eggs"], "Egg log")}.
                """),
            node("grid", "",
                 node("grid_cell", "", self.image(i["chickens"], "farm-map.svg",
                                                  "The farm from above. Drop a picture onto a page and it "
                                                  "shows up like this.")),
                 node("grid_cell", "", *md("""
                     The hen house and its run sit in the middle of the farm, with the kitchen garden on one
                     side and the barn on the other. On most afternoons the hens wander up to the orchard to
                     look for windfalls.

                     The picture and this text are a grid: blocks next to each other. Hover over it and a +
                     shows up at its right edge for another column, and at its bottom for another row.
                     """)),
                 columns=2),
            *md(f"""
                # Looking after the hens

                ## The flock

                | Name | Breed | Hatched | Notes |
                | --- | --- | --- | --- |
                | Hilde | Sussex | 2022 | Boss of the run |
                | Greta | Marans | 2023 | Dark brown eggs |
                | Frieda | Leghorn | 2024 | Escape artist |
                | Olga | Orpington | 2024 | Goes broody every June |
                | Rudi | Sussex | 2022 | The rooster, loud at 5 am |

                ## Every day

                1. Open the hen house at sunrise (the {link(i["coop"], "Coop door")} does it by itself)
                2. Fresh water, and feed in the trough
                3. Collect the eggs and write them down in the {link(i["eggs"], "Egg log")}
                4. Count everyone in at dusk and close the run

                ## Feed

                A laying hen eats about 120 g of feed a day, so the flock needs
                """),
            node("equation", r"F = n \times 0.12\,\mathrm{kg} = 13 \times 0.12\,\mathrm{kg} \approx 1.6\,\mathrm{kg}"),
            *md("""
                - Layer pellets in the morning
                    - 16 % protein
                    - Oyster shell on the side, for strong egg shells
                - Mixed grain in the afternoon
                - Kitchen scraps as a treat
                    - Never raw potato peel, avocado or anything salty

                > The hens know what time it is better than any of us.
                > Oma Liese
                """),
            node("callout", "**Fox season.** From October to March the fox comes by at dusk. Close the run gate "
                            "every evening, even though the door closes by itself.", icon="🦊", color="orange_bg"),
            node("toggle", "🩺 Health checks",
                 *md("""
                     - [x] Look for mites under the perches, every month
                     - [ ] Worming, in spring and in autumn
                     - [ ] Trim claws that get too long
                     """)),
            node("toggle", "🥚 When a hen goes broody",
                 node("paragraph", "She sits on the nest all day and growls when you come near. Take the eggs "
                                   "away every morning. If she keeps at it for three days, she gets a week in "
                                   "the broody coop.")),
            node("heading_3", "More about the flock", color="green"),
            node("page", page_id=i["breeds"]),
            node("page", page_id=i["eggs"]),
            node("bookmark", "", url="https://en.wikipedia.org/wiki/List_of_chicken_breeds",
                 title="List of chicken breeds",
                 description="Wikipedia's list of chicken breeds, from all over the world. Paste a link on an "
                             "empty line to keep it as a bookmark like this one."),
        ]
        chickens = self.page(parent, "Chickens", key="chickens", position=position, icon="🐔", favorite=True,
                             cover="gradient:0", blocks=blocks)
        self.breeds(chickens)
        self.egg_log(chickens)
        self.page(chickens, "Old hen house plan (2023)", key="old_plan", position=3, icon="🗒️", deleted=True,
                  blocks=md("""
                      The first plan for the hen house, from before we moved it next to the kitchen garden.
                      It lives in the trash now: restore it from **Trash** in the sidebar.

                      - Next to the pond (too damp, as it turned out)
                      - 4 by 3 metres, on a wooden frame
                      - Room for 20 hens
                      """))

    def breeds(self, parent: str) -> None:
        origin = prop("Origin", "select", options=options(
            ("England", "blue"), ("France", "purple"), ("Italy", "green"), ("Chile", "orange"), ("USA", "red")))
        egg = prop("Egg colour", "select", options=options(
            ("White", "gray"), ("Cream", "yellow"), ("Light brown", "orange"), ("Dark brown", "brown"), ("Blue", "blue")))
        eggs = prop("Eggs a year", "number")
        temper = prop("Temperament", "multi_select", options=options(
            ("Calm", "green"), ("Friendly", "blue"), ("Hardy", "brown"), ("Flighty", "orange"),
            ("Broody", "purple"), ("Noisy", "red")))
        flock = prop("In our flock", "checkbox")
        schema = {
            "properties": [{"id": "title", "name": "Breed", "type": "title"}, origin, egg, eggs, temper, flock],
            "views": [
                view("Gallery", "gallery"),
                view("By egg colour", "board", group_by=egg["id"]),
                view("Table", "table", sort=[{"property": eggs["id"], "direction": "desc"}]),
            ],
        }
        db = self.page(parent, "Breeds", key="breeds", position=1, icon="🐓", kind="database", schema=schema)
        for n, b in enumerate(BREEDS, 1):
            row = _id()
            f = self.file(row, f"{b['title'].lower()}.svg", hen_svg(**b["look"]))
            self.db.add(Page(
                id=row, workspace_id=self.ws_id, parent_id=db, owner_id=self.user.id, title=b["title"],
                position=float(n), cover=f"file:{f.id}", clock={}, last_edited_by=self.user.email, options={},
                props={origin["id"]: b["origin"], egg["id"]: b["egg"], eggs["id"]: b["eggs"],
                       temper["id"]: b["temperament"], flock["id"]: b["flock"]},
            ))
            self.db.flush()
            self.add_blocks(row, [node("paragraph", b["text"])])

    def egg_log(self, parent: str) -> None:
        when = prop("Date", "date")
        count = prop("Eggs", "number")
        who = prop("Collected by", "person")
        weather = prop("Weather", "select", options=options(
            ("Sunny", "yellow"), ("Cloudy", "gray"), ("Rain", "blue"), ("Frost", "purple")))
        notes = prop("Notes", "text")
        schema = {
            "properties": [{"id": "title", "name": "Day", "type": "title"}, when, count, who, weather, notes],
            "views": [
                view("Table", "table", sort=[{"property": when["id"], "direction": "desc"}]),
                view("List", "list", sort=[{"property": when["id"], "direction": "desc"}], hidden=[notes["id"]]),
            ],
        }
        db = self.page(parent, "Egg log", key="eggs", position=2, icon="🥚", kind="database", schema=schema)
        counts = [9, 11, 10, 8, 10, 12, 9, 7, 10, 11]
        skies = ["Sunny", "Cloudy", "Rain", "Sunny", "Frost", "Cloudy", "Sunny", "Rain", "Cloudy", "Sunny"]
        people = ["Anna", "Ben", "Carla"]
        remarks = {1: "One double yolk", 4: "Greta is laying again after the moult", 7: "Two cracked, the fox was about"}
        for n in range(10):
            day = self.today - timedelta(days=n + 1)
            values = {when["id"]: day.isoformat(), count["id"]: counts[n], who["id"]: people[n % 3],
                      weather["id"]: skies[n]}
            if n in remarks:
                values[notes["id"]] = remarks[n]
            self.page(db, spoken(day), position=10 - n, props=values)

    # Databases with views -------------------------------------------------------------

    def tasks(self, parent: str, position: float) -> None:
        status = prop("Status", "status", options=options(
            ("Not started", "gray"), ("In progress", "blue"), ("Done", "green")))
        area = prop("Area", "select", options=options(
            ("Chickens", "yellow"), ("Orchard", "green"), ("Garden", "orange"), ("Barn", "brown"), ("Shop", "purple")))
        due = prop("Due", "date")
        who = prop("Assignee", "person")
        priority = prop("Priority", "select", options=options(("High", "red"), ("Medium", "yellow"), ("Low", "gray")))
        town = prop("Needs a trip to town", "checkbox")
        created = prop("Created", "created_time")
        edited = prop("Last edited", "last_edited_time")
        board = view("Board", "board", group_by=status["id"], hidden=[created["id"], edited["id"], town["id"]])
        self.board_view = board["id"]
        schema = {
            "properties": [{"id": "title", "name": "Task", "type": "title"},
                           status, area, due, who, priority, town, created, edited],
            "views": [
                board,
                view("Table", "table", sort=[{"property": due["id"], "direction": "asc"}],
                     widths={"title": 260}),
                view("Still to do", "list", filter=[{"property": status["id"], "op": "neq", "value": "Done"}],
                     sort=[{"property": due["id"], "direction": "asc"}]),
                view("By area", "board", group_by=area["id"], hidden=[created["id"], edited["id"]]),
            ],
        }
        db = self.page(parent, "Farm tasks", key="tasks", position=position, icon="✅", kind="database",
                       favorite=True, schema=schema)
        rows = [
            ("Fix the gate of the hen run", "In progress", "Chickens", 1, "Ben", "High", True, md("""
                The bottom board is rotten and the fox has been trying it.

                - [x] Buy two new hinges
                - [ ] Replace the bottom board
                - [ ] Oil the latch
                """)),
            ("Clean out the hen house", "Not started", "Chickens", 3, "Anna", "Medium", False, []),
            ("Pick the last apples", "In progress", "Orchard", 5, "Carla", "High", False, []),
            ("Repair the orchard fence", "Not started", "Orchard", 9, "Carla", "Medium", True, []),
            ("Order seed potatoes", "Not started", "Garden", 12, "Anna", "Medium", False, []),
            ("Service the tractor", "Not started", "Barn", 20, "Ben", "Low", True, []),
            ("Plant the garlic", "Done", "Garden", -4, "Anna", "Medium", False, []),
            ("Print the new price list", "Done", "Shop", -2, "Carla", "Low", False, []),
            ("Put up the shop sign", "Done", "Shop", -6, "Ben", "Medium", True, []),
        ]
        for n, (title, st, ar, days, person, prio, trip, body) in enumerate(rows, 1):
            values = {status["id"]: st, area["id"]: ar, due["id"]: self.iso(days), who["id"]: person,
                      priority["id"]: prio}
            if trip:
                values[town["id"]] = True
            self.page(db, title, position=n, props=values, blocks=body)

    def season(self, parent: str, position: float) -> None:
        # The "Gantt chart" preset of the / menu (app.database.js ganttSchema), filled in.
        dates = prop("Dates", "date")
        status = prop("Status", "status", options=options(
            ("Not started", "gray"), ("In progress", "blue"), ("Done", "green")))
        owner = prop("Owner", "person")
        progress = prop("Progress", "number", number_format="percent")
        schema = {
            "properties": [{"id": "title", "name": "Task", "type": "title"}, dates, status, owner, progress],
            "views": [
                view("Gantt", "gantt", date_property=dates["id"], color_by=status["id"], zoom="week"),
                view("Table", "table", sort=[{"property": dates["id"], "direction": "asc"}]),
            ],
        }
        db = self.page(parent, "Season plan", key="season", position=position, icon="📅", kind="database",
                       schema=schema)

        def span(a: int, b: int) -> dict:
            return {"start": self.iso(a), "end": self.iso(b)}

        rows = [
            ("Plant the garlic", span(-8, -4), "Done", "Anna", 100),
            ("Apple harvest", span(-12, 8), "In progress", "Carla", 60),
            ("Deep clean of the hen house", span(-3, 1), "In progress", "Ben", 50),
            ("Muck out the barn", span(2, 4), "Not started", "Ben", 0),
            ("Press apple juice", span(6, 13), "Not started", "Carla", 0),
            ("Seed potato order goes out", self.iso(12), "Not started", "Anna", 0),
            ("Farm shop open day", self.iso(17), "Not started", "Anna", 0),
            ("Prune the orchard", span(30, 52), "Not started", "Carla", 0),
            ("Plan next year's vegetable beds", None, "Not started", "Anna", 0),
        ]
        for n, (title, when, st, person, pct) in enumerate(rows, 1):
            values = {status["id"]: st, owner["id"]: person, progress["id"]: pct}
            if when is not None:
                values[dates["id"]] = when
            self.page(db, title, position=n, props=values)

    # Farm shop: files, embeds, and a website waiting to happen --------------------------

    def shop(self, parent: str, position: float) -> None:
        cover = self.file(self.ids["shop"], "fields.svg")
        pdf = self.file(self.ids["shop"], "price-list.pdf")
        blocks = [
            node("paragraph", "Fresh eggs, apples and vegetables from Sunny Acre Farm, sold at the farm gate every "
                              "Friday and Saturday."),
            node("callout", "**This page is ready to be a website.** Choose **Publish** at the top, pick the "
                            "*Landing* template and a name: the cover and the first paragraph become the "
                            "front of the site, and the pages below become its cards. It is live at "
                            "`/v/` and the name right away, and on a domain of your own if you like.",
                 icon="🌐", color="blue_bg"),
            *md("""
                ## What we sell

                - **Eggs** from our own hens, collected every morning
                - **Apples and pears** from the orchard, and juice pressed in October
                - **Vegetables** from the kitchen garden, whatever is ripe
                - **Honey and jam**, while they last

                ## Opening hours

                | Day | Hours |
                | --- | --- |
                | Friday | 14:00 to 18:00 |
                | Saturday | 9:00 to 13:00 |
                | Any other day | Ring the bell, someone is usually around |

                ## Prices
                """),
            node("file", "This week's price list. Drop a PDF onto a page and it can be read right there.",
                 file_id=pdf.id, name=pdf.filename, size=pdf.size, content_type=pdf.content_type, preview=True),
            node("paragraph", "Card or cash. Bring your own egg boxes and get 10 cents back for each one."),
        ]
        shop = self.page(parent, "Farm shop", key="shop", position=position, icon="🏪", cover=f"file:{cover.id}",
                         blocks=blocks)
        self.page(shop, "Eggs", key="shop_eggs", position=1, icon="🥚", blocks=md("""
            Brown, white and dark brown eggs from our own hens, collected every morning and sold within the
            week. The hens run outside all day, and in winter they get a light in the hen house.

            | Box | Price |
            | --- | --- |
            | 6 eggs | 2.40 |
            | 10 eggs | 3.80 |
            """))
        self.page(shop, "Apples and juice", key="shop_apples", position=2, icon="🍎", blocks=md("""
            Topaz and Boskoop apples and Conference pears from our 48 trees, from September until the
            store runs out. The juice is pressed at the village press in October, cloudy and with
            nothing added.
            """))
        self.page(shop, "Find us", key="shop_find", position=3, icon="📍", blocks=[
            node("paragraph", "Take the farm track out of the village. We are the last gate on the left; park "
                              "by the barn."),
            node("embed", "", url="https://www.google.com/maps?q=Uckermark"),
            node("callout", "Paste a link to YouTube, Vimeo, Loom, Google Maps, CodePen or Figma on an empty "
                            "line and it can be embedded like this map.", icon="💡"),
        ])

    # Code, contacts, journal ------------------------------------------------------------------

    def coop(self, parent: str, position: float) -> None:
        blocks = [
            *md("""
                The hen house door opens by itself at sunrise and closes half an hour after sunset. A
                Raspberry Pi in the barn works out the times and drives a small motor. The code lives here,
                so that whoever fixes it next knows how it works.

                ## How it decides
                """),
            node("code", "flowchart LR\n"
                         "    A[Every minute] --> B{After sunrise?}\n"
                         "    B -- no --> C[Keep it closed]\n"
                         "    B -- yes --> D{Half an hour after sunset?}\n"
                         "    D -- no --> E[Open the door]\n"
                         "    D -- yes --> C",
                 language="mermaid"),
            node("callout", "Code is highlighted in over 30 languages. A code block in *mermaid* becomes a "
                            "diagram, like the one above.", icon="💡"),
            node("heading_2", "The script"),
            node("code", textwrap.dedent('''\
                from datetime import datetime, timedelta

                from astral import LocationInfo
                from astral.sun import sun

                FARM = LocationInfo("Sunny Acre", "Germany", "Europe/Berlin", 53.1, 13.9)
                CLOSE_AFTER_SUNSET = timedelta(minutes=30)


                def door_should_be_open(now: datetime) -> bool:
                    """Open from sunrise until half an hour after sunset."""
                    day = sun(FARM.observer, date=now.date(), tzinfo=FARM.timezone)
                    return day["sunrise"] <= now < day["sunset"] + CLOSE_AFTER_SUNSET'''), language="python"),
            *md("""
                ## Wiring

                | Pin | Goes to |
                | --- | --- |
                | GPIO 17 | Motor driver, IN1 |
                | GPIO 27 | Motor driver, IN2 |
                | GPIO 22 | Reed switch: the door is closed |
                | GND | Motor driver, GND |
                """),
            node("toggle", "If the door gets stuck", *md("""
                1. Check that the cord is not caught on the frame
                2. Switch the Pi off and on again, at the plug in the barn
                3. Open the door by hand and tell Ben
                """)),
        ]
        self.page(parent, "Coop door", key="coop", position=position, icon="🔧", blocks=blocks)

    def contacts(self, parent: str, position: float) -> None:
        role = prop("Role", "select", options=options(
            ("Vet", "red"), ("Feed", "yellow"), ("Customer", "blue"), ("Mechanic", "gray"), ("Beekeeper", "orange")))
        phone = prop("Phone", "phone")
        email = prop("Email", "email")
        web = prop("Website", "url")
        regular = prop("Regular", "checkbox")
        last = prop("Last order", "date")
        notes = prop("Notes", "text")
        schema = {
            "properties": [{"id": "title", "name": "Name", "type": "title"},
                           role, phone, email, web, regular, last, notes],
            "views": [
                view("Everyone", "table", widths={"title": 200, notes["id"]: 260}),
                view("By role", "board", group_by=role["id"], hidden=[notes["id"]]),
            ],
        }
        db = self.page(parent, "Contacts", key="contacts", position=position, icon="📇", kind="database",
                       schema=schema, options={"full_width": True, "small_text": True})
        rows = [
            ("Dr. Petra Vogel", "Vet", "+49 3984 555 0101", "practice@vet.example", "https://vet.example", True, -40,
             "Comes out to the farm. Call before 9."),
            ("Lindner feed store", "Feed", "+49 3984 555 0142", "orders@feed.example", "https://feed.example", True, -9,
             "Layer pellets, 25 kg bags"),
            ("Hotel am See", "Customer", "+49 3984 555 0177", "kitchen@hotel.example", "https://hotel.example", True, -3,
             "12 dozen eggs every Friday"),
            ("Jonas Brandt", "Mechanic", "+49 3984 555 0123", "jonas@garage.example", "", False, -120,
             "Services the tractor in winter"),
            ("Sommer beekeeping", "Beekeeper", "+49 3984 555 0160", "hello@bees.example", "https://bees.example", True,
             -60, "Honey for the shop; keeps six hives in the orchard"),
        ]
        for n, (name, r, tel, mail, url, reg, days, note) in enumerate(rows, 1):
            values = {role["id"]: r, phone["id"]: tel, email["id"]: mail, last["id"]: self.iso(days), notes["id"]: note}
            if url:
                values[web["id"]] = url
            if reg:
                values[regular["id"]] = True
            self.page(db, name, position=n, props=values)

    def journal(self, parent: str, position: float) -> None:
        def day(ago: int) -> date:
            return self.today - timedelta(days=ago)

        blocks = [
            node("paragraph", "A few lines at the end of the day. This page is set in a serif font: the `...` "
                              "menu of a page has the fonts, small text and full width.", color="gray"),
            node("heading_3", spoken(day(1))),
            node("paragraph", "First frost on the pumpkins this morning. Greta laid her first egg since the "
                              "moult, a dark brown one. The fox was seen by the pond, so the run gate stays shut."),
            node("heading_3", spoken(day(3))),
            node("paragraph", "Picked the Boskoop trees. Carla says two more weekends and the orchard is done, "
                              "then it is time to take the apples to the press."),
            node("heading_3", spoken(day(6))),
            node("paragraph", "Put up the new shop sign by the road. Three cars stopped before we had even "
                              "finished, and the eggs were gone by four."),
        ]
        self.page(parent, "Farm journal", key="journal", position=position, icon="📓", options={"font": "serif"},
                  blocks=blocks)
