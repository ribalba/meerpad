/* The document store: every workspace, page and block, in memory.

   The single place the UI reads from and writes through. Reads are synchronous
   (the whole account is loaded from IndexedDB at boot: a few thousand pages and
   tens of thousands of blocks are a few MB). Writes update memory at once, then
   go to IndexedDB and the sync queue (App.sync.mutate) in the background, so
   the editor never waits on storage.

   Change notifications are batched per microtask and go out on the bus as
   "store:change" with the ids touched and where the change came from:
     { workspaces: Set, pages: Set, blocks: Set, source: "local" | "remote" | "undo" }

   Undo/redo lives here too, because it has to cover every kind of write: each
   write records the fields it replaced, and undoing a step writes them back
   (as ordinary, synced writes). Writes made in the same task form one step;
   consecutive text edits to one block within a moment of each other merge. */

window.App = window.App || {};

App.store = (() => {
  const maps = { workspace: new Map(), page: new Map(), block: new Map() };
  const STORE_NAME = { workspace: "workspaces", page: "pages", block: "blocks" };
  // Indices, rebuilt incrementally on every write.
  const childPages = new Map();   // parent page id -> Set(page id)
  const pageBlocks = new Map();   // page id -> Set(block id), all depths
  const childBlocks = new Map();  // parent block id | "page:<id>" -> Set(block id)

  let readOnly = false;
  const state = { mode: "owner", me: null, shareRootId: null };

  // --- change notification ---------------------------------------------------
  let pending = null;
  function touched(kind, id, source) {
    if (!pending) {
      pending = {};
      queueMicrotask(() => {
        const batches = pending;
        pending = null;
        for (const [src, sets] of Object.entries(batches)) {
          App.bus.emit("store:change", { ...sets, source: src });
        }
      });
    }
    const b = (pending[source] ||= { workspaces: new Set(), pages: new Set(), blocks: new Set() });
    b[`${kind}s`].add(id);
  }

  // --- indices -------------------------------------------------------------------
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  const drop = (m, k, v) => { const s = m.get(k); if (s) { s.delete(v); if (!s.size) m.delete(k); } };
  const blockParentKey = (b) => (b.parent_id ? b.parent_id : `page:${b.page_id}`);

  function unindex(kind, row) {
    if (!row) return;
    if (kind === "page") drop(childPages, row.parent_id, row.id);
    if (kind === "block") {
      drop(pageBlocks, row.page_id, row.id);
      drop(childBlocks, blockParentKey(row), row.id);
    }
  }
  function index(kind, row) {
    if (kind === "page") add(childPages, row.parent_id, row.id);
    if (kind === "block") {
      add(pageBlocks, row.page_id, row.id);
      add(childBlocks, blockParentKey(row), row.id);
    }
  }

  function setRow(kind, row, source) {
    const prev = maps[kind].get(row.id);
    unindex(kind, prev);
    maps[kind].set(row.id, row);
    index(kind, row);
    touched(kind, row.id, source);
  }

  function removeRow(kind, id, source) {
    const prev = maps[kind].get(id);
    if (!prev) return;
    unindex(kind, prev);
    maps[kind].delete(id);
    touched(kind, id, source);
  }

  // --- loading -----------------------------------------------------------------
  async function load() {
    Object.values(maps).forEach((m) => m.clear());
    [childPages, pageBlocks, childBlocks].forEach((m) => m.clear());
    const [ws, ps, bs] = await Promise.all([
      App.db.getAll("workspaces"), App.db.getAll("pages"), App.db.getAll("blocks"),
    ]);
    ws.forEach((r) => setRow("workspace", r, "remote"));
    ps.forEach((r) => setRow("page", r, "remote"));
    bs.forEach((r) => setRow("block", r, "remote"));
  }

  /* Rows from a pull. They replace ours (App.sync already overlaid our queued
     edits); purged pages and, for a share link, pages outside the shared tree
     are dropped along with their blocks. */
  async function applyRemote(rows) {
    if (rows.reset) {
      for (const kind of Object.keys(maps)) [...maps[kind].keys()].forEach((id) => removeRow(kind, id, "remote"));
    }
    rows.workspaces.forEach((r) => setRow("workspace", r, "remote"));
    const gone = [];
    for (const r of rows.pages) {
      if (r.options && r.options.purged) gone.push(r.id);
      else setRow("page", r, "remote");
    }
    rows.blocks.forEach((r) => setRow("block", r, "remote"));
    if (Array.isArray(rows.scope_page_ids)) {
      const scope = new Set(rows.scope_page_ids);
      for (const id of maps.page.keys()) if (!scope.has(id)) gone.push(id);
    }
    if (gone.length) await forgetPages(gone);
  }

  async function forgetPages(ids) {
    const blockIds = [];
    for (const id of ids) {
      for (const bid of pageBlocks.get(id) || []) blockIds.push(bid);
      removeRow("page", id, "remote");
    }
    blockIds.forEach((bid) => removeRow("block", bid, "remote"));
    await App.db.bulkDelete("pages", ids);
    await App.db.bulkDelete("blocks", blockIds);
  }

  // --- reads -------------------------------------------------------------------
  const live = (r) => r && !r.deleted;
  const byPosition = (a, b) => (a.position - b.position) || String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.id.localeCompare(b.id);
  const rowsOf = (kind, ids) => [...(ids || [])].map((id) => maps[kind].get(id)).filter(Boolean);

  const reads = {
    workspace: (id) => maps.workspace.get(id) || null,
    page: (id) => maps.page.get(id) || null,
    block: (id) => maps.block.get(id) || null,

    workspaces: () => [...maps.workspace.values()].filter(live).sort(byPosition),

    rootPage(workspaceId) {
      const ws = maps.workspace.get(workspaceId);
      return ws ? maps.page.get(ws.root_page_id) || null : null;
    },

    /* The icon a workspace shows. It and its root page share one (see
       updatePage); data from before that may have it on the page only. */
    workspaceIcon(ws) {
      if (!ws) return null;
      const root = maps.page.get(ws.root_page_id);
      return ws.icon || (root && !root.deleted ? root.icon : null) || null;
    },

    /* Live child pages, in order. A database's children are its rows. */
    children: (pageId) => rowsOf("page", childPages.get(pageId)).filter(live).sort(byPosition),

    /* Parent first, workspace root last. */
    ancestors(pageId) {
      const out = [];
      const seen = new Set([pageId]);
      let cur = maps.page.get(pageId);
      while (cur && cur.parent_id && !seen.has(cur.parent_id)) {
        seen.add(cur.parent_id);
        cur = maps.page.get(cur.parent_id);
        if (cur) out.push(cur);
      }
      return out;
    },

    /* Deleted itself or under a deleted page (or in a deleted workspace). */
    isTrashed(pageId) {
      const p = maps.page.get(pageId);
      if (!p) return true;
      if (p.deleted) return true;
      if (reads.ancestors(pageId).some((a) => a.deleted)) return true;
      const ws = maps.workspace.get(p.workspace_id);
      return Boolean(ws && ws.deleted);
    },

    isRow(pageId) {
      const p = maps.page.get(pageId);
      const parent = p && p.parent_id ? maps.page.get(p.parent_id) : null;
      return Boolean(parent && parent.kind === "database");
    },

    /* The trash: deleted pages whose parent is not itself in the trash. */
    trash(workspaceId) {
      return [...maps.page.values()]
        .filter((p) => p.deleted && !(p.options && p.options.purged))
        .filter((p) => !workspaceId || p.workspace_id === workspaceId)
        .filter((p) => !p.parent_id || !reads.isTrashed(p.parent_id))
        .sort((a, b) => String(b.deleted_at || "").localeCompare(String(a.deleted_at || "")));
    },

    favorites: () => [...maps.page.values()].filter((p) => p.favorite && !reads.isTrashed(p.id)).sort(byPosition),

    /* Live pages per workspace, root pages and database rows not counted: the
       numbers beside the workspaces in the sidebar. Deleted pages are left
       out; pages under a deleted page are not (walking every ancestor chain
       on each change is not worth an exact count). */
    pageCounts() {
      const out = {};
      for (const p of maps.page.values()) {
        if (p.deleted || !p.parent_id || (p.options && p.options.purged)) continue;
        const parent = maps.page.get(p.parent_id);
        if (parent && parent.kind === "database") continue;
        out[p.workspace_id] = (out[p.workspace_id] || 0) + 1;
      }
      return out;
    },

    /* Top-level blocks of a page, or the children of a block. Live, in order. */
    blocks: (pageId) => rowsOf("block", childBlocks.get(`page:${pageId}`)).filter(live).sort(byPosition),
    childBlocks: (blockId) => rowsOf("block", childBlocks.get(blockId)).filter(live).sort(byPosition),
    allBlocks: (pageId) => rowsOf("block", pageBlocks.get(pageId)).filter(live),

    /* The page's content as nested nodes: [{ block, children: [...] }]. */
    blockTree(pageId) {
      const build = (rows) => rows.map((b) => ({ block: b, children: build(reads.childBlocks(b.id)) }));
      return build(reads.blocks(pageId));
    },

    /* Most recent edit to the page or any of its blocks. */
    lastEdited(pageId) {
      const p = maps.page.get(pageId);
      let best = p ? p.updated_at || "" : "";
      for (const bid of pageBlocks.get(pageId) || []) {
        const b = maps.block.get(bid);
        if (b && b.updated_at > best) best = b.updated_at;
      }
      return best;
    },

    recent(limit = 12) {
      return [...maps.page.values()]
        .filter((p) => !reads.isTrashed(p.id) && p.parent_id)
        .map((p) => ({ p, t: reads.lastEdited(p.id) }))
        .sort((a, b) => String(b.t).localeCompare(String(a.t)))
        .slice(0, limit)
        .map((x) => x.p);
    },

    /* Case- and accent-insensitive search over titles and block text. Title
       hits first, then pages by number of matching blocks. */
    search(query, limit = 30) {
      const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      const q = fold(query).trim();
      if (!q) return [];
      const terms = q.split(/\s+/);
      const hit = (s) => { const f = fold(s); return terms.every((t) => f.includes(t)); };
      const results = new Map();
      for (const p of maps.page.values()) {
        if (!hit(p.title) || reads.isTrashed(p.id)) continue;
        results.set(p.id, { page: p, score: 100 + (fold(p.title).startsWith(q) ? 50 : 0), blockId: null, snippet: "" });
      }
      for (const b of maps.block.values()) {
        if (b.deleted || !b.text || !hit(b.text)) continue;
        const r = results.get(b.page_id);
        if (r) { r.score += 1; if (!r.blockId) { r.blockId = b.id; r.snippet = b.text; } continue; }
        const p = maps.page.get(b.page_id);
        if (!p || reads.isTrashed(p.id)) continue;
        results.set(p.id, { page: p, score: 1, blockId: b.id, snippet: b.text });
      }
      return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    },

    mode: () => state.mode,
    me: () => state.me,
    shareRootId: () => state.shareRootId,
    isReadOnly: () => readOnly,
  };

  // --- ordering ----------------------------------------------------------------
  /* A position that lands between the given neighbours (DESIGN §6). Returns
     null when the gap is used up; callers then renumber and ask again. */
  function between(a, b) {
    if (a == null && b == null) return 1;
    if (a == null) return b - 1;
    if (b == null) return a + 1;
    if (Math.abs(b - a) < 1e-6) return null;
    return (a + b) / 2;
  }

  /* Position for inserting into `siblings` (sorted, without the row being
     placed) after `after` (id) or before `before` (id); default is the end. */
  function placeAmong(kind, siblings, { after, before, index } = {}) {
    let i;
    if (after !== undefined && after !== null) i = siblings.findIndex((s) => s.id === after) + 1;
    else if (before !== undefined && before !== null) i = Math.max(0, siblings.findIndex((s) => s.id === before));
    else if (index !== undefined) i = Math.max(0, Math.min(index, siblings.length));
    else i = siblings.length;
    if (after === null) i = 0; // explicit "at the top"
    if (i < 0) i = siblings.length;
    const pos = between(siblings[i - 1]?.position, siblings[i]?.position);
    if (pos !== null) return pos;
    // Renumber 1..n and place in the fresh gap.
    siblings.forEach((s, n) => write(kind, s.id, { position: n + 1 }));
    return i + 0.5;
  }

  // --- writes ------------------------------------------------------------------
  const ENTITY = { workspace: "workspace", page: "page", block: "block" };
  const nowIso = () => new Date().toISOString();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  function assertWritable() {
    if (readOnly) throw new Error("This page is read-only");
  }

  /* The one write path. `patch` holds only changed fields; props/schema/options
     are whole objects (DESIGN §5). */
  function write(kind, id, patch, opts = {}) {
    assertWritable();
    const prev = maps[kind].get(id);
    const before = prev ? Object.fromEntries(Object.keys(patch).map((k) => [k, clone(prev[k])])) : null;
    const row = { ...(prev || { id, deleted: false, created_at: nowIso(), props: {}, options: {} }), ...clone(patch), updated_at: nowIso() };
    setRow(kind, row, opts.source || "local");
    App.db.put(STORE_NAME[kind], row).catch((e) => console.error("local save failed", e));
    App.sync.mutate(ENTITY[kind], id, patch).catch((e) => console.error("queue failed", e));
    if (!opts.noHistory) history.record(kind, id, before, prev ? clone(patch) : clone(row));
    return row;
  }

  // --- history (undo/redo) ---------------------------------------------------------
  const history = (() => {
    const undoStack = [];
    const redoStack = [];
    let open = null;        // the step being collected in this task
    let explicit = 0;       // depth of history.group() calls
    let replaying = false;

    function close() {
      if (!open || explicit) return;
      const step = open;
      open = null;
      if (!step.entries.length) return;
      const last = undoStack[undoStack.length - 1];
      // Typing: merge into the previous step if it was text edits to the same
      // block moments ago, so undo takes back a phrase rather than a letter.
      const textOnly = (s) => s.entries.length === 1 && s.entries[0].kind === "block" && s.entries[0].before
        && Object.keys(s.entries[0].after).join() === "text";
      if (last && textOnly(step) && textOnly(last) && last.entries[0].id === step.entries[0].id
          && step.at - last.at < 1200) {
        last.entries[0].after = step.entries[0].after;
        last.at = step.at;
        return;
      }
      undoStack.push(step);
      if (undoStack.length > 200) undoStack.shift();
    }

    function record(kind, id, before, after) {
      if (replaying) return;
      if (!open) {
        open = { entries: [], at: Date.now(), label: null };
        if (!explicit) setTimeout(close, 0);
      }
      open.entries.push({ kind, id, before, after });
      redoStack.length = 0;
    }

    function group(label, fn) {
      explicit += 1;
      if (!open) open = { entries: [], at: Date.now(), label };
      try { return fn(); } finally {
        explicit -= 1;
        if (!explicit) close();
      }
    }

    function replay(step, dir) {
      replaying = true;
      const ids = { workspaces: new Set(), pages: new Set(), blocks: new Set() };
      try {
        const entries = dir === "undo" ? [...step.entries].reverse() : step.entries;
        for (const e of entries) {
          const values = dir === "undo" ? (e.before || { deleted: true }) : { ...e.after, deleted: e.after.deleted ?? false };
          write(e.kind, e.id, values, { noHistory: true, source: "undo" });
          ids[`${e.kind}s`].add(e.id);
        }
      } finally {
        replaying = false;
      }
      App.bus.emit("store:replayed", { ...ids, dir });
      return ids;
    }

    return {
      record,
      group,
      undo() { close(); const s = undoStack.pop(); if (!s) return null; redoStack.push(s); return replay(s, "undo"); },
      redo() { close(); const s = redoStack.pop(); if (!s) return null; undoStack.push(s); return replay(s, "redo"); },
      canUndo: () => undoStack.length > 0 || Boolean(open && open.entries.length),
      canRedo: () => redoStack.length > 0,
      clear() { undoStack.length = 0; redoStack.length = 0; open = null; },
    };
  })();

  // --- workspaces -------------------------------------------------------------------
  function createWorkspace({ name = "Untitled", icon = null } = {}) {
    return history.group("New workspace", () => {
      const wsId = App.uuid();
      const rootId = App.uuid();
      const last = reads.workspaces().at(-1);
      const ws = write("workspace", wsId, { name, icon, position: (last ? last.position : 0) + 1, root_page_id: rootId });
      const root = write("page", rootId, { workspace_id: wsId, parent_id: null, kind: "page", title: name, position: 0 });
      return { workspace: ws, root };
    });
  }

  /* A workspace and its root page are one thing to the reader, so they share
     one icon: setting it on either sets it on both. Only for the owner (a
     share link may not touch the workspace). An icon too long for the
     workspace (a long image URL) stays on the page, and the workspace's own
     is cleared so workspaceIcon() shows the page's. */
  const WS_ICON_MAX = 200;
  const same = (a, b) => (a || null) === (b || null);

  function updateWorkspace(id, patch) {
    const ws = maps.workspace.get(id);
    const root = ws && maps.page.get(ws.root_page_id);
    if (!root || state.mode !== "owner" || !("icon" in patch) || same(root.icon, patch.icon)) return write("workspace", id, patch);
    return history.group("Change icon", () => {
      write("page", root.id, { icon: patch.icon || null });
      return write("workspace", id, patch);
    });
  }

  function deleteWorkspace(id) { return write("workspace", id, { deleted: true }); }

  function moveWorkspace(id, { after, before } = {}) {
    const siblings = reads.workspaces().filter((w) => w.id !== id);
    return write("workspace", id, { position: placeAmong("workspace", siblings, { after, before }) });
  }

  // --- pages ------------------------------------------------------------------------
  function createPage({ parentId, title = "", kind = "page", icon = null, cover = null, schema = null,
    props = {}, options = {}, after, before, index } = {}) {
    const parent = maps.page.get(parentId);
    if (!parent) throw new Error("Parent page not found");
    const siblings = reads.children(parentId);
    const position = placeAmong("page", siblings, { after, before, index });
    const patch = { workspace_id: parent.workspace_id, parent_id: parentId, kind, title, icon, cover, position, props, options };
    if (schema) patch.schema = schema;
    return write("page", App.uuid(), patch);
  }

  function updatePage(id, patch) {
    const page = maps.page.get(id);
    const ws = page && !page.parent_id ? maps.workspace.get(page.workspace_id) : null;
    if (!ws || ws.root_page_id !== id || state.mode !== "owner" || !("icon" in patch)) return write("page", id, patch);
    const icon = patch.icon && String(patch.icon).length <= WS_ICON_MAX ? patch.icon : null;
    if (same(ws.icon, icon)) return write("page", id, patch);
    return history.group("Change icon", () => {
      write("workspace", ws.id, { icon });
      return write("page", id, patch);
    });
  }

  /* Move a page under another parent (any workspace) or reorder it among its
     siblings. The server cascades a workspace change to the subtree; the local
     copies are updated here too so the sidebar is right before the next pull. */
  function movePage(id, { parentId, after, before, index } = {}) {
    const page = maps.page.get(id);
    if (!page) return null;
    const target = parentId || page.parent_id;
    const parent = maps.page.get(target);
    if (!parent) throw new Error("Target page not found");
    if (target === id || reads.ancestors(target).some((a) => a.id === id)) throw new Error("A page cannot move inside itself");
    return history.group("Move page", () => {
      const siblings = reads.children(target).filter((p) => p.id !== id);
      const patch = { parent_id: target, position: placeAmong("page", siblings, { after, before, index }) };
      if (parent.workspace_id !== page.workspace_id) {
        patch.workspace_id = parent.workspace_id;
        const stack = [...(childPages.get(id) || [])];
        while (stack.length) {
          const cid = stack.pop();
          const child = maps.page.get(cid);
          if (!child) continue;
          // Local only: the server does this itself, and queuing a mutation per
          // descendant would also be accepted but costs a push for nothing.
          setRow("page", { ...child, workspace_id: parent.workspace_id }, "local");
          App.db.put("pages", maps.page.get(cid));
          stack.push(...(childPages.get(cid) || []));
        }
      }
      return write("page", id, patch);
    });
  }

  function trashPage(id) { return write("page", id, { deleted: true, deleted_at: nowIso() }); }
  function restorePage(id) { return write("page", id, { deleted: false, deleted_at: null }); }

  async function purgePage(id) {
    await App.api.del(`/api/pages/${encodeURIComponent(id)}`);
    const ids = [id];
    for (let i = 0; i < ids.length; i++) ids.push(...(childPages.get(ids[i]) || []));
    await forgetPages(ids);
  }

  /* A deep copy of a page, its subpages and all their blocks, placed right
     after the original. File references are shared, not copied. */
  function duplicatePage(id, { parentId } = {}) {
    const src = maps.page.get(id);
    if (!src) return null;
    return history.group("Duplicate page", () => {
      const copyTree = (page, newParent, placement) => {
        const copy = createPage({
          parentId: newParent, title: page.title, kind: page.kind, icon: page.icon, cover: page.cover,
          schema: clone(page.schema), props: clone(page.props) || {}, options: clone(page.options) || {}, ...placement,
        });
        const copyBlocks = (nodes, parentBlock) => {
          for (const n of nodes) {
            const b = write("block", App.uuid(), {
              page_id: copy.id, parent_id: parentBlock, type: n.block.type, text: n.block.text,
              props: clone(n.block.props) || {}, position: n.block.position,
            });
            copyBlocks(n.children, b.id);
          }
        };
        copyBlocks(reads.blockTree(page.id), null);
        for (const child of reads.children(page.id)) copyTree(child, copy.id, {});
        return copy;
      };
      const copy = copyTree(src, parentId || src.parent_id, { after: src.id });
      if (!parentId && src.title) write("page", copy.id, { title: `${src.title} (copy)` });
      return copy;
    });
  }

  // --- blocks ------------------------------------------------------------------------
  const siblingBlocks = (pageId, parentId) => (parentId ? reads.childBlocks(parentId) : reads.blocks(pageId));

  function createBlock({ pageId, parentId = null, type = "paragraph", text = "", props = {}, after, before, index } = {}) {
    const siblings = siblingBlocks(pageId, parentId);
    const position = placeAmong("block", siblings, { after, before, index });
    return write("block", App.uuid(), { page_id: pageId, parent_id: parentId, type, text, props, position });
  }

  function updateBlock(id, patch) { return write("block", id, patch); }

  /* Move a block (and so its nested blocks) to a new parent and/or page. */
  function moveBlock(id, { pageId, parentId = null, after, before, index } = {}) {
    const blk = maps.block.get(id);
    if (!blk) return null;
    const targetPage = pageId || blk.page_id;
    if (parentId) {
      let cur = maps.block.get(parentId);
      while (cur) {
        if (cur.id === id) throw new Error("A block cannot move inside itself");
        cur = cur.parent_id ? maps.block.get(cur.parent_id) : null;
      }
    }
    return history.group("Move block", () => {
      const siblings = siblingBlocks(targetPage, parentId).filter((b) => b.id !== id);
      const patch = { parent_id: parentId, position: placeAmong("block", siblings, { after, before, index }) };
      if (targetPage !== blk.page_id) {
        patch.page_id = targetPage;
        const stack = reads.childBlocks(id).map((b) => b.id);
        while (stack.length) {
          const cid = stack.pop();
          write("block", cid, { page_id: targetPage });
          stack.push(...reads.childBlocks(cid).map((b) => b.id));
        }
      }
      return write("block", id, patch);
    });
  }

  /* Soft-delete a block and everything nested in it. */
  function deleteBlock(id) {
    return history.group("Delete block", () => {
      const stack = [id];
      while (stack.length) {
        const cid = stack.pop();
        stack.push(...reads.childBlocks(cid).map((b) => b.id));
        write("block", cid, { deleted: true });
      }
    });
  }

  /* Insert parsed content ([{ type, text, props, children }], app.mdblocks.js's
     shape) after a block (or at the start with after: null, or at the end when
     neither after nor before is given). Returns the created top-level blocks. */
  function insertTree(pageId, nodes, { parentId = null, after, before } = {}) {
    return history.group("Insert", () => {
      const created = [];
      let prev = after;
      const place = (list, parent, placement) => {
        const out = [];
        let last = placement.after;
        list.forEach((n, i) => {
          const b = createBlock({
            pageId, parentId: parent, type: n.type || "paragraph", text: n.text || "", props: clone(n.props) || {},
            ...(i === 0 ? placement : { after: last }),
          });
          last = b.id;
          out.push(b);
          if (n.children && n.children.length) place(n.children, b.id, { after: null });
        });
        return out;
      };
      created.push(...place(nodes, parentId, prev !== undefined ? { after: prev } : before ? { before } : {}));
      return created;
    });
  }

  // --- setup -------------------------------------------------------------------------
  App.sync.onRemote(applyRemote);

  return {
    ...reads,
    load,
    applyRemote,
    history,
    group: history.group,
    undo: () => history.undo(),
    redo: () => history.redo(),
    between,
    // writes
    createWorkspace, updateWorkspace, deleteWorkspace, moveWorkspace,
    createPage, updatePage, movePage, trashPage, restorePage, purgePage, duplicatePage,
    createBlock, updateBlock, moveBlock, deleteBlock, insertTree,
    configure({ mode, me, shareRootId, readOnly: ro } = {}) {
      if (mode !== undefined) state.mode = mode;
      if (me !== undefined) state.me = me;
      if (shareRootId !== undefined) state.shareRootId = shareRootId;
      if (ro !== undefined) readOnly = ro;
    },
  };
})();
