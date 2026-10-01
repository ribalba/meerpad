<p align="center">
  <img src="app/static/img/logo.png" width="160" alt="meerpad logo" />
</p>

<h1 align="center">meerpad</h1>

<p align="center">Notes, docs and wikis that are yours. Offline first, open source.</p>

---

meerpad is a home for everything you write down, in the shape Notion made familiar: pages
made of **blocks**, pages inside pages as deep as you like, grouped into **workspaces** for
the parts of your life (Work, House, Farm). It keeps a copy of your pages in the browser, so
it opens and edits **without a network** and syncs when the network is back, and any page
can become a **website** at `meerpad.com/v/name` or on your own domain. It is hosted at
[meerpad.com](https://meerpad.com), and it is one `make up` away on your own machine.

**Features:** blocks like Notion (text, headings, lists, to-dos, toggles, quotes, callouts,
code, tables, images, files, bookmarks, embeds, equations) · grids, to put blocks side by
side in rows and columns · Markdown shortcuts as you type,
and inline Markdown in meerail's dialect · `/` for every block, `[[` to link a page · drag
handles · workspaces, each a page tree of its own · databases with table, board, list,
gallery and Gantt views · offline first, synced across devices, merged field by field · share links to
view or to edit · publish any page as a website, at `/v/<name>` or on your own domain · drag
files in, PDFs preview inline · paste a link to an image or PDF and keep a copy · import from
Notion, databases included · page history by editing session, with what each one changed ·
a desktop app with sign-in by deep link · light + dark.

It is one server and a browser app, the way meerato is:

- **`meerpad-server`**: FastAPI and PostgreSQL. The sync API, files, share links, the Notion
  importer, and every published website: one process answers for the app's own host and for
  every site's, told apart by the `Host` header.
- **The web app** (`app/static`): the editor, with an IndexedDB mirror of your pages and a
  queue of your edits, so it works offline and is quick online.
- **`electron/`**: the desktop shell, a window around the same web app.
- **`tools/notion_import.py`**: the Notion importer from the command line, against any
  meerpad server, with your API token.

[docs/DESIGN.md](docs/DESIGN.md) is the contract all of them code against: the data model,
the block types, the sync protocol and the HTTP API.

## Background

**Notion is where a lot of people's notes live, and none of it is theirs.** The format is
closed, the pages live on someone else's servers for as long as the company decides they
do, and the way out is an export zip that is only as useful as whatever reads it back in.

meerpad is the same way of working, in the open: AGPL-3.0, self-hostable with Docker and
PostgreSQL, hackable (a page is rows in three tables you can query), and part of the
[meer*](https://meerverse.com) family: meercal for calendars, meerail for mail, meerato for
tasks, meerpic for photos. It borrows from its siblings on purpose: meerato's email sign-in,
local-first sync and hosting; meerail's Markdown dialect; meerpic's build and layout.

**Offline first, not offline-capable.** The browser keeps a full mirror of your pages in
IndexedDB and edits that; the server is where the mirror syncs to, not what the editor waits
for. A change is a mutation in a local queue, pushed when there is a network. The server
merges **per field**: your phone retitling a page and your laptop editing its icon both
survive, where a per-row merge would drop one of them.

**Notion's export, read back in.** Notion's "Markdown & CSV" export is the one way out of
Notion that keeps everything, and meerpad reads all of it: the page tree, the databases with
their rows and properties, the attachments, and the links between pages, rewritten to point
at the imported pages.

## Using it

### Workspaces and pages

A **workspace** is a page tree of its own: Work, House, Farm. The sidebar shows the tree;
opening a workspace opens its root page. A new account starts with the workspaces in
`DEFAULT_WORKSPACES` (Work and Private by default). Moving a page to another workspace
moves everything under it. Deleting puts a page and its subtree in the trash, from which it
can be restored until the trash is emptied.

On its first start, a new account is offered a **demo workspace**: Sunny Acre Farm, a
made-up farm with a page for each part of meerpad. It has a tour, every kind of block,
databases as a board, a gallery and a Gantt chart, files, code and a diagram, and a shop page
ready to publish. It is an ordinary workspace, so delete it when you are done. Settings,
Workspaces adds it again at any time.

### Blocks

A page is a list of blocks, and blocks nest (list items under list items, content inside a
toggle). `/` opens the menu of all of them; each has a **drag handle** to move it, and
`Tab` / `Shift+Tab` nest and un-nest it under the block above.

At the start of a block, Markdown turns into the block as you type:

| Type | For |
| --- | --- |
| `# `, `## `, `### ` | Heading 1, 2, 3 |
| `- ` | Bulleted list |
| `1. ` | Numbered list |
| `[] ` | To-do |
| `> ` | Quote |
| `>> ` | Toggle |
| `!> ` | Callout |
| ```` ``` ```` then `Enter` | Code block (```` ```py ```` sets the language) |
| `---` | Divider |
| `/` | The block menu: callouts, toggles, tables, images, files, embeds, equations, grids, databases, and all of the above |
| `[[` | Link to a page, by its title |

Inside a block, text is Markdown in **meerail's dialect**: `**bold**`, `*italic*` or
`_italic_`, `~~strike~~`, `` `code` ``, `==highlight==`, `[text](url)`, and bare URLs.
Emphasis needs a word boundary, so `snake_case` stays literal.

| Keys | |
| --- | --- |
| `Ctrl+S` (or `Ctrl+K`, `Ctrl+P`) | Search |
| `Ctrl+N` in the desktop app, `Ctrl+Alt+N` in a browser | New page |
| `Ctrl+B`, `Ctrl+I` | Bold, italic |
| `Ctrl+E` | Inline code |
| `Ctrl+Shift+S`, `Ctrl+Shift+H` | Strikethrough, highlight |
| `Ctrl+K` | Link |
| `Esc` | Back to the page list (see below) |
| `Shift+↑`, `Shift+↓` at a block's edge | Select blocks (`Ctrl+C` copies them as Markdown, `Backspace` deletes) |
| `Ctrl+D` | Duplicate the block |
| `Tab`, `Shift+Tab` | Nest, un-nest |
| `Shift+Enter` | A line break inside the block |

(`Cmd` instead of `Ctrl` on macOS.)

The whole app works from the keyboard. It opens with the focus on the page list in the
sidebar: `↑`/`↓` (or `j`/`k`) move through it, `→`/`←` open and close a branch, `Enter`
opens the page and puts the cursor in it (back where it was the last time), `Space` shows the
page but stays in the list, and `Esc` from anywhere in the page comes back to the list.

A whole page can also be edited as one Markdown document, meerail's editor with the
markers in view: **Edit as Markdown** in the page's `...` menu. Leaving it turns the text
back into blocks and keeps the ones you did not change exactly as they were, so links to
them keep working.

A **grid** puts blocks next to each other: a picture beside its text, three columns of
notes. `/2 columns`, `/3 columns` or `/grid` make one. Each cell holds any blocks, typed
into or dragged in by their handle. Hovering a grid shows a `+` along its right edge for
another column and along its bottom for another row, and a cell's `...` inserts or deletes
a column or a row where it is (up to 6 columns). On a phone the cells stack.

### Files

Drag a file onto a page: images show in place, PDFs preview inline, anything else becomes a
file block to download. Paste a link to an image or a PDF and meerpad offers to fetch it
into the page, so the page keeps it when the original disappears. The server does the
fetching and refuses addresses on its own network (`app/fetcher.py`).

### Databases

A database is a page whose rows are pages. Its properties are text, number, select,
multi-select, status, date, checkbox, URL, email, phone, person, files, and the computed
created and last-edited times. Each **view** of it is a table, a board (grouped by a
property), a list, a gallery or a **Gantt chart** (rows as bars on a timeline: drag a bar to
move it, drag an end to stretch it, colour by status), with its own filters, sort order and
hidden columns. Every row opens as a page with room for notes, and a database can be shown
inline on another page. "Gantt chart" in the `/` menu and the sidebar's `+` menu creates a
project plan ready to fill in (Task, Dates, Status, Owner, Progress).

### Page history

"Page history" in a page's `…` menu lists its editing sessions, newest first. Edits a few
minutes apart are one session; ten quiet minutes, or an hour of editing, end it. Each
session shows what it changed against the one before: blocks added, removed, rewritten
(word by word) or moved, and the title, icon, cover and properties. Any two sessions can be
compared, and any one shown as the page looked when it ended. Edits through an edit link
count too, and say so.

### Sharing

From a page's share dialog, a **view link** lets anyone read that page and every page below
it, without an account; an **edit link** lets them change it too. Either can be turned off
or rotated (the old link stops working). A subpage of a shared page shows that it is shared
through its parent.

### Publishing

Any page, and every page below it, can be published as a **website**. It is served at
`https://meerpad.com/v/<name>` right away, where you pick the name (the publish dialog checks
that it is still free as you type), and at a custom domain once that domain's A record
points at the server (the publish dialog shows the address). Four templates: `minimal`,
`docs` (with a sidebar), `blog` (the root lists its subpages as posts) and `landing` (a hero
from the cover and title). Subpages get paths from their titles (`/v/farm/chickens/breeds`),
and each site serves a `sitemap.xml`. A site you switch off stays visible at its `/v/`
address to you only, as a preview.

On a server of your own, `/v/` addresses need nothing; a custom domain is a proxy matter:
[COOLIFY.md](COOLIFY.md#6-published-websites) has it.

### Importing from Notion

In Notion: **Export**, from a page's `...` menu or from Settings for a whole workspace,
format **Markdown & CSV**, subpages included. In meerpad: the import dialog, the zip, and
the workspace (and page) to import under. The import runs in the
background and shows its progress; large ones are committed in batches.

Or from a checkout, with your API token (the app's settings):

```bash
make import SRC=~/Downloads/Export.zip WORKSPACE=Farm \
  BASE_URL=https://meerpad.com MEERPAD_TOKEN=...
```

which runs `tools/notion_import.py` against that server. What comes across: pages and
subpages, databases (the CSV) with their rows as pages and their properties, images and
attachments as files, `<aside>` blocks as callouts, Markdown tables as table blocks, and
links between exported pages, rewritten to the imported ones.

## Install

```bash
git clone https://github.com/ribalba/meerpad
cd meerpad
make up          # postgres + server  ->  http://127.0.0.1:8050
```

`make up` writes `.env` from `.env.example` the first time; nothing in it needs changing on
a laptop. Sign in with any address: without `SMTP_HOST` the sign-in link and code are
printed to the server log instead of mailed.

```bash
make logs        # the server's log, sign-in mails included
make psql        # a shell on the database
make down        # stop it
```

Postgres listens on `127.0.0.1:5435` and the app on `127.0.0.1:8050`, beside meerail (5432,
8000), meercal (5433, 8010) and meerpic (5434, 8040). Keep `MEERPAD_BIND=127.0.0.1` unless
there is a TLS proxy in front.

## Deploying on Coolify

`docker-compose.coolify.yml` is the whole stack as one Coolify resource: no host ports,
TLS at Coolify's Traefik, the database password and secret key generated by Coolify,
`BASE_URL` required. [COOLIFY.md](COOLIFY.md) walks the deploy. Published sites need
nothing extra (they are paths, `/v/<name>`); a custom domain for one is its A record, then
the domain added to the service's Domains.

## Configuration

Environment variables, from `.env` or the process environment (`app/config.py`). Every one
is optional on a laptop; [.env.example](.env.example) explains each.

| Variable | Default | |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8050` | The app's public address. Login links are built from it, and any other `Host` is looked up as a published site. |
| `SECRET_KEY` | `dev-insecure-secret-change-me` | Signs login codes. **Change it** anywhere but a laptop. |
| `DATABASE_URL` | `postgresql+psycopg://meerpad:meerpad@localhost:5435/meerpad` | psycopg 3. Compose sets it to its `db` service. |
| `UPLOAD_DIR`, `IMPORT_DIR` | `data/uploads`, `data/imports` | `/data/...` in the container, on the `meerpad-data` volume. |
| `MAX_UPLOAD_BYTES` | 52428800 (50 MB) | Largest file dropped into a page. |
| `MAX_IMPORT_BYTES` | 4294967296 (4 GB) | Largest Notion export. |
| `DEFAULT_WORKSPACES` | `Work,Private` | A new account's workspaces. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_USE_TLS` | empty, 587, empty, empty, true | Empty host: mails go to the log. |
| `EMAIL_FROM` | `hello@meerpad.com` | |
| `LOGIN_TOKEN_TTL_MINUTES`, `SESSION_TTL_MINUTES` | 30, 43200 (30 days) | |
| `LOGIN_CODE_MAX_ATTEMPTS`, `LOGIN_RATE_MAX`, `VERIFY_RATE_MAX`, `LOGIN_RATE_WINDOW_MINUTES` | 5, 5, 15, 15 | meerato's sign-in limits. |
| `PUBLIC_IP` | empty | Shown in the publish dialog as the custom-domain A record. Never checked. |
| `FETCH_ALLOW_PRIVATE` | false | Let "fetch this pasted link" reach private addresses. Development only. |
| `FETCH_TIMEOUT_SECONDS` | 20 | |
| `HISTORY_IDLE_MINUTES`, `HISTORY_MAX_SESSION_MINUTES` | 10, 60 | A page's editing session ends after this long without an edit, or at this age. |
| `HISTORY_KEEP_SESSIONS` | 200 | Finished sessions kept per page; older ones are dropped. |

Container topology, read by compose only: `MEERPAD_BIND` / `MEERPAD_PORT` (127.0.0.1, 8050),
`MEERPAD_DB_PORT` (5435), `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`
(`meerpad`).

## Architecture

```text
  browser tab or desktop window                 meerpad-server (FastAPI)          PostgreSQL
 ┌──────────────────────────────────┐          ┌─────────────────────────┐      ┌──────────────┐
 │ editor                           │          │                         │      │ workspaces   │
 │   │ reads and writes             │          │ POST /api/sync/push     │      │ pages        │
 │   ▼                              │  push    │   per field: newest     │ ───▶ │ blocks       │
 │ IndexedDB mirror ─▶ mutation ────┼────────▶ │   write wins, each row  │      │   rev, clock │
 │   ▲                 queue        │          │   written gets rev + 1  │      │ sync_state   │
 │   │                              │  pull    │                         │      │   rev        │
 │   └── merge: pulled row, then ◀──┼───────── │ GET /api/sync/pull      │ ◀─── │ files, sites │
 │       queued edits on top        │ ?cursor= │   every row with        │      │ imports ...  │
 └──────────────────────────────────┘   rev    │   rev > cursor          │      └──────────────┘
                                               │                         │
  meerpad.com/v/farm, eggs.example.org ──────▶ │ /v/<name>, or any other │ ───▶ /data/uploads
  (published websites)                         │   Host: app/sites.py    │
                                               └─────────────────────────┘
```

- **The mirror is the source of truth for the editor.** Every edit is applied to IndexedDB
  and appended to a queue of mutations (`{entity, action, id, updated_at, data}` with only the
  changed fields). The queue is pushed when there is a network; a mutation the server refuses
  three times is parked rather than retried forever.
- **Per-field last-write-wins.** Each row keeps a `clock` of when each field was last
  written. A pushed field is applied if nothing newer has been written to that field, so two
  devices editing different fields of one page both win. Client clocks more than five minutes
  ahead are clamped to the server's.
- **A revision counter, not timestamps.** Every write stamps the row with the next value of
  one global `rev`. A pull asks for everything above the cursor it last saw, deleted rows
  included, page by page; a server whose counter is behind the client's cursor (a restored
  database) answers `reset` and the client pulls from zero.
- **Ordering** is a float `position` between neighbours, renumbered when gaps get too small.
- **Share links** speak the same protocol, scoped to the shared subtree, from an in-memory
  store: nothing is kept in a visitor's browser.
- **Published sites** are rendered on the server from the same rows (Jinja templates in
  `app/templates/sites/`), so an edit is live on the site as soon as it has synced.

[docs/DESIGN.md](docs/DESIGN.md) has the whole contract.

## Development

```bash
make venv                  # .venv with the server's dependencies, pytest, httpx and ruff
make dev                   # postgres in Docker, uvicorn --reload natively on :8050
make test-db && make test  # the suite, against a throwaway database (meerpad_test)
make lint                  # ruff over app, tests and tools
make images                # meerpad-server:<VERSION>
```

`make dev` needs port 8050, so `make down` a running stack first; the Docker equivalent is
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`, which mounts
`app/` into the container and reloads on :8051.

The tests run against real PostgreSQL, never SQLite, because row locks, JSONB and the
revision counter are what they test. Without `MEERPAD_TEST_DB` the database tests skip, so a
bare `pytest` still runs the rest. CI (`.github/workflows/tests.yml`) provides a Postgres 18
so that nothing skips there.

## The desktop app

`electron/` is a thin Electron window around the web app, meerato's shape: its own
persistent login (separate from your browser), outbound links and published sites in the
system browser, Back and Forward, spelling suggestions, and a retry screen for a first start
with no network. Offline is the web app's own: once loaded, the window opens without a
network.

Sign-in is by deep link. In the shell the page asks for its sign-in email with
`client: "desktop"`, the server mails a `meerpad://login?token=...` link, and clicking it
finishes sign-in **inside the window** instead of in your browser. The code in the same mail
works too.

```bash
make desktop                              # against the local server
cd electron && npm install && npm start   # against https://meerpad.com
cd electron && make distinstall           # build and register it with the desktop
```

[electron/README.md](electron/README.md) has the details.

## License

AGPL-3.0. See [LICENSE](LICENSE).
