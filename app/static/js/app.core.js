/* meerpad core: the App namespace, the API client, DOM and formatting helpers.

   Shapes shared with meerpic and meercal (App.bus, App.el, App.fmt) so the
   family's modules read alike. One rule runs through everything built on it:

   * **Page content is text.** Titles, block text and file names reach the page
     through `textContent` (App.el's `text`) or through app.markdown.js, which
     escapes everything and assembles its own markup. Nothing a user typed is
     ever passed to innerHTML as-is. */

window.App = window.App || {};

// --- events between modules ------------------------------------------------
App.bus = {
  handlers: {},
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return () => this.off(name, fn); },
  off(name, fn) { this.handlers[name] = (this.handlers[name] || []).filter((f) => f !== fn); },
  emit(name, payload) {
    (this.handlers[name] || []).slice().forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  },
};

// --- API -------------------------------------------------------------------
App.api = {
  async request(method, path, body, opts = {}) {
    const init = { method, headers: {}, credentials: "same-origin" };
    if (body instanceof FormData) {
      init.body = body; // the browser sets the multipart boundary
    } else if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    // A server that accepts the connection and never answers (a dev reloader
    // whose worker keeps crashing, a proxy waiting on a dead upstream) must
    // end in an error the caller can show, not a spinner that turns forever.
    const timeout = opts.timeout === undefined ? 30000 : opts.timeout;
    let timer = null;
    if (opts.signal) init.signal = opts.signal;
    else if (timeout) {
      const ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(() => ctl.abort(), timeout);
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch (e) {
      if (e && e.name === "AbortError" && !opts.signal) {
        throw Object.assign(new Error("The server did not answer. Please try again in a moment."), { status: 0 });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return this.unwrap(response);
  },

  async unwrap(response) {
    if (!response.ok) {
      let detail = response.statusText || `HTTP ${response.status}`;
      let payload = null;
      try {
        payload = await response.json();
        // FastAPI's validation errors are a list; say the first one rather
        // than "[object Object]".
        if (typeof payload.detail === "string") detail = payload.detail;
        else if (Array.isArray(payload.detail) && payload.detail[0]) detail = payload.detail[0].msg || detail;
      } catch (e) { /* not JSON */ }
      const err = new Error(detail);
      err.status = response.status;
      err.payload = payload;
      if (response.status === 401) App.bus.emit("auth:lost");
      throw err;
    }
    if (response.status === 204) return null;
    const ct = response.headers.get("content-type") || "";
    return ct.includes("application/json") ? response.json() : response.text();
  },

  get(path, opts) { return this.request("GET", path, undefined, opts); },
  post(path, body, opts) { return this.request("POST", path, body === undefined ? {} : body, opts); },
  put(path, body) { return this.request("PUT", path, body); },
  patch(path, body) { return this.request("PATCH", path, body); },
  del(path) { return this.request("DELETE", path); },
  upload(path, formData) { return this.request("POST", path, formData); },
};

// --- DOM -------------------------------------------------------------------
App.el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    // `html` is for markup this app assembles itself (icons, app.markdown.js
    // output); never for anything straight from the server or the user.
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "style") node.setAttribute("style", v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  children.flat().forEach((c) => {
    if (c === null || c === undefined || c === false || c === "") return;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  });
  return node;
};

App.$ = (sel, root = document) => root.querySelector(sel);
App.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

App.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

App.uuid = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

// --- local, per-browser memory ---------------------------------------------
// Reading can throw: a private window is allowed to refuse storage outright.
App.local = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`meerpad.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`meerpad.${key}`, JSON.stringify(value)); } catch (e) { /* refused */ }
  },
};

// --- formatting ------------------------------------------------------------
App.fmt = {
  /* Decimal units, the way Finder and every phone count them (meerpic's). */
  bytes(b) {
    if (b === null || b === undefined) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = Number(b);
    let i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  },

  /* An instant from the server ("...Z") as "5 min ago". */
  ago(iso) {
    if (!iso) return "";
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    const s = Math.max(0, (Date.now() - then.getTime()) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 2 * 86400) return "yesterday";
    if (s < 14 * 86400) return `${Math.round(s / 86400)} days ago`;
    return then.toLocaleDateString();
  },

  date(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  },
};

// --- files -----------------------------------------------------------------
App.files = App.files || {};
/* The URL a block's file reference resolves to. A share-link visitor has no
   session, so their requests carry the share token instead (share.html sets
   App.files.shareToken). */
App.files.url = (fileId, name, opts = {}) => {
  if (!fileId) return "";
  let url = `/api/files/${encodeURIComponent(fileId)}`;
  if (name) url += `/${encodeURIComponent(name)}`;
  const q = [];
  if (App.files.shareToken) q.push(`share=${encodeURIComponent(App.files.shareToken)}`);
  if (opts.download) q.push("download=1");
  return q.length ? `${url}?${q.join("&")}` : url;
};

/* Upload a File/Blob. Resolves to the server's file row
   ({id, filename, content_type, size, url}). XHR rather than fetch, for the
   progress events a large drop needs. Needs a connection: files are not part of
   the offline queue. */
App.files.upload = (file, { pageId = null, onProgress = null, name = null } = {}) =>
  new Promise((resolve, reject) => {
    if (!navigator.onLine) { reject(new Error("You are offline. Files need a connection to upload.")); return; }
    const form = new FormData();
    form.append("file", file, name || file.name || "file");
    if (pageId) form.append("page_id", pageId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.withCredentials = true;
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error((data && data.detail) || `Upload failed (${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error("Upload failed: no connection"));
    xhr.send(form);
  });

/* What a pasted URL points at: {ok, kind: image|pdf|video|audio|file|html|unknown, ...}. */
App.files.probe = (url) => App.api.get(`/api/files/probe?url=${encodeURIComponent(url)}`);

/* Have the server download a URL into the account's files. */
App.files.fetchUrl = (url, pageId = null) => App.api.post("/api/files/fetch", { url, page_id: pageId }, { timeout: 300000 });

/* A guess from the URL alone, so the paste offer can appear before any request. */
App.files.kindFromUrl = (url) => {
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch (e) { return "unknown"; }
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)$/.test(path)) return "image";
  if (path.endsWith(".pdf")) return "pdf";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(path)) return "audio";
  return "unknown";
};

/* A page icon or cover reference ("file:<id>", a URL, an emoji, "gradient:N")
   to something displayable. */
App.files.ref = (ref) => {
  if (!ref) return null;
  if (ref.startsWith("file:")) return { kind: "url", url: App.files.url(ref.slice(5)) };
  if (/^https?:\/\//i.test(ref)) return { kind: "url", url: ref };
  if (ref.startsWith("gradient:")) return { kind: "gradient", n: Number(ref.slice(9)) || 0 };
  return { kind: "emoji", text: ref };
};

// --- toasts ----------------------------------------------------------------
App.toast = (message, opts = {}) => {
  let host = document.getElementById("toasts");
  if (!host) {
    host = App.el("div", { id: "toasts", class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const node = App.el("div", { class: `toast${opts.kind ? ` toast-${opts.kind}` : ""}` }, message);
  if (opts.action) {
    node.append(App.el("button", {
      class: "toast-action", text: opts.action.label,
      onclick: () => { opts.action.run(); node.remove(); },
    }));
  }
  host.append(node);
  setTimeout(() => node.remove(), opts.duration || 4000);
  return node;
};
