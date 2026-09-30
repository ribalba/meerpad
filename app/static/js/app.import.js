/* Import from Notion: upload Notion's "Markdown & CSV" export and watch the
   server turn it into pages (docs/DESIGN.md §7 and §10).

   The dialog has three stages, each replacing the one before in place:

     setup      how to export from Notion, the .zip, where the pages go
     uploading  an XHR with a progress bar (fetch has no upload progress)
     job        the server's import job, polled every 2 s until done or error

   The import itself runs on the server, so closing the dialog while it runs
   only stops the polling; the pages still arrive, with the next sync. An upload
   in progress also carries on after a close (the XHR does not belong to the
   dialog) and says how it went in a toast. */

window.App = window.App || {};

App.import = (() => {
  const h = App.el;
  const POLL_MS = 2000;
  const STAT_LABELS = [
    ["pages", "Pages"], ["databases", "Databases"], ["rows", "Database rows"],
    ["blocks", "Blocks"], ["files", "Files"],
  ];
  // The importer's progress phases (app/routers/imports.py, app/notion_import.py).
  const PHASES = {
    queued: "Waiting to start…",
    starting: "Starting…",
    extracting: "Unpacking the export…",
    scanning: "Reading the export…",
    importing: "Importing pages…",
  };

  const isZip = (file) => /\.zip$/i.test(file.name || "") || /zip/i.test(file.type || "");
  const isEmoji = (icon) => icon && !icon.includes(":") && !/^https?:/i.test(icon);
  const num = (n) => Number(n || 0).toLocaleString();

  /* replaceChildren, minus the nulls: the DOM would print them as "null". */
  const fill = (el, ...nodes) => el.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));

  async function copyText(text, label = "Copied") {
    // The shell's copy (with its fallback and toast) once the app has one.
    if (App.shell && typeof App.shell.copy === "function") return App.shell.copy(text, label);
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Clipboard API refused (http, an old WebView): the textarea trick.
      const ta = h("textarea", { style: "position:fixed;opacity:0;top:0;left:0" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* nothing more to try */ }
      ta.remove();
    }
    App.toast(label, { kind: "ok", duration: 2000 });
  }

  /* Something a shell reads as one word, for the command line example. */
  const shellQuote = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;

  function open({ workspaceId, parentPageId } = {}) {
    const st = {
      file: null,
      wsId: null,
      parentId: null,
      stage: "setup",
      xhr: null,
      job: null,
      token: (App.me && App.me.api_token) || null,
      tokenShown: false,
      synced: false,
    };
    let closed = false;
    let pollTimer = null;
    const ui = {};

    // --- where the pages go ------------------------------------------------------
    const workspaces = () => App.store.workspaces();
    const rootOf = (wsId) => App.store.rootPage(wsId);
    const canHold = (p) => p && !p.deleted && p.kind !== "database" && !App.store.isRow(p.id);

    (function pickDefaults() {
      let ws = workspaceId ? App.store.workspace(workspaceId) : null;
      const parent = parentPageId ? App.store.page(parentPageId) : null;
      if (!ws && parent) ws = App.store.workspace(parent.workspace_id);
      if (!ws && App.nav && typeof App.nav.current === "function") {
        // The workspace of the page on screen.
        const open = App.store.page(App.nav.current());
        if (open) ws = App.store.workspace(open.workspace_id);
      }
      if (!ws || ws.deleted) ws = workspaces()[0] || null;
      st.wsId = ws ? ws.id : null;
      st.parentId = parent && ws && parent.workspace_id === ws.id && canHold(parent) ? parent.id : (ws ? ws.root_page_id : null);
    })();

    // --- the modal -------------------------------------------------------------------
    const body = h("div", { class: "imp" });
    const foot = h("div", { class: "modal-foot imp-foot" });
    const modal = App.ui.modal({
      title: "Import from Notion",
      body,
      className: "imp-modal",
      onClose: () => {
        closed = true;
        clearTimeout(pollTimer);
        window.removeEventListener("online", onNetwork);
        window.removeEventListener("offline", onNetwork);
        if (st.stage === "uploading" && st.xhr) {
          App.toast("The upload continues in the background. Keep this tab open until it is done.", { duration: 6000 });
        }
      },
    });
    modal.el.append(foot);
    const backdrop = modal.el.parentElement;

    function onNetwork() { if (st.stage === "setup") updateSetupState(); }
    window.addEventListener("online", onNetwork);
    window.addEventListener("offline", onNetwork);

    // Drop anywhere on the dialog (the backdrop included, so a drop that misses
    // the box does not make the browser open the zip instead).
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    backdrop.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      if (st.stage === "setup") modal.el.classList.add("imp-dragging");
    });
    backdrop.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = st.stage === "setup" ? "copy" : "none";
    });
    backdrop.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) modal.el.classList.remove("imp-dragging");
    });
    backdrop.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      modal.el.classList.remove("imp-dragging");
      if (st.stage !== "setup") return;
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) chooseFile(file);
    });

    // --- stage 1: setup ------------------------------------------------------------------
    function renderSetup() {
      st.stage = "setup";
      const how = h("div", { class: "imp-howto" },
        h("div", { class: "imp-howto-title" }, h("span", { html: App.icon("info", 15) }), "In Notion"),
        h("ol", { class: "imp-steps" },
          h("li", {}, "Open ", h("strong", { text: "Settings" }), ", then ", h("strong", { text: "Export" }),
            " (or ", h("strong", { text: "Export" }), " in a page's ", h("strong", { text: "•••" }), " menu for just that page)."),
          h("li", {}, "Choose ", h("strong", { text: "Markdown & CSV" }), ", and turn on ", h("strong", { text: "Include subpages" }),
            " and ", h("strong", { text: "Include files and images" }), "."),
          h("li", {}, "Download the .zip and drop it here as it is. No need to unpack it; zips inside the zip are fine.")));

      ui.fileInput = h("input", { type: "file", accept: ".zip,application/zip,application/x-zip-compressed", hidden: true });
      ui.fileInput.addEventListener("change", () => {
        if (ui.fileInput.files && ui.fileInput.files[0]) chooseFile(ui.fileInput.files[0]);
        ui.fileInput.value = ""; // choosing the same file again still fires "change"
      });
      ui.drop = h("div", { class: "imp-drop" });
      ui.fileError = h("div", { class: "field-error", hidden: true, role: "alert" });

      ui.wsSelect = h("select", { class: "select imp-ws-select", "aria-label": "Workspace" });
      ui.wsSelect.addEventListener("change", () => {
        st.wsId = ui.wsSelect.value;
        const ws = App.store.workspace(st.wsId);
        st.parentId = ws ? ws.root_page_id : null;
        renderParent();
        renderCli();
      });
      ui.parentBtn = h("button", { class: "btn imp-parent-btn", type: "button", onclick: pickParent });
      ui.parentReset = h("button", { class: "link-btn imp-parent-reset", type: "button", text: "Use the workspace's top level", onclick: () => {
        const ws = App.store.workspace(st.wsId);
        st.parentId = ws ? ws.root_page_id : null;
        renderParent();
        renderCli();
      } });

      ui.error = h("div", { class: "note note-danger imp-error", hidden: true, role: "alert" });
      ui.offline = h("div", { class: "note note-warning", hidden: true },
        h("span", { html: App.icon("cloud-off", 16) }),
        h("div", {}, h("p", { text: "You are offline. Importing needs a connection; the dialog is ready once you are back online." })));

      body.replaceChildren(
        how,
        h("div", { class: "imp-block" }, ui.drop, ui.fileError, ui.fileInput),
        h("div", { class: "imp-block" },
          h("h3", { class: "section-title", text: "Import into" }),
          h("div", { class: "field-row imp-target" },
            h("div", { class: "field" }, h("label", { class: "field-label", text: "Workspace" }), ui.wsSelect),
            h("div", { class: "field" }, h("label", { class: "field-label", text: "Under the page" }), ui.parentBtn)),
          ui.parentReset),
        ui.offline,
        ui.error,
        cliSection());
      renderDrop();
      renderWorkspaces();
      renderParent();
      renderCli();
      foot.replaceChildren(
        h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => modal.close() }),
        ui.submit = h("button", { class: "btn btn-primary", type: "button", onclick: startUpload },
          h("span", { html: App.icon("import", 15) }), "Import"));
      updateSetupState();
    }

    function renderDrop() {
      const f = st.file;
      ui.drop.classList.toggle("has-file", Boolean(f));
      if (!f) {
        ui.drop.replaceChildren(
          h("span", { class: "imp-drop-icon", html: App.icon("upload", 22) }),
          h("div", { class: "imp-drop-title", text: "Drop the export .zip here" }),
          h("div", { class: "imp-drop-sub" }, "or ",
            h("button", { class: "text-link", type: "button", text: "choose a file", onclick: () => ui.fileInput.click() })));
        ui.drop.onclick = (e) => { if (e.target === ui.drop || !e.target.closest("button")) ui.fileInput.click(); };
        ui.drop.setAttribute("role", "button");
        ui.drop.tabIndex = 0;
        ui.drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ui.fileInput.click(); } };
        return;
      }
      ui.drop.onclick = null;
      ui.drop.onkeydown = null;
      ui.drop.removeAttribute("role");
      ui.drop.removeAttribute("tabindex");
      ui.drop.replaceChildren(
        h("span", { class: "imp-file-icon", html: App.icon("file", 20) }),
        h("div", { class: "imp-file-text" },
          h("div", { class: "imp-file-name", text: f.name, title: f.name }),
          h("div", { class: "imp-file-size", text: App.fmt.bytes(f.size) })),
        h("button", { class: "btn btn-small", type: "button", text: "Change", onclick: () => ui.fileInput.click() }),
        h("button", { class: "icon-btn", type: "button", title: "Remove", "aria-label": "Remove the file", html: App.icon("x", 16),
          onclick: () => { st.file = null; renderDrop(); updateSetupState(); } }));
    }

    function chooseFile(file) {
      ui.fileError.hidden = true;
      ui.error.hidden = true;
      if (!isZip(file)) {
        ui.fileError.textContent = `"${file.name}" is not a .zip file. Export from Notion as Markdown & CSV and choose the .zip it gives you.`;
        ui.fileError.hidden = false;
        return;
      }
      st.file = file;
      renderDrop();
      updateSetupState();
    }

    function renderWorkspaces() {
      ui.wsSelect.replaceChildren(...workspaces().map((w) => {
        const o = h("option", { value: w.id }, `${isEmoji(w.icon) ? `${w.icon} ` : ""}${w.name || "Untitled"}`);
        if (w.id === st.wsId) o.selected = true;
        return o;
      }));
    }

    function renderParent() {
      const ws = App.store.workspace(st.wsId);
      const p = st.parentId ? App.store.page(st.parentId) : null;
      const isRoot = Boolean(ws && p && p.id === ws.root_page_id);
      const icon = p && isEmoji(p.icon)
        ? h("span", { class: "imp-parent-icon emoji", text: p.icon })
        : h("span", { class: "imp-parent-icon", html: App.icon(isRoot ? "home" : "page", 15) });
      fill(ui.parentBtn, icon,
        h("span", { class: "imp-parent-title", text: p ? App.ui.titleOf(p) : (ws ? ws.name : "Choose a page") }),
        isRoot ? h("span", { class: "imp-parent-tag", text: "top level" }) : null,
        h("span", { class: "imp-parent-chev", html: App.icon("chevron-down", 14) }));
      ui.parentReset.hidden = isRoot || !ws;
    }

    function pickParent() {
      App.ui.pagePicker(ui.parentBtn, {
        placeholder: "Search pages in this workspace…",
        filter: (p) => p.workspace_id === st.wsId && canHold(p),
        onPick: (p) => { st.parentId = p.id; renderParent(); renderCli(); },
      });
    }

    function updateSetupState() {
      if (st.stage !== "setup" || !ui.submit) return;
      ui.offline.hidden = navigator.onLine;
      ui.submit.disabled = !st.file || !navigator.onLine || !st.wsId;
    }

    // --- the command line alternative -------------------------------------------------------
    function cliSection() {
      ui.cli = h("pre", { class: "code-block imp-cmd" });
      ui.cliNote = h("div", { class: "field-help" });
      ui.showToken = h("button", { class: "btn btn-small", type: "button", onclick: () => { st.tokenShown = !st.tokenShown; renderCli(); } });
      const details = h("details", { class: "imp-cli" },
        h("summary", {},
          h("span", { class: "imp-summary-chev", html: App.icon("chevron-right", 14) }),
          "Prefer the command line?"),
        h("div", { class: "imp-cli-body" },
          h("p", { class: "imp-cli-lede", text: "For very large exports, or one you already unpacked, run the importer from a checkout of meerpad (it needs Python and httpx). It uploads the same way this dialog does." }),
          ui.cli,
          h("div", { class: "btn-row" },
            h("button", { class: "btn btn-small", type: "button", onclick: () => copyText(command(true), "Command copied") },
              h("span", { html: App.icon("copy", 14) }), "Copy command"),
            ui.showToken),
          ui.cliNote));
      details.addEventListener("toggle", () => { if (details.open) ensureToken(); });
      return details;
    }

    function command(real) {
      const ws = App.store.workspace(st.wsId);
      const token = st.token ? (real || st.tokenShown ? st.token : `${st.token.slice(0, 4)}${"•".repeat(12)}`) : "<API token>";
      const parts = [
        "python tools/notion_import.py",
        `--server ${location.origin}`,
        `--token ${token}`,
        `--workspace ${shellQuote(ws ? ws.name : "Work")}`,
      ];
      if (ws && st.parentId && st.parentId !== ws.root_page_id) parts.push(`--parent ${st.parentId}`);
      parts.push("<export folder or zip>");
      return parts.join(" \\\n    ");
    }

    function renderCli() {
      if (!ui.cli) return;
      ui.cli.textContent = command(false);
      ui.showToken.textContent = st.tokenShown ? "Hide token" : "Show token";
      ui.showToken.hidden = !st.token;
      ui.cliNote.replaceChildren(st.token
        ? "The command contains your API token, which lets it act as you. Treat it like a password; Settings can replace it."
        : "Your API token is in Settings, under API token.");
    }

    async function ensureToken() {
      if (st.token) return;
      try {
        const me = await App.api.post("/api/auth/api-token");
        st.token = me && me.api_token;
        if (App.me && st.token) App.me.api_token = st.token;
      } catch (e) { /* offline: the placeholder stays, the note says where to look */ }
      if (!closed) renderCli();
    }

    // --- stage 2: uploading ---------------------------------------------------------------
    function showSetupError(message) {
      ui.error.replaceChildren(h("span", { html: App.icon("warning", 16) }), h("div", {}, h("p", { text: message })));
      ui.error.hidden = false;
      ui.error.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    async function startUpload() {
      if (st.stage !== "setup") return;
      ui.error.hidden = true;
      if (!st.file) { showSetupError("Choose the export .zip first."); return; }
      if (!navigator.onLine) { showSetupError("You are offline. Importing needs a connection."); return; }
      const ws = App.store.workspace(st.wsId);
      if (!ws) { showSetupError("Choose a workspace to import into."); return; }
      const parentId = st.parentId || ws.root_page_id;
      ui.submit.disabled = true;
      // A workspace or page created a moment ago may not be on the server yet,
      // and the import needs to find its target there.
      if (App.sync.hasPending && App.sync.hasPending()) await App.sync.flush();
      if (closed) return;
      renderUploading();

      const form = new FormData();
      form.append("file", st.file, st.file.name);
      form.append("workspace_id", ws.id);
      if (parentId) form.append("parent_page_id", parentId);
      const xhr = new XMLHttpRequest();
      st.xhr = xhr;
      xhr.open("POST", "/api/import/notion");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadProgress(e.loaded, e.total); };
      xhr.upload.onload = () => {
        if (closed) return;
        setUploadProgress(st.file.size, st.file.size);
        ui.upStatus.textContent = "Uploaded. Starting the import…";
      };
      xhr.onload = () => {
        st.xhr = null;
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.id) {
          if (closed) {
            App.toast("Upload finished. The import runs on the server; the pages appear when it is done.", { kind: "ok", duration: 6000 });
            return;
          }
          startJob(data);
          return;
        }
        if (xhr.status === 401) App.bus.emit("auth:lost");
        const detail = uploadError(xhr.status, data);
        if (closed) { App.toast(`Import failed: ${detail}`, { kind: "error", duration: 8000 }); return; }
        renderSetup();
        showSetupError(detail);
      };
      xhr.onerror = () => {
        st.xhr = null;
        const detail = "The upload failed: the connection was lost. Check it and try again.";
        if (closed) { App.toast(detail, { kind: "error", duration: 8000 }); return; }
        renderSetup();
        showSetupError(detail);
      };
      xhr.onabort = () => { st.xhr = null; if (!closed) renderSetup(); };
      xhr.send(form);
    }

    function uploadError(status, data) {
      let detail = data && data.detail;
      if (Array.isArray(detail)) detail = detail[0] && detail[0].msg;
      if (typeof detail === "string" && detail && detail !== "Not Found") return detail;
      if (status === 413) return "The export is larger than this server accepts.";
      if (status === 404 || status === 405) return "This server does not offer the Notion import.";
      return `The server could not take the upload (error ${status || "unknown"}).`;
    }

    function renderUploading() {
      st.stage = "uploading";
      ui.upFill = h("div", { class: "progress-fill" });
      ui.upPct = h("span", { class: "imp-pct", text: "0%" });
      ui.upStatus = h("div", { class: "imp-up-status", text: "Uploading…" });
      body.replaceChildren(
        h("div", { class: "imp-stage" },
          h("div", { class: "imp-file-row" },
            h("span", { class: "imp-file-icon", html: App.icon("file", 20) }),
            h("div", { class: "imp-file-text" },
              h("div", { class: "imp-file-name", text: st.file.name, title: st.file.name }),
              ui.upStatus),
            ui.upPct),
          h("div", { class: "progress imp-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, ui.upFill),
          h("p", { class: "field-help imp-stage-help", text: "Keep this tab open until the upload is done. After that the import runs on the server, and you can close this window." })));
      foot.replaceChildren(h("button", { class: "btn", type: "button", text: "Cancel upload", onclick: () => { if (st.xhr) st.xhr.abort(); } }));
      setUploadProgress(0, st.file.size);
    }

    function setUploadProgress(loaded, total) {
      if (closed || st.stage !== "uploading") return;
      const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      ui.upFill.style.width = `${pct}%`;
      ui.upFill.parentElement.setAttribute("aria-valuenow", String(pct));
      ui.upPct.textContent = `${pct}%`;
      if (pct < 100) ui.upStatus.textContent = `Uploading… ${App.fmt.bytes(loaded)} of ${App.fmt.bytes(total)}`;
    }

    // --- stage 3: the job ---------------------------------------------------------------------
    function startJob(job) {
      st.stage = "job";
      st.job = job;
      st.synced = false;
      renderJob();
      if (job.status !== "done" && job.status !== "error") schedulePoll();
      else if (job.status === "done") finish();
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, POLL_MS);
    }

    async function poll() {
      if (closed || !st.job) return;
      try {
        const job = await App.api.get(`/api/import/${encodeURIComponent(st.job.id)}`);
        if (closed) return;
        st.job = job;
        st.pollTrouble = false;
        renderJob();
        if (job.status === "done") { finish(); return; }
        if (job.status === "error") return;
      } catch (e) {
        if (closed) return;
        if (e.status === 404) {
          st.job = { ...st.job, status: "error", error: "The server no longer knows this import." };
          renderJob();
          return;
        }
        // A blip: say so quietly and keep asking.
        st.pollTrouble = true;
        renderJob();
      }
      schedulePoll();
    }

    async function finish() {
      // The pages are on the server; bring them here before offering to open them.
      await App.sync.flush();
      st.synced = true;
      if (!closed) renderJob();
    }

    function renderJob() {
      const job = st.job || {};
      const stats = job.stats || {};
      const status = job.status || "queued";
      const running = status === "queued" || status === "running";

      let icon;
      let title;
      if (status === "done") {
        icon = h("span", { class: "imp-status-icon ok", html: App.icon("check", 18) });
        title = st.synced ? "Import finished" : "Import finished. Bringing the pages to this device…";
      } else if (status === "error") {
        icon = h("span", { class: "imp-status-icon error", html: App.icon("warning", 18) });
        title = "The import failed";
      } else {
        icon = h("span", { class: "spinner" });
        title = status === "queued" ? "Waiting to start…" : (PHASES[stats.phase] || "Importing pages…");
      }

      const bar = h("div", { class: `progress imp-progress${running && !(stats.total > 0) ? " indeterminate" : ""}${status === "done" ? " is-done" : ""}` });
      const fill = h("div", { class: "progress-fill" });
      if (status === "done") fill.style.width = "100%";
      else if (running && stats.total > 0) fill.style.width = `${Math.min(100, Math.round((100 * (stats.done || 0)) / stats.total))}%`;
      bar.append(fill);

      const warnings = Array.isArray(stats.warnings) ? stats.warnings : [];
      const warnCount = Array.isArray(stats.warnings) ? warnings.length : Number(stats.warnings || 0);
      const grid = h("div", { class: "imp-stats" },
        STAT_LABELS.map(([key, label]) => h("div", { class: `imp-stat${stats[key] ? "" : " is-zero"}` },
          h("div", { class: "imp-stat-num", text: num(stats[key]) }),
          h("div", { class: "imp-stat-label", text: label }))));

      const parts = [
        h("div", { class: "imp-status" }, icon,
          h("div", { class: "imp-status-text" },
            h("div", { class: "imp-status-title", text: title }),
            h("div", { class: "imp-status-sub", text: [
              st.file ? st.file.name : job.source_name || "",
              running && stats.total > 0 ? `${num(stats.done)} of ${num(stats.total)}` : "",
            ].filter(Boolean).join(" · ") }))),
        status === "error" ? null : bar,
      ];
      if (status === "error") {
        parts.push(h("div", { class: "note note-danger" }, h("span", { html: App.icon("warning", 16) }),
          h("div", {}, h("p", { text: job.error || "Something went wrong on the server." }),
            h("p", { class: "muted", text: "Pages imported before the error stay where they are." }))));
      }
      parts.push(grid);
      if (warnCount) {
        const det = h("details", { class: "imp-warnings" },
          h("summary", {},
            h("span", { class: "imp-summary-chev", html: App.icon("chevron-right", 14) }),
            h("span", { class: "badge badge-warning", text: `${num(warnCount)} ${warnCount === 1 ? "warning" : "warnings"}` }),
            h("span", { class: "muted", text: "Things that did not come across exactly." })));
        if (warnings.length) det.append(h("ul", { class: "imp-warning-list" }, warnings.map((w) => h("li", { text: String(w) }))));
        // Keep it open across re-renders once someone opened it.
        if (ui.warningsOpen) det.open = true;
        det.addEventListener("toggle", () => { ui.warningsOpen = det.open; });
        parts.push(det);
      }
      if (running) {
        parts.push(h("p", { class: "field-help imp-stage-help", text: "You can close this window: the import continues on the server, and the pages show up when it is done." }));
        if (st.pollTrouble) parts.push(h("p", { class: "field-help warning-text", text: "Lost touch with the server, trying again…" }));
      }
      body.replaceChildren(h("div", { class: "imp-stage" }, ...parts));

      const buttons = [];
      if (status === "error") {
        buttons.push(h("button", { class: "btn", type: "button", text: "Close", onclick: () => modal.close() }));
        buttons.push(h("button", { class: "btn btn-primary", type: "button", text: "Try again", onclick: () => { st.job = null; renderSetup(); } }));
      } else if (status === "done") {
        buttons.push(h("button", { class: "btn", type: "button", text: "Close", onclick: () => modal.close() }));
        const target = job.parent_page_id || st.parentId;
        const openBtn = h("button", { class: "btn btn-primary", type: "button", disabled: !st.synced, onclick: () => {
          modal.close();
          if (App.nav && App.nav.openPage) App.nav.openPage(target);
        } }, st.synced ? null : h("span", { class: "spinner spinner-small imp-btn-spin" }), "Open imported pages");
        buttons.push(openBtn);
      } else {
        buttons.push(h("button", { class: "btn", type: "button", text: "Close", onclick: () => modal.close() }));
      }
      foot.replaceChildren(...buttons);
    }

    renderSetup();
    resumeRunning();
    return modal;

    /* Reopened while an import still runs (the server allows one at a time):
       show that one instead of a form whose upload would be refused. */
    async function resumeRunning() {
      if (!navigator.onLine) return;
      try {
        const list = await App.api.get("/api/import");
        const running = (Array.isArray(list) ? list : []).find((j) => j.status === "queued" || j.status === "running");
        if (running && !closed && st.stage === "setup") startJob(running);
      } catch (e) { /* the form is still there */ }
    }
  }

  return { open };
})();
