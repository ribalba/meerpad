/* The local mirror: IndexedDB, or plain memory for a share-link visitor.

   meerato's wrapper, grown a second backend. Stores:
     workspaces, pages, blocks   rows as the server sends them (keyed by id)
     queue                       mutations not yet accepted by the server
     meta                        key/value: the pull cursor, the signed-in user

   One database per account ("meerpad-<user id>"), so signing in as someone
   else on the same browser never shows the previous person's pages. */

window.App = window.App || {};

App.db = (() => {
  const STORES = ["workspaces", "pages", "blocks", "queue", "meta"];
  const KEYS = { queue: "op_id", meta: "key" };
  let dbp = null;
  let memory = null; // Map per store when running without IndexedDB

  function open(name) {
    memory = null;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEYS[s] || "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn("IndexedDB upgrade blocked by another tab");
    });
    return dbp;
  }

  /* A share-link visitor's copy lives only as long as the tab: their browser is
     not where the owner's pages should end up stored. Also the fallback when a
     private window refuses IndexedDB. */
  function useMemory() {
    dbp = null;
    memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  }

  const keyOf = (store, value) => value[KEYS[store] || "id"];

  function tx(store, mode, fn) {
    if (memory) return Promise.resolve(fn(null));
    if (!dbp) return Promise.reject(new Error("App.db is not open"));
    return dbp.then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      const box = fn(os);
      t.oncomplete = () => resolve(box && box.__req ? box.__req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const clone = (v) => (v === undefined ? v : structuredClone(v));

  const api = {
    open,
    useMemory,
    isMemory: () => Boolean(memory),

    put(store, value) {
      if (memory) { memory[store].set(keyOf(store, value), clone(value)); return Promise.resolve(); }
      return tx(store, "readwrite", (os) => { os.put(value); });
    },
    bulkPut(store, values) {
      if (!values.length) return Promise.resolve();
      if (memory) { values.forEach((v) => memory[store].set(keyOf(store, v), clone(v))); return Promise.resolve(); }
      return tx(store, "readwrite", (os) => { values.forEach((v) => os.put(v)); });
    },
    get(store, id) {
      if (memory) return Promise.resolve(clone(memory[store].get(id)));
      return tx(store, "readonly", (os) => ({ __req: os.get(id) }));
    },
    getAll(store) {
      if (memory) return Promise.resolve([...memory[store].values()].map(clone));
      return tx(store, "readonly", (os) => ({ __req: os.getAll() }));
    },
    delete(store, id) {
      if (memory) { memory[store].delete(id); return Promise.resolve(); }
      return tx(store, "readwrite", (os) => { os.delete(id); });
    },
    bulkDelete(store, ids) {
      if (!ids.length) return Promise.resolve();
      if (memory) { ids.forEach((id) => memory[store].delete(id)); return Promise.resolve(); }
      return tx(store, "readwrite", (os) => { ids.forEach((id) => os.delete(id)); });
    },
    clear(store) {
      if (memory) { memory[store].clear(); return Promise.resolve(); }
      return tx(store, "readwrite", (os) => { os.clear(); });
    },

    async getMeta(key, fallback = null) {
      const row = await api.get("meta", key);
      return row ? row.value : fallback;
    },
    setMeta: (key, value) => api.put("meta", { key, value }),

    /* The queue is keyed by a random op_id, so getAll() hands rows back in key
       order rather than the order they were made. Each carries a monotonic `seq`
       to sort on, so the server replays a create before the edits that follow
       it (meerato's fix, kept). */
    async queued() {
      return (await api.getAll("queue")).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    },
  };
  return api;
})();
