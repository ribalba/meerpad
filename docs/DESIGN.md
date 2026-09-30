# meerpad design

The contract every part of meerpad codes against: the data model, the block
types, database pages, the sync protocol, and the HTTP API. If code and this
file disagree, one of them is a bug.

## 1. The document model

Notion's model.

- A **workspace** ("Work", "House", "Farm") owns exactly one **root page**:
  `workspace.root_page_id`. The root page is the only page with
  `parent_id = null`. Opening the workspace opens its root page.
- Every other **page** has a parent page in the same workspace. The sidebar is
  this tree. Moving a page to another workspace moves its whole subtree; the
  server cascades `workspace_id`.
- A page's content is a tree of **blocks**. Top-level blocks have
  `parent_id = null`; nested blocks (list children, toggle content) name their
  parent block. Siblings are ordered by `position` (a float; see §6).
- A **database** is a page with `kind = "database"` and a `schema`. Its rows
  are its child pages. Row pages hold their property values in `props` and
  have ordinary block content too. Rows are not shown in the sidebar tree.
- Deleting is soft. `deleted = true` puts a page in the trash, and its
  subtree is hidden with it. Restoring means setting `deleted = false`.
  Emptying the trash (`DELETE /api/pages/{id}`) leaves tombstones:
  `options.purged = true`, content emptied. Clients drop purged pages and
  their blocks.

### Row fields (as the client stores them; `app/serialize.py`)

```
workspace { id, name, icon, position, root_page_id, deleted, created_at, updated_at, rev }
page      { id, workspace_id, parent_id, kind, title, icon, cover, position,
            props, schema, options, favorite, share_token, edit_token,
            deleted, deleted_at, created_at, updated_at, last_edited_by, rev }
block     { id, page_id, parent_id, type, text, props, position, deleted,
            created_at, updated_at, rev }
```

- `page.icon`: an emoji (`"🐔"`), `"file:<file_id>"`, or an http(s) URL.
- `workspace.icon` (at most 200 characters) and its root page's `icon` are
  one icon to the reader: the owner's client writes both whenever either
  changes (`app.store.js`), and shows the root page's when the workspace has
  none (older data, or an icon too long for the workspace).
- `page.cover`: `"file:<file_id>"`, an http(s) URL, or `"gradient:<0-7>"`.
- `page.options`: `{ full_width: bool, font: "sans"|"serif"|"mono", small_text: bool, purged: bool }`.
- `share_token` and `edit_token` are server-issued (§8). Share-link visitors
  never receive them, nor `favorite`.

## 2. Block types

`text` is **inline Markdown** in meerail's dialect (§3) for every text-bearing
block. For `code` blocks it is raw source. For media it is the caption.
`props` carries the rest. Unknown props must be preserved when a client
edits a block.

| type | text | props |
|---|---|---|
| `paragraph` | inline md | `color?` |
| `heading_1` / `heading_2` / `heading_3` | inline md | `color?` |
| `bulleted_list` | inline md | nested items are child blocks |
| `numbered_list` | inline md | numbering is computed from consecutive siblings |
| `to_do` | inline md | `checked: bool` |
| `toggle` | inline md | content is child blocks; open or closed is local UI state |
| `quote` | inline md | `color?` |
| `callout` | inline md | `icon: emoji` (default 💡), `color?` |
| `code` | raw source | `language: string` (`"plain"`, `"python"`, `"mermaid"`, …) |
| `divider` | "" | |
| `image` | caption | `file_id?` or `url?`, `width?` (px), `name?` |
| `file` | caption | `file_id?` or `url?`, `name`, `size?`, `content_type?`. PDFs preview inline |
| `bookmark` | caption | `url`, `title?`, `description?` |
| `embed` | caption | `url` (YouTube/Vimeo/… rendered as an iframe on an allow-list) |
| `table` | "" | `rows: string[][]` (cells are inline md), `header_row: bool`, `header_col: bool` |
| `page` | "" | `page_id`: a link card to a page (a child page, or any page) |
| `database` | "" | `page_id`: an inline database view of that database page; `view_id?` |
| `equation` | TeX source | |

`color` is one of `gray brown orange yellow green blue purple pink red`, or
the same name with `_bg` for a background (`yellow_bg`).

A file reference `file_id` resolves to `/api/files/<file_id>`. A share-link
visitor appends `?share=<token>`, and a published site serves files as
`/_files/<file_id>/<name>`.

## 3. Inline Markdown (meerail's dialect)

This is the grammar of `app/static/js/app.markdown.js`, which is copied from
meerail. The Python side (`app/mdblocks.py`) must render the same way.

- `` `code` `` is matched first, and nothing inside it is Markdown.
- `**bold**`, `~~strike~~`, `*em*` and `_em_`. Emphasis needs a word
  boundary, so `snake_case` and `*.txt` stay literal.
- `[text](url)` and bare `https://…` URLs.
- `==highlight==` is a meerpad addition.
- **Internal links:** `[Title](/p/<page_id>)`. In the app they navigate. A
  share view rewrites them within its tree. A published site maps them to
  that page's path, or to plain text if the page is not part of the site.
- `\n` inside a block's text is a soft line break (Shift+Enter).

Links only ever allow `http:`, `https:`, `mailto:` and `/p/`. Anything else
renders as `#`.

## 4. Database pages

`page.schema` is `{ "properties": [...], "views": [...] }`.

```
property { id: "title" | "p_<random>", name, type, options?: [{ id, name, color }], number_format? }
type ∈ title text number select multi_select status date checkbox url email phone person files
       created_time last_edited_time
view     { id, name, type: "table"|"board"|"list"|"gallery"|"gantt",
           sort?: [{ property, direction: "asc"|"desc" }],
           filter?: [{ property, op, value }],      // op: contains, eq, neq, empty, not_empty, checked, unchecked
           group_by?: property_id,                   // board
           date_property?: property_id,              // gantt: a date property; default the first one
           end_property?: property_id,               // gantt: a second date property for the end
           color_by?: property_id | null,            // gantt: a select or status property
           zoom?: "day"|"week"|"month",              // gantt: default "week"
           hidden?: [property_id], widths?: { property_id: px }, order?: [property_id] }
```

- Exactly one property has `id: "title"` and `type: "title"`. Its value is
  the row page's `title`, not a `props` entry.
- Row values live in `row.props[property_id]`:
  - `text`, `url`, `email`, `phone`, `person`: string
  - `number`: number
  - `checkbox`: bool
  - `select` and `status`: option **name** (string)
  - `multi_select`: list of names
  - `date`: `"YYYY-MM-DD"`, `"YYYY-MM-DDTHH:MM"`, or `{ start, end }`
  - `files`: list of `{ file_id?, url?, name }`
  - `created_time` and `last_edited_time` are computed from the row and
    never stored.
- Rows sort by `position` unless the view sorts.

### Gantt views

- A `gantt` view draws each row as a bar over whole days, start and end
  included.
  - The start is the `date_property` value's start. The end is that value's
    `end`, or, when `end_property` is set, that property's date.
  - A row with a start and no end is a milestone.
  - An end before the start is read the other way round.
  - Rows without a start are listed under "No dates".
- `color_by` names a select or status property, and a bar takes its option's
  colour; `null` or absent means the accent colour. `zoom` is the scale the
  view opens at. A read-only viewer may zoom without writing the view.
- Moving or stretching a bar writes a whole new `props` object.
  - A `{ start, end }` range stays a range, a single date stays a single
    date, and a time of day stays with its date.
  - A row given dates in the chart gets a `{ start, end }` range, or a start
    and an end date when `end_property` is set.
- The "Gantt chart" preset (`App.database.ganttSchema()`, from the `/` menu
  and the sidebar's "+" menu) has Task (title), Dates (date), Status
  (status), Owner (person) and Progress (number, `percent`). Its views are a
  Gantt (`date_property` = Dates, `color_by` = Status, `zoom` = "week") and a
  Table.
- A published site renders a database whose displayed view is a `gantt` as a
  static timeline of whole months. The displayed view is the one the block
  names, else the database's first view. With no dated row, the site shows
  the table.

## 5. Sync protocol

meerato's local-first model, with two changes. Conflicts resolve **per field**
rather than per row. And pulls go by a **server revision counter**, not by
client timestamps.

### Push: `POST /api/sync/push`

```
{ "mutations": [ { op_id, entity: "workspace"|"page"|"block",
                   action: "upsert"|"delete",   // "create"/"update" = upsert
                   id, updated_at: <client ISO time>, data: { <fields> } } ] }
→ { "results": [ { op_id, status: "applied"|"stale"|"skipped"|"error", detail } ] }
```

- `data` carries only the changed fields. The writable fields are:
  - workspace: `name`, `icon`, `position`, `root_page_id`, `deleted`
  - page: `workspace_id`, `parent_id`, `kind`, `title`, `icon`, `cover`,
    `position`, `props`, `schema`, `options`, `favorite`, `deleted`
  - block: `page_id`, `parent_id`, `type`, `text`, `props`, `position`,
    `deleted`
- Each field is written if its last write (`clock[field]`) is not newer than
  `updated_at`. `stale` means nothing was newer, so nothing changed.
- A client clock more than 5 minutes ahead is clamped to server time.
- `props`, `schema` and `options` are replaced whole. Send the full object.
- Creating a page needs `parent_id`, or `parent_id: null` for the workspace's
  root page. Creating a block needs `page_id`. A move is checked for cycles.
- `error` means the server refused the mutation. The client parks it after 3
  refusals (meerato's `MAX_PUSH_ATTEMPTS`).

### Pull: `GET /api/sync/pull?cursor=<rev>&limit=5000`

```
→ { cursor, has_more, reset, server_time, workspaces: [...], pages: [...], blocks: [...] }
```

- The response holds every row the account owns with `rev > cursor`,
  deleted rows included. Keep pulling while `has_more` is true.
- `reset: true` means the server's counter is behind the client's cursor
  (the database was rebuilt). Clear the local mirror and pull from 0.
- Merge rule: a pulled row replaces the local row, then any local mutations
  still queued for that row are re-applied on top.

### Share-link sync

`/api/share/<token>/pull` and `/api/share/<token>/push` (the latter needs an
edit link) speak the same protocol, scoped to the shared page's subtree. The
pull also returns:

- `scope_page_ids`: the complete live set, so the client can prune pages that
  left the tree
- `root_page_id`
- `mode`

An edit link cannot touch workspaces, cannot change `workspace_id` or
`favorite`, and cannot move or delete the shared page itself.

## 6. Ordering

`position` is a float. Insert between neighbours at `(a + b) / 2`. At the
ends use `last + 1` or `first - 1`. When a gap falls below `1e-6`, the client
renumbers that sibling list `1, 2, 3, …`, which is ordinary block and page
mutations.

## 7. HTTP API

### Auth (meerato's)

- `POST /api/auth/login {email, client?, next?}`
- `POST /api/auth/verify-code {email, code}`
- `GET /api/auth/callback?token=`
- `GET/PATCH /api/auth/me`
  - `welcomed_at` is null until the account answers the first-run welcome,
    which offers the demo workspace (below). The app asks once, after its
    first pull. `PATCH {welcomed: true}` records "start empty"; `false`
    asks again. Accounts that existed before the welcome count as welcomed.
- `POST /api/auth/api-token`
- `POST /api/auth/api-token/rotate`
- `POST /api/auth/logout`

### Pages

- `GET /api/pages/{id}/share` and `POST /api/pages/{id}/share {kind: "view"|"edit", enabled, rotate?}`
  return `{page_id, share_token, edit_token, share_url, edit_url, inherited_from}`.
- `DELETE /api/pages/{id}` purges a page that is already in the trash,
  together with its subtree, and its history.
- `GET /api/pages/{id}/markdown` returns the page as Markdown.

### Page history (§11)

- `GET /api/pages/{id}/history` returns
  `{page_id, idle_minutes, max_session_minutes, sessions: [session, ...]}`,
  newest first.
- `GET /api/pages/{id}/history/{session_id}` returns `{session, snapshot}`: the
  page as that session left it.
- `GET /api/pages/{id}/history/{session_id}/diff[?against=<session_id>]`
  returns `{from, to, diff}`.

### Files

- `POST /api/files` (multipart `file`, `page_id?`) returns
  `{id, filename, content_type, size, url}`.
- `GET /api/files/{id}[/{name}][?share=<token>][&download=1]`
- `GET /api/files/probe?url=` returns
  `{ok, url, kind: image|pdf|video|audio|file|html|unknown, content_type, filename, size, detail}`.
- `POST /api/files/fetch {url, page_id?}` has the server download the URL
  (SSRF-guarded, `app/fetcher.py`) and returns the same shape as an upload.

### Share

- `GET /api/share/{token}` returns
  `{mode, root_page_id, title, icon, owner_name, signed_in}`.
- `GET /api/share/{token}/pull` and `POST /api/share/{token}/push`
- HTML entry points are `/s/{token}` and `/s/{token}/{page_id}`.

### Publish (§9)

- `GET /api/sites/templates` returns `[{id, name, description}]`.
- `GET /api/sites` returns the account's sites.
- `GET /api/sites/check?slug=&domain=&page_id=` returns
  `{slug_ok, domain_ok, detail, base_url, public_ip, suggestion?}`: whether the
  name and the domain are free. `suggestion` (a free name from the page title)
  only comes with `page_id`.
- `GET /api/pages/{id}/site` returns the site, or 404 when the page is not
  published.
- `PUT /api/pages/{id}/site {slug, custom_domain?, template, enabled, options}`
  returns the site.
- `DELETE /api/pages/{id}/site`
- The site object:
  `{id, page_id, slug, custom_domain, template, enabled, options, url, custom_url, preview_url, dns: {type: "A", name, value}}`
  (`url` is `<BASE_URL>/v/<slug>`; `preview_url` is the same path, where a
  switched-off site stays visible to its owner)

### Import (§10)

- `POST /api/import/notion` (multipart `file` = the export zip, `workspace_id`,
  `parent_page_id?`) returns the import. It accepts the session cookie or
  `?token=<api token>`.
  - `workspace_id` may be a workspace id or its name, matched
    case-insensitively.
  - Both fields may also come as query parameters (`workspace`, `parent`).
  - A second concurrent import for the same user gets 409.
- `GET /api/import/{id}` returns
  `{id, status: queued|running|done|error, stats, error, source_name, parent_page_id, workspace_id, created_at, finished_at}`.
  - `stats` holds `pages`, `databases`, `rows`, `blocks`, `files` and
    `warnings`.
  - While the import runs, `stats` also holds `phase`, `done` and `total`.
- `GET /api/import` lists the 20 most recent imports.

### Demo workspace

- `POST /api/demo` adds the demo workspace to the account and returns
  `{workspace_id, root_page_id}`. It also sets `welcomed_at`.
  - The demo is Sunny Acre Farm (`app/demo`): pages that use every block
    type, property type and view type above, with their files. Its dates
    count from the day it is added.
  - The rows are ordinary synced rows with an empty `clock`, so any edit
    from a device wins. They reach the account's devices on the next pull.
  - It publishes no site and turns on no share link.
  - Each call adds another copy.

## 8. Sharing

A page's `share_token` link lets anyone view the page and every live page
below it. Its `edit_token` link also lets them edit there. Both links are
served by `share.html`, which runs the same editor on an in-memory store
(nothing is persisted in the visitor's browser). The owner turns links on
and off, or rotates them, from the share dialog. A subpage of a shared page
reports `inherited_from`.

## 9. Published websites

- A page published as a site serves that page and its live subpages,
  including database rows as pages.
- It is reachable at:
  - `<BASE_URL>/v/<slug>`, where the owner picks the slug (lowercase letters,
    digits and inner dashes, unique). A path, not a subdomain, so it needs no
    DNS or proxy setup. A switched-off site answers there for its owner only,
    as a preview (not cached, not indexed).
  - an optional custom domain whose A record points at the server, once that
    domain is also added to the Coolify service
- Requests for a host other than the app's are handled in `app/sites.py`
  (`dispatch(request, host)`); `/v/<slug>/…` is `routers/publish.py`.
- **Paths** (below `/v/<slug>` on the app host, from `/` on a custom domain):
  - the site root is `/`
  - subpages use slug paths built from titles (`/chickens/breeds`), unique
    within the site
  - files are served at `/_files/<file_id>/<name>`
  - the site also serves `/sitemap.xml` and `/robots.txt`
- **Templates** (`app/templates/sites/<id>/`): `minimal`, `docs` (sidebar
  navigation), `blog` (the root lists its subpages as posts), and `landing`
  (hero from cover and title).

## 10. Notion import

Notion's "Markdown & CSV" export, as a zip (nested zips included) or a
folder.

- A page is `Title <32 hex>.md`, and its subpages sit in the sibling folder
  `Title/`.
- A database is `Title <id>.csv` or `Title <id>_all.csv`, with its row pages
  in `Title/`. A row page starts with `Key: value` lines that match the CSV
  header.
- Images and files are relative links and are uploaded as files.
- Links between exported pages become `/p/<new id>` links.
- `<aside>` becomes a callout.
- Markdown tables become `table` blocks.
- Each import lands under one parent page, normally the workspace root. The
  job runs in the background and commits in batches.

## 11. Page history

Edits to a page are grouped into **sessions**, and the page is kept as each
session left it, so its history shows what every session changed
(`app/history.py`).

- An edit is a write through sync (§5) that changes a value of the page's
  `title`, `icon`, `cover`, `kind`, `props`, `schema` or `options`, or any
  field of one of its blocks. Moving, reordering, favouriting and trashing the
  page itself are not edits of it. A block moved to another page is an edit of
  both pages. Edit-link visitors' edits count too.
- A session ends after `HISTORY_IDLE_MINUTES` (10) without an edit, or once it
  is `HISTORY_MAX_SESSION_MINUTES` (60) old. The next edit starts a new one.
  Times are the server's: offline edits land in the session they sync in.
- A page has at most one open session, its newest. Its end state is the live
  page. It is snapshotted when the next session starts, before that session's
  first edit is written. A session whose snapshot equals the one before it is
  dropped then.
- A page edited before its history began gets a **baseline**: the page as it
  was, kept as the version its first session is compared with. After the
  newest `HISTORY_KEEP_SESSIONS` (200) finished sessions, older ones are
  dropped, and the oldest one kept becomes the baseline.
- History is the owner's alone: share-link visitors never read it. Emptying
  the trash deletes it with the page.

```
session  { id, started_at, ended_at, editors: [email | "Someone with the edit link"],
           baseline, current, active, stats: {added, removed, changed, moved, page} | null }
snapshot { page: { title, icon, cover, kind, props, schema, options },
           blocks: [ { id, parent_id, type, text, props, position, depth } ] }
diff     { page: [page_change], blocks: [block_entry], stats }
```

- `current`: the newest session, whose end state is the live page. `active`:
  an edit now would still join it. `stats` counts the changes against the
  session before it; it is null for a baseline.
- `snapshot.blocks` hold the live blocks in document order (depth first,
  siblings by `position`), with their nesting `depth`. A block under a missing
  parent is left out, as in the editor.
- A diff reads from `from` (the older side) to `to` (the newer). Without
  `against`, `from` is the session before; with it, the two are put in time
  order. `from: null` compares with an empty page, which is what the first
  session of a page made in it, and a baseline, get.
- `page_change` is one of:
  - `{field: "title", from, to, segments}`
  - `{field: "icon" | "cover" | "kind", from, to}`
  - `{field: "props", changes: [{key, from, to}]}` (database row values,
    keyed by property id)
  - `{field: "schema", changes: [{kind: "property" | "view", change: "added" |
    "removed" | "renamed" | "changed", id, name, from?, to?}]}`
  - `{field: "options", changes: [{key: "full_width" | "font" | "small_text",
    from, to}]}`
  - Empty values (`null`, `""`, `false`, `[]`, `{}`) and an absent key read
    the same.
- `block_entry` is `{id, type, depth, status, moved, text, props, old,
  segments}`, in the newer version's document order with each removed block
  where it was:
  - `status` is `same`, `added`, `removed`, or `changed` (type, text or props
    differ).
  - `text` and `props` are the block as it is in `to` (a removed block: as it
    was).
  - `old` is `{type, text, props}` from `from`, for `changed` only.
  - `moved` means the block changed parent or left its place among the
    others. A block that only travels along with its parent is not moved.
  - `segments` is the word-level text diff, when the text changed:
    `[{op: "same" | "added" | "removed", text}]`.
- A database's history covers its schema. Its rows are pages with histories
  of their own.
