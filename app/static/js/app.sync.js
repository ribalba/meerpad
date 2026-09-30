/* The sync engine: meerato's local-first loop, adapted to meerpad's protocol.

   Every change goes through App.sync.mutate(): it lands in the local mirror
   (via App.store, which calls this) and in a queue, and a flush soon after
   pushes the queue and pulls whatever changed elsewhere. docs/DESIGN.md §5 has
   the protocol; the differences from meerato are:

   * Mutations are always "upsert" with only the changed fields; a delete is
     `deleted: true`. So two edits to one row queued while offline (or within
     the debounce window) coalesce into one op instead of hundreds, which is
     what typing into a block would otherwise produce.
   * Pulls walk a server revision cursor, page by page, never client clocks.
   * Pulled rows are overlaid with the local ops still queued for them, so an
     edit made while a pull was in flight is not briefly reverted on screen.

   A share-link visitor runs the same loop against /api/share/<token>/…
   (App.sync.configure), with the mirror in memory. */

window.App = window.App || {};

App.sync = (() => {
  const MAX_PUSH_ATTEMPTS = 3;   // meerato's: a refused op is parked after this many
  const BATCH = 400;             // mutations per push request
  const DEBOUNCE_MS = 700;
  const MAX_WAIT_MS = 4000;

  let cfg = { push: "/api/sync/push", pull: "/api/sync/pull", readOnly: false, pollMs: 20000 };
  let onRemote = null;           // App.store registers: (rows) => void
  let running = null;            // the flush in progress
  let again = false;             // a flush was asked for while one ran
  let timer = null;
  let firstQueuedAt = 0;
  let lastSeq = 0;
  let lastOk = null;
  let lastError = null;
  const inflight = new Set();    // op_ids in the request being sent right now
  const latest = new Map();      // "entity:id" -> the newest queued op (merge target)

  function nextSeq() {
    const now = Date.now();
    lastSeq = now > lastSeq ? now : lastSeq + 1;
    return lastSeq;
  }

  const keyOf = (entity, id) => `${entity}:${id}`;

  async function init() {
    latest.clear();
    for (const op of await App.db.queued()) latest.set(keyOf(op.entity, op.id), op);
  }

  /* Queue a change. `data` holds only the changed fields. Returns the op. */
  async function mutate(entity, id, data) {
    if (cfg.readOnly) throw new Error("Read-only");
    const updated_at = new Date().toISOString();
    const key = keyOf(entity, id);
    const prev = latest.get(key);
    let op;
    if (prev && !inflight.has(prev.op_id) && !prev.blocked) {
      op = { ...prev, updated_at, data: { ...prev.data, ...data } };
    } else {
      op = { op_id: App.uuid(), entity, action: "upsert", id, updated_at, data: { ...data }, seq: nextSeq(), attempts: 0 };
    }
    latest.set(key, op);
    await App.db.put("queue", op);
    schedule();
    emitStatus();
    return op;
  }

  /* Debounced flush: soon after the last change, but never later than
     MAX_WAIT_MS after the first one, so steady typing still syncs. */
  function schedule(delay = DEBOUNCE_MS) {
    const now = Date.now();
    if (!firstQueuedAt) firstQueuedAt = now;
    const wait = Math.max(0, Math.min(delay, firstQueuedAt + MAX_WAIT_MS - now));
    clearTimeout(timer);
    timer = setTimeout(() => { firstQueuedAt = 0; flush(); }, wait);
  }

  /* Push the queue, then pull. Never throws; reports instead:
       ok      reached the server (false = offline or the request failed)
       synced  ops accepted this round
       parked  ops set aside after repeated refusals (queue-wide)
       detail  the server's reason for the latest refusal */
  function flush() {
    if (running) { again = true; return running; }
    running = (async () => {
      let result;
      try {
        result = await flushOnce();
      } finally {
        running = null;
      }
      if (again) { again = false; return flush(); }
      return result;
    })();
    return running;
  }

  async function flushOnce() {
    if (!navigator.onLine) { emitStatus(); return { ok: false, synced: 0, parked: await parkedCount(), detail: null }; }
    let synced = 0;
    let detail = null;
    emitStatus(true);
    try {
      if (!cfg.readOnly) {
        for (;;) {
          const ready = (await App.db.queued()).filter((m) => !m.blocked).slice(0, BATCH);
          if (!ready.length) break;
          ready.forEach((m) => inflight.add(m.op_id));
          let resp;
          try {
            resp = await App.api.post(cfg.push, {
              mutations: ready.map(({ op_id, entity, action, id, updated_at, data }) => ({ op_id, entity, action, id, updated_at, data })),
            }, { timeout: 120000 });
          } finally {
            ready.forEach((m) => inflight.delete(m.op_id));
          }
          const byId = new Map(ready.map((m) => [m.op_id, m]));
          let progressed = false;
          for (const r of resp.results) {
            const m = byId.get(r.op_id);
            if (r.status !== "error") {
              await App.db.delete("queue", r.op_id);
              if (m && latest.get(keyOf(m.entity, m.id))?.op_id === r.op_id) latest.delete(keyOf(m.entity, m.id));
              synced += 1;
              progressed = true;
            } else {
              detail = r.detail || "The server rejected this change.";
              await recordRejection(r.op_id, detail);
            }
          }
          if (!progressed) break;
        }
      }
      await pull();
      lastOk = new Date();
      lastError = detail;
      return { ok: true, synced, parked: await parkedCount(), detail };
    } catch (e) {
      // Offline or a server error: the queue stays as it is and is retried later.
      // A transport failure costs no op an attempt.
      console.debug("sync deferred:", e);
      if (e && e.status === 401) App.bus.emit("auth:lost");
      lastError = e && e.status ? (e.message || String(e)) : null;
      return { ok: false, synced, parked: await parkedCount(), detail: null };
    } finally {
      emitStatus(false);
    }
  }

  async function recordRejection(op_id, detail) {
    const row = await App.db.get("queue", op_id);
    if (!row) return;
    const attempts = (row.attempts || 0) + 1;
    const next = { ...row, attempts, last_error: detail, blocked: attempts >= MAX_PUSH_ATTEMPTS };
    await App.db.put("queue", next);
    if (latest.get(keyOf(row.entity, row.id))?.op_id === op_id) latest.set(keyOf(row.entity, row.id), next);
  }

  const parkedOps = async () => (await App.db.queued()).filter((m) => m.blocked);
  const parkedCount = async () => (await parkedOps()).length;

  async function retryParked() {
    for (const m of await parkedOps()) {
      const next = { ...m, blocked: false, attempts: 0, last_error: null };
      await App.db.put("queue", next);
      latest.set(keyOf(m.entity, m.id), next);
    }
    return flush();
  }

  /* Stop sending the parked ops. Not an undo: the local copy keeps what they
     wrote until a full resync replaces it with the server's version. */
  async function discardParked() {
    for (const m of await parkedOps()) {
      await App.db.delete("queue", m.op_id);
      if (latest.get(keyOf(m.entity, m.id))?.op_id === m.op_id) latest.delete(keyOf(m.entity, m.id));
    }
    emitStatus();
  }

  async function pull() {
    let cursor = await App.db.getMeta("cursor", 0);
    for (let round = 0; round < 1000; round++) {
      const sep = cfg.pull.includes("?") ? "&" : "?";
      const data = await App.api.get(`${cfg.pull}${sep}cursor=${cursor}&limit=5000`, { timeout: 120000 });
      if (data.reset) {
        // The server's history no longer includes our cursor (a restored or
        // rebuilt database): drop the mirror and start over from nothing.
        await Promise.all(["workspaces", "pages", "blocks"].map((s) => App.db.clear(s)));
        await App.db.setMeta("cursor", 0);
        if (onRemote) await onRemote({ reset: true, workspaces: [], pages: [], blocks: [] });
      }
      const queued = new Map();
      for (const m of await App.db.queued()) {
        const k = keyOf(m.entity, m.id);
        if (!queued.has(k)) queued.set(k, []);
        queued.get(k).push(m);
      }
      const overlay = (entity, rows) => rows.map((row) =>
        (queued.get(keyOf(entity, row.id)) || []).reduce((acc, m) => ({ ...acc, ...m.data }), row));
      const rows = {
        workspaces: overlay("workspace", data.workspaces || []),
        pages: overlay("page", data.pages || []),
        blocks: overlay("block", data.blocks || []),
        scope_page_ids: data.scope_page_ids,
        root_page_id: data.root_page_id,
        mode: data.mode,
      };
      await App.db.bulkPut("workspaces", rows.workspaces);
      await App.db.bulkPut("pages", rows.pages);
      await App.db.bulkPut("blocks", rows.blocks);
      if (onRemote) await onRemote(rows);
      cursor = data.cursor;
      await App.db.setMeta("cursor", cursor);
      if (!data.has_more) break;
    }
  }

  async function fullResync() {
    await Promise.all(["workspaces", "pages", "blocks"].map((s) => App.db.clear(s)));
    await App.db.setMeta("cursor", 0);
    if (onRemote) await onRemote({ reset: true, workspaces: [], pages: [], blocks: [] });
    return flush();
  }

  async function status(busy) {
    const queue = await App.db.queued();
    return {
      online: navigator.onLine,
      busy: busy === undefined ? Boolean(running) : busy,
      pending: queue.filter((m) => !m.blocked).length,
      parked: queue.filter((m) => m.blocked).length,
      lastOk,
      lastError,
    };
  }

  function emitStatus(busy) {
    status(busy).then((s) => App.bus.emit("sync:status", s)).catch(() => {});
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    window.addEventListener("online", () => { emitStatus(); flush(); });
    window.addEventListener("offline", () => emitStatus());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
    window.addEventListener("focus", () => flush());
    // Leaving with changes still queued: try once more, without waiting for it.
    window.addEventListener("pagehide", () => { if (latest.size) flush(); });
    setInterval(() => { if (!document.hidden) flush(); }, cfg.pollMs);
    flush();
  }

  return {
    configure(opts) { cfg = { ...cfg, ...opts }; },
    config: () => ({ ...cfg }),
    init,
    mutate,
    flush,
    pull,
    fullResync,
    retryParked,
    discardParked,
    parkedOps,
    status,
    start,
    onRemote(fn) { onRemote = fn; },
    hasPending: () => latest.size > 0,
  };
})();
