/* The editor's non-prose blocks: images, files and PDFs, bookmarks, embeds,
   tables, code (with Mermaid diagrams), equations, links to pages and inline
   databases; and getting files in (uploads with a progress placeholder, and
   having the server download a pasted link).

   Heavy things load late. Mermaid and KaTeX come from jsdelivr the first time
   a diagram or an equation scrolls into view, images and iframes are
   loading="lazy", and a 2,000-block page costs no more to open because it
   happens to contain a few of them. */

(() => {
  const E = App.editor;
  const { h, caret, readText, types } = E;
  const P = E.Editor.prototype;

  const httpUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : "");
  const titleOf = (p) => (App.ui && App.ui.titleOf ? App.ui.titleOf(p) : (p && p.title) || "Untitled");
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  const fileNameOf = (u) => { try { return decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() || ""); } catch (e) { return ""; } };

  // --- embeds: the allow-list ------------------------------------------------------
  /* { provider, src, ratio | height } for a URL that may become an iframe, or
     null. A port of embed_src in app/render.py (so the published site and the
     editor agree), plus CodePen and Figma. The iframe src is always rebuilt
     from a validated id, never copied from the user's URL. */
  function startSeconds(t) {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t || "");
    if (!m || !(m[1] || m[2] || m[3])) return null;
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  }

  function embedSrc(url) {
    let u;
    try { u = new URL(String(url || "").trim()); } catch (e) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    const parts = u.pathname.split("/").filter(Boolean);
    const q = u.searchParams;

    if (["youtube.com", "youtu.be", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
      let vid = null;
      if (host === "youtu.be" && parts.length) vid = parts[0];
      else if (parts[0] === "watch") vid = q.get("v");
      else if (parts.length >= 2 && ["embed", "shorts", "live", "v"].includes(parts[0])) vid = parts[1];
      if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return null;
      const start = startSeconds(q.get("t") || q.get("start") || "");
      return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${vid}${start ? `?start=${start}` : ""}`, ratio: 16 / 9 };
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const ids = parts.filter((p) => /^\d{4,12}$/.test(p));
      if (!ids.length) return null;
      let src = `https://player.vimeo.com/video/${ids[0]}`;
      const rest = host === "vimeo.com" ? parts.slice(parts.indexOf(ids[0]) + 1) : [];
      const hash = rest[0] || q.get("h") || "";
      if (hash && /^[0-9a-f]{6,20}$/.test(hash)) src += `?h=${hash}`;
      return { provider: "vimeo", src, ratio: 16 / 9 };
    }
    if (host === "loom.com" && parts.length >= 2 && ["share", "embed"].includes(parts[0]) && /^[0-9a-f]{16,40}$/.test(parts[1])) {
      return { provider: "loom", src: `https://www.loom.com/embed/${parts[1]}`, ratio: 16 / 9 };
    }
    if ((host === "google.com" && parts[0] === "maps") || host === "maps.google.com") {
      if (parts[0] === "maps" && parts[1] === "embed") {
        const pb = q.get("pb");
        if (pb && /^[A-Za-z0-9!._:%-]{1,4000}$/.test(pb)) return { provider: "maps", src: `https://www.google.com/maps/embed?${new URLSearchParams({ pb })}`, ratio: 4 / 3 };
        return null;
      }
      let query = q.get("q") || q.get("query") || "";
      if (!query && parts.length >= 3 && ["place", "search"].includes(parts[1])) {
        try { query = decodeURIComponent(parts[2]).replace(/\+/g, " "); } catch (e) { query = ""; }
      }
      const at = parts.find((p) => p.startsWith("@")) || "";
      const m = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/.exec(at);
      const params = new URLSearchParams();
      if (query && /^[^<>"'`\\]{1,300}$/.test(query)) params.set("q", query);
      else if (m) params.set("q", `${m[1]},${m[2]}`);
      if (!params.has("q")) return null;
      if (m && m[3]) params.set("z", String(Math.trunc(parseFloat(m[3]))));
      params.set("output", "embed");
      return { provider: "maps", src: `https://maps.google.com/maps?${params}`, ratio: 4 / 3 };
    }
    if (host === "codepen.io" && parts.length >= 3 && ["pen", "embed", "full", "details"].includes(parts[1])
        && /^[A-Za-z0-9_-]{1,40}$/.test(parts[0]) && /^[A-Za-z0-9]{3,20}$/.test(parts[2])) {
      return { provider: "codepen", src: `https://codepen.io/${parts[0]}/embed/${parts[2]}?default-tab=result`, height: 420 };
    }
    if (host === "figma.com" && ["file", "design", "proto", "board"].includes(parts[0]) && /^[A-Za-z0-9]{10,40}$/.test(parts[1] || "")) {
      const clean = `https://www.figma.com/${parts.slice(0, 3).map(encodeURIComponent).join("/")}${u.search}`;
      return { provider: "figma", src: `https://www.figma.com/embed?${new URLSearchParams({ embed_host: "meerpad", url: clean })}`, ratio: 16 / 10 };
    }
    return null;
  }
  E.embedSrc = embedSrc;
  const PROVIDER = { youtube: "YouTube video", vimeo: "Vimeo video", loom: "Loom video", maps: "Map", codepen: "CodePen", figma: "Figma file" };

  // --- late-loaded libraries ----------------------------------------------------------
  const MERMAID_JS = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
  const KATEX_JS = "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js";
  const KATEX_CSS = "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css";
  const loads = {};

  function loadScript(src) {
    if (!loads[src]) {
      loads[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.crossOrigin = "anonymous";
        s.onload = resolve;
        s.onerror = () => { delete loads[src]; reject(new Error(`Could not load ${src}`)); };
        document.head.append(s);
      });
    }
    return loads[src];
  }

  function loadCss(href) {
    if (!loads[href]) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.crossOrigin = "anonymous";
      document.head.append(l);
      loads[href] = Promise.resolve();
    }
    return loads[href];
  }

  const isDark = () => {
    const forced = document.documentElement.getAttribute("data-theme");
    return forced ? forced === "dark" : window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  };

  let mermaidSeq = 0;
  async function renderMermaid(target, source) {
    await loadScript(MERMAID_JS);
    // Initialised every time: cheap, and it follows a theme switch.
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "default" });
    const id = `meerpad-mermaid-${++mermaidSeq}`;
    try {
      const { svg } = await window.mermaid.render(id, source);
      // securityLevel "strict" runs the SVG through DOMPurify inside mermaid.
      target.innerHTML = svg;
    } finally {
      // A failed render leaves its scratch element in <body>.
      for (const stray of [document.getElementById(id), document.getElementById(`d${id}`)]) {
        if (stray && !target.contains(stray)) stray.remove();
      }
    }
  }

  async function renderTex(target, source) {
    loadCss(KATEX_CSS);
    await loadScript(KATEX_JS);
    window.katex.render(source, target, { displayMode: true, throwOnError: false, trust: false });
  }

  // Run fn once the element is near the viewport.
  P.lazy = function (target, fn) {
    if (!("IntersectionObserver" in window)) { fn(); return; }
    if (!this.io) {
      this.io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          this.io.unobserve(en.target);
          const f = en.target._lazyFn;
          en.target._lazyFn = null;
          if (f) f();
        }
      }, { rootMargin: "600px 0px" });
      this.offs.push(() => this.io.disconnect());
    }
    target._lazyFn = fn;
    this.io.observe(target);
  };

  // --- uploads -------------------------------------------------------------------------
  /* The upload names this page, so the server files it with the page. A page
     made moments ago may not have reached the server yet: push, then try
     again, and in the end upload without the page rather than not at all. */
  async function withPageRetry(run) {
    try {
      return await run(true);
    } catch (e) {
      if (e.status !== 404 && e.status !== 403) throw e;
      try { await App.sync.flush(); } catch (e2) { /* offline: the next attempt says so */ }
      try { return await run(true); } catch (e3) {
        if (e3.status !== 404 && e3.status !== 403) throw e3;
        return run(false);
      }
    }
  }

  P.uploadOne = function (file, onProgress) {
    return withPageRetry((withPage) => App.files.upload(file, { pageId: withPage ? this.pageId : null, onProgress }));
  };

  P.fetchUrl = function (url) {
    return withPageRetry((withPage) => App.files.fetchUrl(url, withPage ? this.pageId : null));
  };

  /* A progress placeholder among the blocks (DOM only: nothing is written
     until the file is there). `after` is a block id to follow, null for the
     top of the list, undefined for its end. */
  P.placeholder = function (parentId, after, label) {
    const ph = h("div", "blk-uploading");
    const icon = h("span", "up-icon");
    icon.innerHTML = App.icon("upload", 16);
    const name = h("span", "up-name", label);
    const bar = h("span", "up-bar");
    const fill = h("span", "up-fill");
    bar.append(fill);
    ph.append(icon, name, bar);
    const anchorEl = after ? this.els.get(after) : null;
    const container = parentId ? (this.els.get(parentId) || {})._kids || this.blocksEl : this.blocksEl;
    if (anchorEl && anchorEl.parentElement) anchorEl.after(ph);
    else if (after === null) container.prepend(ph);
    else container.append(ph);
    ph.progress = (p) => {
      ph.classList.toggle("is-indeterminate", p === null);
      if (p !== null) fill.style.width = `${Math.round(Math.max(0.03, p) * 100)}%`;
    };
    return ph;
  };

  /* Upload files one after another, each becoming an image block (image/*)
     or a file block where it was dropped or pasted. replaceId: an empty
     image or file block the first file fills instead. */
  P.uploadFiles = async function (files, { parentId = null, after, replaceId = null } = {}) {
    files = [...files].filter(Boolean);
    if (!files.length || this.readOnly) return [];
    if (!navigator.onLine) { App.toast("Files need a connection"); return []; }
    const created = [];
    let anchor = after;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fillId = i === 0 && replaceId && App.store.block(replaceId) ? replaceId : null;
      const fillEl = fillId ? this.els.get(fillId) : null;
      let ph;
      if (fillEl) {
        ph = this.placeholder(null, undefined, file.name || "file");
        fillEl.classList.add("is-uploading");
        fillEl._row.append(ph);
      } else {
        ph = this.placeholder(parentId, anchor, file.name || "file");
      }
      try {
        const res = await this.uploadOne(file, (p) => ph.progress(p));
        const ctype = res.content_type || file.type || "";
        const type = /^image\//.test(ctype) ? "image" : "file";
        const props = { file_id: res.id, name: res.filename || file.name || "file", size: res.size != null ? res.size : file.size, content_type: ctype };
        let b;
        if (fillId) {
          const cur = App.store.block(fillId);
          const keep = { ...(cur.props || {}) };
          delete keep.url;
          this.op("Upload", () => this.update(fillId, { type, props: { ...keep, ...props } }));
          b = App.store.block(fillId);
        } else {
          b = this.op("Upload", () => this.create({ parentId, after: anchor, type, props }));
        }
        if (b) { anchor = b.id; created.push(b); }
      } catch (err) {
        App.toast(err.message || "The upload failed", { kind: "error" });
      } finally {
        ph.remove();
        if (fillEl) fillEl.classList.remove("is-uploading");
      }
    }
    if (created.length) this.selectBlocks([created[created.length - 1].id]);
    return created;
  };

  // --- shared pieces -----------------------------------------------------------------
  function caption(ed, el, b) {
    const t = ed.textEl(el, b, { cls: "blk-caption", placeholder: "Write a caption…", role: "caption" });
    if (b.text) el.classList.add("has-caption");
    return t;
  }

  // A hover toolbar for media blocks.
  function mediaTools(ed, el, buttons) {
    const bar = h("div", "media-tools");
    for (const bt of buttons) {
      const b = h(bt.href ? "a" : "button", "media-tool");
      if (bt.href) { b.href = bt.href; b.target = "_blank"; b.rel = "noopener noreferrer"; if (bt.download) b.setAttribute("download", ""); }
      else b.type = "button";
      b.title = bt.title;
      b.setAttribute("aria-label", bt.title);
      b.innerHTML = App.icon(bt.icon, 15);
      if (bt.onClick) b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); bt.onClick(); });
      b.addEventListener("mousedown", (e) => e.stopPropagation());
      bar.append(b);
    }
    return bar;
  }

  function captionTool(ed, el) {
    return { icon: "text", title: "Caption", onClick: () => {
      el.classList.add("is-captioning");
      ed.focusCaption(el);
    } };
  }

  P.focusCaption = function (el) {
    if (!el._text) return;
    this.clearSelection();
    el._text.focus({ preventScroll: true });
    caret.set(el._text, readText(el._text).length);
  };

  // --- HEIC --------------------------------------------------------------------------------
  /* A HEIC photo shows only in Safari. Uploads are stored as WebP by the
     server (app/images.py); a block holding a HEIC from before that offers to
     convert it: the server makes a WebP copy, and the block points at it as
     an image, in one undo step. Not on a share link, which has no session to
     make a file with. */
  const isHeic = (p) => /^image\/hei[cf]/i.test(p.content_type || "") || /\.(heic|heif|hif)$/i.test(p.name || "");
  const canConvert = (ed, p) => Boolean(p.file_id) && !ed.readOnly && !App.files.shareToken && isHeic(p);
  const converting = new Set(); // file ids the server is converting

  function convertButton(ed, el, b, cls) {
    const bt = h("button", `${cls} convert-webp`, "Convert to WebP");
    bt.type = "button";
    bt.title = "Store this HEIC photo as WebP, which every browser shows";
    bt.addEventListener("mousedown", (e) => e.stopPropagation());
    bt.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ed.convertToWebp(b.id, el); });
    return bt;
  }

  P.convertToWebp = async function (id, el) {
    const b = App.store.block(id);
    const fileId = b && b.props && b.props.file_id;
    if (!fileId || converting.has(fileId)) return;
    if (!navigator.onLine) { App.toast("Converting needs a connection"); return; }
    converting.add(fileId);
    el.classList.add("is-converting");
    const btns = [...el.querySelectorAll(".convert-webp")];
    for (const bt of btns) { bt.disabled = true; bt.textContent = "Converting…"; }
    try {
      const res = await App.api.post(`/api/files/${encodeURIComponent(fileId)}/webp`, {}, { timeout: 180000 });
      const cur = App.store.block(id);
      // Deleted, or given another file while the server worked: leave it be.
      if (!cur || !cur.props || cur.props.file_id !== fileId) return;
      const props = { ...cur.props, file_id: res.id, name: res.filename, size: res.size, content_type: res.content_type };
      delete props.url;
      this.op("Convert to WebP", () => this.update(id, { type: "image", props }));
    } catch (err) {
      App.toast(err.message || "The conversion failed", { kind: "error" });
    } finally {
      converting.delete(fileId);
      el.classList.remove("is-converting");
      for (const bt of btns) { bt.disabled = false; bt.textContent = "Convert to WebP"; }
    }
  };

  // An empty image or file block: upload, link, or drop.
  function emptyMedia(ed, el, b, kind) {
    const box = h("div", "media-empty");
    const icon = h("span", "media-empty-icon");
    icon.innerHTML = App.icon(kind === "image" ? "image" : "file", 20);
    const label = h("span", "media-empty-label", kind === "image" ? "Add an image" : "Add a file or PDF");
    box.append(icon, label);
    if (ed.readOnly) { label.textContent = kind === "image" ? "Empty image" : "Empty file"; return box; }
    const input = h("input");
    input.type = "file";
    input.hidden = true;
    if (kind === "image") input.accept = "image/*";
    input.addEventListener("change", () => {
      if (input.files && input.files.length) ed.uploadFiles([...input.files].slice(0, 1), { replaceId: b.id });
    });
    const actions = h("span", "media-empty-actions");
    const up = h("button", "btn btn-small", "Upload");
    up.type = "button";
    up.addEventListener("click", (e) => { e.stopPropagation(); input.click(); });
    const link = h("button", "btn btn-small", "Paste link");
    link.type = "button";
    const form = urlForm(kind === "image" ? "Paste the image link…" : "Paste the file link…", (url) => ed.setProps(b.id, kind === "image" ? { url } : { url, name: fileNameOf(url) || hostOf(url) }));
    form.hidden = true;
    link.addEventListener("click", (e) => { e.stopPropagation(); form.hidden = false; actions.hidden = true; form._input.focus(); });
    actions.append(up, link);
    box.append(actions, input, form, h("span", "media-empty-hint", "or drop a file here"));
    el._activate = () => up.focus({ preventScroll: true });
    return box;
  }

  // A one-line "paste a link" form (bookmarks, embeds, image and file links).
  function urlForm(placeholder, onUrl) {
    const form = h("div", "url-form");
    const input = h("input", "input url-input");
    input.type = "url";
    input.placeholder = placeholder;
    const ok = h("button", "btn btn-small btn-primary", "Add");
    ok.type = "button";
    const submit = () => {
      let v = input.value.trim();
      if (v && !/^https?:\/\//i.test(v) && /^[\w-]+(\.[\w-]+)+/.test(v)) v = `https://${v}`;
      if (!httpUrl(v)) { input.classList.add("is-invalid"); input.focus(); return; }
      onUrl(v);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
    input.addEventListener("input", () => input.classList.remove("is-invalid"));
    ok.addEventListener("click", (e) => { e.stopPropagation(); submit(); });
    form.append(input, ok);
    form._input = input;
    return form;
  }

  // --- image ------------------------------------------------------------------------------
  function lightbox(src, alt) {
    const ov = h("div", "editor-lightbox");
    const img = h("img");
    img.src = src;
    img.alt = alt || "";
    ov.append(img);
    document.body.append(ov);
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    ov.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
  }
  E.lightbox = lightbox;

  types.image = {
    render(ed, el, b) {
      const p = b.props || {};
      const src = p.file_id ? App.files.url(p.file_id, p.name) : httpUrl(p.url);
      const row = h("div", "media-row");
      if (!src) { row.append(emptyMedia(ed, el, b, "image")); return { row }; }
      const frame = h("div", "img-frame");
      if (p.width) frame.style.width = `${Number(p.width)}px`;
      const img = h("img", "img");
      img.alt = App.markdown.plain(b.text || "") || p.name || "";
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.referrerPolicy = "no-referrer";
      img.src = src;
      img.addEventListener("error", () => frame.classList.add("is-broken"));
      img.addEventListener("click", () => lightbox(src, img.alt));
      const broken = h("div", "img-broken");
      if (isHeic(p)) {
        broken.append(h("span", null, "HEIC photos show only in Safari"));
        if (canConvert(ed, p)) broken.append(convertButton(ed, el, b, "btn btn-small"));
      } else {
        broken.textContent = "This image could not be loaded";
      }
      frame.append(img, broken);
      if (!ed.readOnly) {
        for (const side of ["left", "right"]) {
          const handle = h("span", `img-handle img-handle-${side}`);
          handle.addEventListener("pointerdown", (e) => startResize(ed, b.id, frame, row, side, e));
          frame.append(handle);
        }
        frame.append(mediaTools(ed, el, [
          captionTool(ed, el),
          ...(canConvert(ed, p) ? [{ icon: "refresh", title: "Convert to WebP", onClick: () => ed.convertToWebp(b.id, el) }] : []),
          { icon: "external", title: "Open original", href: src },
        ]));
      }
      // The caption sits under the picture, as wide as it is.
      const col = h("div", "img-col");
      col.append(frame, caption(ed, el, b));
      row.append(col);
      return { row };
    },
  };

  // Drag an edge; the image stays centred, so the width changes twice as fast
  // as the pointer moves and the edge stays under it.
  function startResize(ed, id, frame, row, side, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startW = frame.getBoundingClientRect().width;
    const max = row.getBoundingClientRect().width;
    const sign = side === "right" ? 1 : -1;
    handle.setPointerCapture(e.pointerId);
    frame.classList.add("is-resizing");
    const move = (ev) => {
      const w = Math.max(80, Math.min(max, startW + sign * 2 * (ev.clientX - startX)));
      frame.style.width = `${Math.round(w)}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      frame.classList.remove("is-resizing");
      const w = Math.round(frame.getBoundingClientRect().width);
      if (Math.abs(w - startW) >= 2) ed.setProps(id, { width: w });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  }

  // --- file -------------------------------------------------------------------------------
  const isPdf = (p, name) => /pdf/i.test(p.content_type || "") || /\.pdf($|[?#])/i.test(name || p.url || "");

  types.file = {
    render(ed, el, b) {
      const p = b.props || {};
      const row = h("div", "media-row");
      const href = p.file_id ? App.files.url(p.file_id, p.name) : httpUrl(p.url);
      if (!href) { row.append(emptyMedia(ed, el, b, "file")); return { row }; }
      const name = p.name || fileNameOf(href) || "File";
      const pdf = isPdf(p, name);
      const card = h("div", "file-card");
      const a = h("a", "file-main");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.draggable = false;
      const icon = h("span", "file-icon");
      icon.innerHTML = App.icon(pdf ? "pdf" : "file", 20);
      const meta = h("span", "file-meta");
      meta.append(h("span", "file-name", name));
      const sub = [p.size != null && p.size !== "" ? App.fmt.bytes(p.size) : "", p.file_id ? "" : hostOf(href)].filter(Boolean).join(" · ");
      if (sub) meta.append(h("span", "file-size", sub));
      a.append(icon, meta);
      card.append(a);
      const acts = h("span", "file-actions");
      if (pdf) {
        const prev = h("button", "file-btn", p.preview ? "Hide preview" : "Preview");
        prev.type = "button";
        prev.setAttribute("aria-pressed", String(Boolean(p.preview)));
        prev.addEventListener("click", (e) => {
          e.stopPropagation();
          if (ed.readOnly) { el.classList.toggle("show-preview"); renderPreview(); }
          else ed.setProps(b.id, { preview: !p.preview });
        });
        acts.append(prev);
      }
      if (canConvert(ed, p)) acts.append(convertButton(ed, el, b, "file-btn"));
      if (!ed.readOnly) {
        const cap = h("button", "file-btn");
        cap.type = "button";
        cap.title = "Caption";
        cap.setAttribute("aria-label", "Caption");
        cap.innerHTML = App.icon("text", 15);
        cap.addEventListener("click", (e) => { e.stopPropagation(); el.classList.add("is-captioning"); ed.focusCaption(el); });
        acts.append(cap);
      }
      const dl = h("a", "file-btn file-dl");
      dl.href = p.file_id ? App.files.url(p.file_id, p.name, { download: true }) : href;
      dl.setAttribute("download", name);
      dl.title = "Download";
      dl.setAttribute("aria-label", "Download");
      dl.innerHTML = App.icon("download", 15);
      acts.append(dl);
      card.append(acts);
      row.append(card);
      const frameHost = h("div", "pdf-host");
      row.append(frameHost);
      const renderPreview = () => {
        frameHost.textContent = "";
        if (p.preview || el.classList.contains("show-preview")) {
          const f = h("iframe", "pdf-frame");
          f.src = href;
          f.title = name;
          f.loading = "lazy";
          frameHost.append(f);
        }
      };
      if (pdf) renderPreview();
      row.append(caption(ed, el, b));
      return { row };
    },
  };

  // --- bookmark and embed ------------------------------------------------------------------
  function linkCard(url, title, desc) {
    const a = h("a", "bookmark-card");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.draggable = false;
    const text = h("span", "bm-text");
    let path = "";
    try { const u = new URL(url); path = (u.pathname + u.search).replace(/\/$/, ""); } catch (e) { /* keep empty */ }
    text.append(h("span", "bm-title", title || hostOf(url) + (path && path.length < 60 ? path : "")));
    if (desc) text.append(h("span", "bm-desc", desc));
    const line = h("span", "bm-url");
    line.innerHTML = App.icon("link", 13);
    line.append(document.createTextNode(url));
    text.append(line);
    a.append(text);
    return a;
  }

  types.bookmark = {
    render(ed, el, b) {
      const p = b.props || {};
      const row = h("div", "media-row");
      const url = httpUrl(p.url);
      if (!url) {
        if (ed.readOnly) { row.append(h("div", "media-empty", "Empty bookmark")); return { row }; }
        const form = urlForm("Paste a link to bookmark…", (u) => ed.setProps(b.id, { url: u }));
        const box = h("div", "media-empty media-empty-form");
        const icon = h("span", "media-empty-icon");
        icon.innerHTML = App.icon("bookmark", 18);
        box.append(icon, form);
        row.append(box);
        el._activate = () => form._input.focus();
        return { row };
      }
      const card = linkCard(url, p.title, p.description);
      row.append(card);
      if (!ed.readOnly) row.append(mediaTools(ed, el, [captionTool(ed, el)]));
      row.append(caption(ed, el, b));
      return { row };
    },
  };

  types.embed = {
    render(ed, el, b) {
      const p = b.props || {};
      const row = h("div", "media-row");
      const url = httpUrl(p.url);
      if (!url) {
        if (ed.readOnly) { row.append(h("div", "media-empty", "Empty embed")); return { row }; }
        const form = urlForm("Paste a YouTube, Vimeo, Loom, Google Maps, CodePen or Figma link…", (u) => ed.setProps(b.id, { url: u }));
        const box = h("div", "media-empty media-empty-form");
        const icon = h("span", "media-empty-icon");
        icon.innerHTML = App.icon("embed", 18);
        box.append(icon, form);
        row.append(box);
        el._activate = () => form._input.focus();
        return { row };
      }
      const found = embedSrc(url);
      if (!found) {
        // Not on the allow-list: a link card, never an iframe to anywhere.
        row.append(linkCard(url, p.title, ""));
      } else {
        const frame = h("div", `embed-frame embed-${found.provider}`);
        if (found.ratio) frame.style.aspectRatio = String(found.ratio);
        else frame.style.height = `${found.height}px`;
        const f = h("iframe");
        f.src = found.src;
        f.title = PROVIDER[found.provider] || "Embedded content";
        f.loading = "lazy";
        f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-presentation allow-forms");
        f.setAttribute("allow", "fullscreen; picture-in-picture; encrypted-media; clipboard-write");
        f.referrerPolicy = "strict-origin-when-cross-origin";
        frame.append(f);
        row.append(frame);
      }
      if (!ed.readOnly) row.append(mediaTools(ed, el, [captionTool(ed, el), { icon: "external", title: "Open original", href: url }]));
      row.append(caption(ed, el, b));
      return { row };
    },
  };

  // --- page links and inline databases ------------------------------------------------------
  function pageIcon(p, fallback) {
    const span = h("span", "pl-icon");
    const ref = p && p.icon ? App.files.ref(p.icon) : null;
    if (App.files.isGlyph(ref)) span.append(App.glyph(ref));
    else if (ref && ref.kind === "url") {
      const img = h("img");
      img.src = ref.url;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      span.append(img);
    } else span.innerHTML = App.icon(fallback, 18);
    return span;
  }

  function pageCard(ed, pid, kind) {
    const p = pid ? App.store.page(pid) : null;
    const gone = !p || App.store.isTrashed(pid);
    const a = h("a", `page-card${gone ? " is-deleted" : ""}`);
    a.href = pid ? (App.nav && App.nav.pageHref ? App.nav.pageHref(pid) : `/p/${pid}`) : "#";
    a.draggable = false;
    if (pid) a.dataset.pageId = pid;
    a.append(pageIcon(p, kind === "database" ? "database" : "page"));
    a.append(h("span", "pl-title", !p ? "Page not found" : gone ? `${titleOf(p)} (deleted)` : titleOf(p)));
    a.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (pid && App.nav && App.nav.openPage) App.nav.openPage(pid);
    });
    return a;
  }

  types.page = {
    render(ed, el, b) {
      const row = h("div");
      row.append(pageCard(ed, (b.props || {}).page_id, "page"));
      return { row };
    },
  };

  types.database = {
    render(ed, el, b) {
      const p = b.props || {};
      const pid = p.page_id;
      if (App.database && App.database.mount && pid && App.store.page(pid) && !App.store.isTrashed(pid)) {
        const host = h("div", "db-host");
        let handle = null;
        try {
          handle = App.database.mount(host, { pageId: pid, inline: true, readOnly: ed.readOnly, viewId: p.view_id || null });
        } catch (e) {
          console.error(e);
          host.append(pageCard(ed, pid, "database"));
        }
        el._destroy = () => { if (handle && handle.destroy) handle.destroy(); };
        return { row: host };
      }
      const row = h("div");
      row.append(pageCard(ed, pid, "database"));
      return { row };
    },
  };

  // --- code (and Mermaid) ----------------------------------------------------------------------
  types.code = {
    render(ed, el, b) {
      const p = b.props || {};
      const lang = p.language || "plain";
      const mermaid = lang === "mermaid";
      el.classList.toggle("is-mermaid", mermaid);
      const row = h("div", "code-wrap");
      const head = h("div", "code-head");
      const langBtn = h(ed.readOnly ? "span" : "button", "code-lang", E.langLabel ? E.langLabel(lang) : lang);
      if (!ed.readOnly) {
        langBtn.type = "button";
        langBtn.addEventListener("mousedown", (e) => e.preventDefault());
        langBtn.addEventListener("click", (e) => { e.stopPropagation(); ed.openLanguageMenu(langBtn, el); });
      }
      const copy = h("button", "code-copy");
      copy.type = "button";
      copy.innerHTML = `${App.icon("copy", 13)}<span>Copy</span>`;
      copy.addEventListener("mousedown", (e) => e.preventDefault());
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        const text = el._text ? readText(el._text) : b.text || "";
        const ok = () => App.toast("Copied");
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => App.toast("Could not copy"));
      });
      head.append(langBtn, h("span", "code-spacer"), copy);
      const body = h("div", "code-body");
      const src = ed.textEl(el, b, { cls: "code-src", plain: true, role: "code", placeholder: mermaid ? "graph TD\n  A --> B" : "" });
      body.append(src);
      row.append(head, body);
      // The first code block on screen fetches the highlighter; until it is
      // here the code shows plain, then repaints in place (the caret stays,
      // since highlighting never changes the text).
      if (App.highlight && App.highlight.wants(lang) && !App.highlight.ready()) {
        App.highlight.load().then((ok) => {
          if (!ok || !src.isConnected) return;
          const focused = document.activeElement === src;
          ed.repaint(src, readText(src), focused ? caret.get(src) : null);
        });
      }
      if (mermaid) {
        const view = h("div", "mermaid-view");
        view.setAttribute("role", "img");
        row.append(view);
        const draw = () => {
          const src = el._text ? readText(el._text) : b.text || "";
          if (!src.trim()) { view.textContent = ""; el.classList.remove("has-view"); return; }
          renderMermaid(view, src).then(() => el.classList.add("has-view")).catch((err) => {
            el.classList.remove("has-view");
            view.textContent = "";
            view.append(h("div", "mermaid-error", navigator.onLine ? `Diagram error: ${String(err && err.message || err).split("\n")[0]}` : "The diagram shows when online"));
          });
        };
        // Editing shows the source above the diagram; leaving draws it again.
        el._edit = (on) => {
          el.classList.toggle("is-editing", on);
          if (!on) draw();
        };
        if (!ed.readOnly) {
          view.addEventListener("click", () => {
            if (!el.classList.contains("is-editing")) ed.focusBlock(b.id, "end");
          });
        }
        ed.lazy(view, draw);
      }
      return { row };
    },
  };

  // --- equation ------------------------------------------------------------------------------------
  types.equation = {
    render(ed, el, b) {
      const row = h("div", "eq-wrap");
      const view = h("div", "eq-view");
      const edit = h("div", "eq-edit");
      const src = ed.textEl(el, b, { cls: "eq-src", plain: true, role: "equation", placeholder: "E = mc^2" });
      edit.append(src);
      if (!ed.readOnly) edit.append(h("div", "eq-hint", "Enter to finish, Shift+Enter for a new line"));
      row.append(view, edit);
      const draw = () => {
        const tex = el._text ? readText(el._text) : b.text || "";
        view.textContent = "";
        if (!tex.trim()) { view.append(h("span", "eq-empty", ed.readOnly ? "Empty equation" : "Add a TeX equation")); return; }
        const out = h("div", "eq-out");
        view.append(out);
        renderTex(out, tex).catch(() => { out.textContent = tex; out.classList.add("eq-source"); });
      };
      el._edit = (on) => {
        el.classList.toggle("is-editing", on);
        if (!on) draw();
      };
      el._preview = () => {
        clearTimeout(el._eqTimer);
        el._eqTimer = setTimeout(draw, 250);
      };
      if (!ed.readOnly) {
        view.addEventListener("click", () => {
          if (!el.classList.contains("is-editing")) ed.focusBlock(b.id, "end");
        });
      }
      ed.lazy(view, draw);
      return { row };
    },
  };

  // --- table ------------------------------------------------------------------------------------------
  /* A grid of small editables, one per cell, each holding inline Markdown
     with the same live preview as a block. The whole grid is one prop
     (rows: string[][]), saved as a whole when typing pauses or the table
     loses focus. */
  function normRows(rows) {
    let r = Array.isArray(rows) ? rows.map((x) => (Array.isArray(x) ? x.map((c) => (c == null ? "" : String(c))) : [])) : [];
    if (!r.length) r = [[""]];
    const w = Math.max(1, ...r.map((x) => x.length));
    return r.map((x) => [...x, ...Array(w - x.length).fill("")]);
  }

  types.table = {
    render(ed, el, b) {
      const p = b.props || {};
      const rows = normRows(p.rows);
      const row = h("div", "table-row");
      const wrap = h("div", "tbl-wrap");
      const table = h("table", `tbl${p.header_row ? " has-head-row" : ""}${p.header_col ? " has-head-col" : ""}`);
      const tbody = h("tbody");
      rows.forEach((r, i) => {
        const tr = h("tr");
        r.forEach((c, j) => {
          const head = (i === 0 && p.header_row) || (j === 0 && p.header_col);
          const td = h(head ? "th" : "td");
          const cell = h("div", "tbl-cell");
          cell.dataset.r = String(i);
          cell.dataset.c = String(j);
          if (!ed.readOnly) { cell.contentEditable = "plaintext-only"; cell.spellcheck = true; }
          cell.innerHTML = ed.htmlFor(cell, c);
          td.append(cell);
          tr.append(td);
        });
        tbody.append(tr);
      });
      table.append(tbody);
      wrap.append(table);
      row.append(wrap);
      el._table = table;
      el._activate = () => ed.focusCell(el, 0, 0);
      if (!ed.readOnly) {
        const addRow = h("button", "tbl-add tbl-add-row");
        addRow.type = "button";
        addRow.title = "Add a row";
        addRow.innerHTML = App.icon("plus", 14);
        addRow.addEventListener("mousedown", (e) => e.preventDefault());
        addRow.addEventListener("click", () => ed.tableEdit(el, "row-end"));
        const addCol = h("button", "tbl-add tbl-add-col");
        addCol.type = "button";
        addCol.title = "Add a column";
        addCol.innerHTML = App.icon("plus", 14);
        addCol.addEventListener("mousedown", (e) => e.preventDefault());
        addCol.addEventListener("click", () => ed.tableEdit(el, "col-end"));
        wrap.append(addCol);
        row.append(addRow);
        const tools = h("div", "tbl-tools");
        const tool = (label, action, pressed) => {
          const bt = h("button", "tbl-tool", label);
          bt.type = "button";
          if (pressed !== undefined) bt.setAttribute("aria-pressed", String(pressed));
          bt.addEventListener("mousedown", (e) => e.preventDefault());
          bt.addEventListener("click", () => ed.tableEdit(el, action));
          return bt;
        };
        tools.append(
          tool("Header row", "toggle-head-row", Boolean(p.header_row)),
          tool("Header column", "toggle-head-col", Boolean(p.header_col)),
          tool("Delete row", "row-delete"),
          tool("Delete column", "col-delete"),
        );
        row.append(tools);
      }
      return { row };
    },
  };

  const cellOf = (node) => (node && node.closest ? node.closest(".tbl-cell") : null);

  P.readTable = function (el) {
    const out = [];
    for (const cell of el._table.querySelectorAll(".tbl-cell")) {
      const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
      (out[r] ||= [])[c] = readText(cell);
    }
    return normRows(out);
  };

  P.saveTable = function (el) {
    clearTimeout(el._tableTimer);
    if (!el._tableDirty || !el._table) return;
    el._tableDirty = false;
    if (this.dirtyTables) this.dirtyTables.delete(el);
    const b = App.store.block(el.dataset.id);
    if (!b || b.deleted) return;
    const rows = this.readTable(el);
    if (JSON.stringify(rows) === JSON.stringify(normRows((b.props || {}).rows))) return;
    const props = { ...(b.props || {}), rows };
    // Recorded before the write, so the store's notification finds nothing to
    // redo and the cell keeps its caret.
    el._b.props = JSON.stringify(props);
    App.store.updateBlock(b.id, { props });
  };

  P.saveCells = function () {
    for (const el of [...(this.dirtyTables || [])]) this.saveTable(el);
  };

  P.focusCell = function (el, r, c, where = "end") {
    const cell = el._table && el._table.querySelector(`.tbl-cell[data-r="${r}"][data-c="${c}"]`);
    if (!cell) return false;
    this.clearSelection();
    cell.focus({ preventScroll: true });
    const len = readText(cell).length;
    caret.set(cell, where === "start" ? 0 : len);
    return true;
  };

  // Row and column edits, relative to the cell last focused.
  P.tableEdit = function (el, action) {
    if (this.readOnly) return;
    this.saveTable(el);
    const b = App.store.block(el.dataset.id);
    if (!b) return;
    const p = b.props || {};
    let rows = normRows(p.rows);
    const at = el._lastCell || { r: rows.length - 1, c: rows[0].length - 1 };
    let focus = { r: at.r, c: at.c };
    const w = rows[0].length;
    const patch = {};
    if (action === "row-end") { rows.push(Array(w).fill("")); focus = { r: rows.length - 1, c: 0 }; }
    else if (action === "col-end") { rows = rows.map((r) => [...r, ""]); focus = { r: 0, c: w }; }
    else if (action === "row-above" || action === "row-below") {
      const i = action === "row-above" ? at.r : at.r + 1;
      rows.splice(i, 0, Array(w).fill(""));
      focus = { r: i, c: at.c };
    } else if (action === "col-left" || action === "col-right") {
      const j = action === "col-left" ? at.c : at.c + 1;
      rows = rows.map((r) => { const x = [...r]; x.splice(j, 0, ""); return x; });
      focus = { r: at.r, c: j };
    } else if (action === "row-delete") {
      if (rows.length <= 1) { this.deleteBlocks([b.id]); return; }
      rows.splice(at.r, 1);
      focus = { r: Math.min(at.r, rows.length - 1), c: at.c };
    } else if (action === "col-delete") {
      if (w <= 1) { this.deleteBlocks([b.id]); return; }
      rows = rows.map((r) => r.filter((_, j) => j !== at.c));
      focus = { r: at.r, c: Math.min(at.c, w - 2) };
    } else if (action === "toggle-head-row") patch.header_row = !p.header_row;
    else if (action === "toggle-head-col") patch.header_col = !p.header_col;
    this.op("Edit table", () => this.update(b.id, { props: { ...p, ...patch, rows } }));
    const fresh = this.els.get(b.id);
    if (fresh) { fresh._lastCell = focus; this.focusCell(fresh, focus.r, focus.c); }
  };

  P.cellMenu = function (el, cell, x, y) {
    const b = App.store.block(el.dataset.id);
    const p = (b && b.props) || {};
    const act = (a) => () => this.tableEdit(el, a);
    this.menu = App.ui.menu({ x, y }, [
      { label: "Insert row above", icon: "plus", onSelect: act("row-above") },
      { label: "Insert row below", icon: "plus", onSelect: act("row-below") },
      { label: "Insert column left", icon: "plus", onSelect: act("col-left") },
      { label: "Insert column right", icon: "plus", onSelect: act("col-right") },
      { divider: true },
      { label: "Header row", icon: "table", checked: Boolean(p.header_row), onSelect: act("toggle-head-row") },
      { label: "Header column", icon: "table", checked: Boolean(p.header_col), onSelect: act("toggle-head-col") },
      { divider: true },
      { label: "Delete row", icon: "trash", danger: true, onSelect: act("row-delete") },
      { label: "Delete column", icon: "trash", danger: true, onSelect: act("col-delete") },
    ], { className: "cell-menu" });
  };

  /* Typing and moving around in cells. Wired once per editor, on the blocks
     container, from app.editor.input.js. */
  P.wireTables = function () {
    this.dirtyTables = new Set();
    const root = this.blocksEl;
    root.addEventListener("input", (e) => {
      const cell = cellOf(e.target);
      if (!cell || this.composing) return;
      const el = this.blockOf(cell);
      const text = readText(cell);
      this.repaint(cell, text, caret.get(cell));
      el._tableDirty = true;
      this.dirtyTables.add(el);
      clearTimeout(el._tableTimer);
      el._tableTimer = setTimeout(() => this.saveTable(el), 400);
    });
    root.addEventListener("focusin", (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      const el = this.blockOf(cell);
      el._lastCell = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
      this.clearSelection();
    });
    root.addEventListener("focusout", (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      const el = this.blockOf(cell);
      if (!el || (e.relatedTarget && el._table && el._table.contains(e.relatedTarget))) return;
      this.saveTable(el);
      if (el._stale || el._deferred) {
        el._stale = false;
        el._deferred = null;
        const b = App.store.block(el.dataset.id);
        if (b && !b.deleted) this.refill(el, b);
      }
    });
    root.addEventListener("contextmenu", (e) => {
      const cell = cellOf(e.target);
      if (!cell || this.readOnly) return;
      e.preventDefault();
      const el = this.blockOf(cell);
      el._lastCell = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
      this.cellMenu(el, cell, e.clientX, e.clientY);
    });
    root.addEventListener("paste", (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      e.preventDefault();
      e.stopPropagation();
      const text = (e.clipboardData.getData("text/plain") || "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
      const el = this.blockOf(cell);
      // A spreadsheet range (tabs and lines) fills cells from here, growing
      // the table as needed.
      if (text.includes("\t") || (text.includes("\n") && text.split("\n").length > 1 && /\t/.test(text))) {
        this.saveTable(el);
        const grid = text.split("\n").map((l) => l.split("\t"));
        const b = App.store.block(el.dataset.id);
        let rows = normRows((b.props || {}).rows);
        const r0 = Number(cell.dataset.r), c0 = Number(cell.dataset.c);
        grid.forEach((line, i) => line.forEach((v, j) => {
          while (rows.length <= r0 + i) rows.push(Array(rows[0].length).fill(""));
          if (rows[0].length <= c0 + j) rows = rows.map((r) => [...r, ...Array(c0 + j + 1 - r.length).fill("")]);
          rows[r0 + i][c0 + j] = v.trim();
        }));
        this.op("Paste", () => this.update(b.id, { props: { ...(b.props || {}), rows } }));
        const fresh = this.els.get(b.id);
        if (fresh) this.focusCell(fresh, r0, c0);
        return;
      }
      const cur = readText(cell);
      const sel = caret.get(cell) || { start: cur.length, end: cur.length };
      const next = cur.slice(0, sel.start) + text + cur.slice(sel.end);
      cell.innerHTML = this.htmlFor(cell, next);
      caret.set(cell, sel.start + text.length);
      el._tableDirty = true;
      this.dirtyTables.add(el);
      this.saveTable(el);
    }, true);
    root.addEventListener("keydown", (e) => {
      const cell = cellOf(e.target);
      if (!cell || e.isComposing) return;
      const el = this.blockOf(cell);
      const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
      const rows = el._table.querySelectorAll("tr").length;
      const cols = el._table.querySelector("tr").children.length;
      const modk = e.ctrlKey || e.metaKey;
      const go = (nr, nc, where) => { e.preventDefault(); e.stopPropagation(); this.focusCell(el, nr, nc, where); };
      if (modk && (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y")) {
        e.preventDefault(); e.stopPropagation();
        this.saveTable(el);
        this.undo(e.key === "y" || e.key === "Y" || e.shiftKey);
        return;
      }
      if (e.key === "Tab") {
        if (e.shiftKey) {
          if (c > 0) go(r, c - 1); else if (r > 0) go(r - 1, cols - 1);
          else e.preventDefault();
        } else if (c < cols - 1) go(r, c + 1);
        else if (r < rows - 1) go(r + 1, 0);
        else { e.preventDefault(); e.stopPropagation(); el._lastCell = { r, c }; this.tableEdit(el, "row-end"); }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !modk) {
        if (r < rows - 1) go(r + 1, c);
        else { e.preventDefault(); e.stopPropagation(); el._lastCell = { r, c }; this.tableEdit(el, "row-end"); this.focusCell(this.els.get(el.dataset.id), rows, c); }
        return;
      }
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        const cur = readText(cell);
        const sel = caret.get(cell) || { start: cur.length, end: cur.length };
        const next = `${cur.slice(0, sel.start)}\n${cur.slice(sel.end)}`;
        cell.innerHTML = this.htmlFor(cell, next);
        caret.set(cell, sel.start + 1);
        el._tableDirty = true;
        this.dirtyTables.add(el);
        clearTimeout(el._tableTimer);
        el._tableTimer = setTimeout(() => this.saveTable(el), 400);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        this.saveTable(el);
        this.selectBlocks([el.dataset.id]);
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !modk) {
        const info = this.lineInfo ? this.lineInfo(cell) : { first: true, last: true };
        if (e.key === "ArrowUp" && info.first) {
          if (r > 0) go(r - 1, c);
          else { const prev = this.prevText(el); if (prev) { e.preventDefault(); this.saveTable(el); this.focusBlock(prev.dataset.id, "end"); } }
        } else if (e.key === "ArrowDown" && info.last) {
          if (r < rows - 1) go(r + 1, c);
          else { const next = this.nextText(el); if (next) { e.preventDefault(); this.saveTable(el); this.focusBlock(next.dataset.id, "start"); } }
        }
      }
    });
  };
})();
