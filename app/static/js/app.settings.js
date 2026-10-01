/* Settings: account, appearance, workspaces, the API token, sync, about.

   One wide modal with the sections listed on the left (a scrolling tab row on
   a phone) and the chosen one on the right. Each section is rendered fresh
   when it is chosen, with a small context that owns its subscriptions: bus
   listeners, window events and timers registered through `ctx` are dropped
   when another section is chosen or the dialog closes, so nothing keeps
   rendering into a detached tree.

   Everything from the user or the server goes in as text (App.el's `text`);
   `html` is only ever an App.icon. */

window.App = window.App || {};

App.settings = (() => {
  const h = App.el;
  const SOURCE_URL = "https://github.com/ribalba/meerpad";
  const LICENSE_URL = "https://github.com/ribalba/meerpad/blob/main/LICENSE";
  const FAMILY_URL = "https://meerverse.com";

  const SECTIONS = [
    { id: "account", label: "Account", icon: "person", render: account },
    { id: "appearance", label: "Appearance", icon: "palette", render: appearance },
    { id: "workspaces", label: "Workspaces", icon: "sidebar", render: workspacesSection },
    { id: "api-token", label: "API token", icon: "lock", render: apiToken },
    { id: "sync", label: "Sync", icon: "cloud", render: syncSection },
    { id: "about", label: "About", icon: "info", render: about },
  ];
  const ALIASES = { token: "api-token", api: "api-token", apitoken: "api-token", theme: "appearance", workspace: "workspaces" };

  const mask = (t) => (t ? `${t.slice(0, 4)}${"•".repeat(Math.max(8, Math.min(28, t.length - 4)))}` : "");
  const initialOf = (me) => ((me && (me.name || me.email)) || "?").trim().charAt(0).toUpperCase() || "?";
  const shellQuote = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;

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

  /* The signed-in user. App.me once the app has booted; before that (or in a
     harness) the server, and offline the copy kept in App.local. */
  async function loadMe() {
    if (App.me && App.me.email) return App.me;
    try {
      const me = await App.api.get("/api/auth/me");
      if (App.me) Object.assign(App.me, me);
      return App.me || me;
    } catch (e) {
      return App.local.get("me") || {};
    }
  }

  function sectionHead(title, desc) {
    return h("div", { class: "set-head" },
      h("h3", { class: "set-title", text: title }),
      desc ? h("p", { class: "set-desc", text: desc }) : null);
  }

  /* A spinner and "Saving…" in a button while its request runs; its own
     content (icon included) comes back afterwards. */
  function busyButton(btn, on, label) {
    btn.disabled = on;
    if (on) {
      const text = label || btn.textContent;
      if (!btn._idle) btn._idle = [...btn.childNodes];
      btn.replaceChildren(h("span", { class: "spinner spinner-small" }), text);
    } else if (btn._idle) {
      btn.replaceChildren(...btn._idle);
      btn._idle = null;
    }
  }

  // --- Account -------------------------------------------------------------------
  function account(ctx) {
    const wrap = h("div", { class: "set-section" }, sectionHead("Account"));
    const content = h("div", { class: "set-stack" }, h("div", { class: "set-loading" }, h("span", { class: "spinner" })));
    wrap.append(content);

    loadMe().then((me) => {
      if (ctx.gone()) return;
      const name = h("input", { class: "input", type: "text", value: me.name || "", placeholder: "Your name", maxlength: "200", autocomplete: "name" });
      const save = h("button", { class: "btn", type: "button", text: "Save", disabled: true });
      const msg = h("div", { class: "field-error", hidden: true, role: "alert" });
      const dirty = () => name.value.trim() !== (me.name || "");
      name.addEventListener("input", () => { save.disabled = !dirty(); msg.hidden = true; save.classList.toggle("btn-primary", dirty()); });
      name.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && dirty()) { e.preventDefault(); doSave(); } });
      save.addEventListener("click", doSave);

      async function doSave() {
        busyButton(save, true, "Saving…");
        msg.hidden = true;
        try {
          const updated = await App.api.patch("/api/auth/me", { name: name.value.trim() });
          Object.assign(me, updated);
          if (App.me && App.me !== me) Object.assign(App.me, updated);
          const saved = App.me || me;
          App.local.set("me", { id: saved.id, email: saved.email, name: saved.name });
          App.bus.emit("me:changed", saved);
          if (ctx.gone()) return;
          busyButton(save, false);
          name.value = updated.name || "";
          profileName.textContent = updated.name || "No name yet";
          avatar.textContent = initialOf(updated);
          save.disabled = true;
          save.classList.remove("btn-primary");
          ctx.refreshNav();
          App.toast("Name saved", { kind: "ok", duration: 2000 });
        } catch (e) {
          if (ctx.gone()) return;
          busyButton(save, false);
          save.disabled = !dirty();
          msg.textContent = e.status ? e.message : "You are offline. Your name is saved once you are back online and try again.";
          msg.hidden = false;
        }
      }

      const signOut = h("button", { class: "btn", type: "button" }, h("span", { html: App.icon("logout", 15) }), "Sign out");
      const signOutMsg = h("div", { class: "field-error", hidden: true, role: "alert" });
      signOut.addEventListener("click", async () => {
        signOutMsg.hidden = true;
        let pending = 0;
        try { pending = (await App.sync.status()).pending; } catch (e) { /* no sync engine: nothing pending */ }
        if (pending) {
          const ok = await App.ui.confirm(
            `${pending === 1 ? "One change has" : `${pending} changes have`} not reached the server yet. They stay on this device and sync the next time you sign in here.`,
            { title: "Sign out anyway?", confirmLabel: "Sign out" });
          if (!ok) return;
        }
        busyButton(signOut, true, "Signing out…");
        try {
          await App.api.post("/api/auth/logout");
          location.href = "/login";
        } catch (e) {
          if (ctx.gone()) return;
          busyButton(signOut, false);
          signOutMsg.textContent = e.status ? e.message : "You are offline. Signing out needs a connection, so the server can end the session.";
          signOutMsg.hidden = false;
        }
      });

      const avatar = h("span", { class: "set-avatar", text: initialOf(me) });
      const profileName = h("div", { class: "set-profile-name", text: me.name || "No name yet" });
      content.replaceChildren(
        h("div", { class: "set-profile" },
          avatar,
          h("div", { class: "set-profile-text" },
            profileName,
            h("div", { class: "set-profile-email", text: me.email || "" }))),
        h("div", { class: "field" },
          h("label", { class: "field-label", text: "Name" }),
          h("div", { class: "set-inline" }, name, save),
          h("div", { class: "field-help", text: "Shown to people you share pages with, and as the author of your edits." }),
          msg),
        h("div", { class: "field" },
          h("label", { class: "field-label", text: "Email" }),
          h("input", { class: "input", type: "email", value: me.email || "", readonly: true, "aria-readonly": "true" }),
          h("div", { class: "field-help", text: "You sign in with a link or code sent to this address." })),
        h("div", { class: "set-group" },
          h("div", { class: "setting-row" },
            h("div", { class: "setting-text" },
              h("div", { class: "setting-title", text: "Sign out of this browser" }),
              h("div", { class: "setting-desc", text: "Your pages stay on this device until you sign in again, so nothing waiting to sync is lost." })),
            signOut)),
        signOutMsg);
    });
    return wrap;
  }

  // --- Appearance ------------------------------------------------------------------
  function appearance(ctx) {
    const MODES = [
      { id: "system", label: "System", icon: "monitor" },
      { id: "light", label: "Light", icon: "sun" },
      { id: "dark", label: "Dark", icon: "moon" },
    ];
    const grid = h("div", { class: "set-themes", role: "radiogroup", "aria-label": "Theme" });
    const mark = () => {
      const cur = App.theme.mode();
      grid.querySelectorAll(".set-theme").forEach((b) => {
        const on = b.dataset.mode === cur;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      });
    };
    for (const m of MODES) {
      const preview = h("span", { class: `set-theme-preview set-theme-${m.id}`, "aria-hidden": "true" },
        h("span", { class: "stp-side" }, h("i"), h("i"), h("i")),
        h("span", { class: "stp-main" }, h("b"), h("i"), h("i"), h("i")));
      grid.append(h("button", {
        class: "set-theme", type: "button", role: "radio", dataset: { mode: m.id },
        onclick: () => { App.theme.set(m.id); mark(); },
      }, preview, h("span", { class: "set-theme-label" }, h("span", { html: App.icon(m.icon, 14) }), m.label)));
    }
    mark();
    // Another window (or the topbar's toggle) may switch it too.
    ctx.listen(window, "storage", (e) => { if (e.key === "meerpad.theme") { App.theme.set(App.theme.mode()); mark(); } });
    return h("div", { class: "set-section" },
      sectionHead("Appearance", "How meerpad looks in this browser."),
      h("div", { class: "field" },
        h("label", { class: "field-label", text: "Theme" }),
        grid,
        h("div", { class: "field-help", text: "System follows your device's light or dark setting." })));
  }

  // --- Workspaces ------------------------------------------------------------------
  function workspacesSection(ctx) {
    const list = h("div", { class: "set-ws-list" });
    let pendingRender = false;

    function countPages(ws) {
      let n = 0;
      const stack = [ws.root_page_id];
      const seen = new Set();
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        for (const c of App.store.children(id)) { n += 1; stack.push(c.id); }
      }
      return n;
    }

    function render() {
      // Someone is typing a name: re-rendering would throw their edit away.
      const active = document.activeElement;
      if (active && list.contains(active) && active.matches("input")) { pendingRender = true; return; }
      pendingRender = false;
      const all = App.store.workspaces();
      list.replaceChildren(...all.map((ws, i) => row(ws, i, all)));
    }

    function iconNode(ws) {
      const icon = App.store.workspaceIcon(ws);
      const ref = icon && App.files && App.files.ref ? App.files.ref(icon) : null;
      if (ref && ref.kind === "url") return h("img", { src: ref.url, alt: "" });
      if (App.files.isGlyph(ref)) return App.glyph(ref, "set-ws-emoji");
      return h("span", { class: "set-ws-letter", text: (ws.name || "?").trim().charAt(0).toUpperCase() || "?" });
    }

    function row(ws, i, all) {
      const iconBtn = h("button", { class: "set-ws-icon", type: "button", title: "Change icon", "aria-label": `Change the icon of ${ws.name}` }, iconNode(ws));
      iconBtn.addEventListener("click", () => App.iconPicker(iconBtn, {
        onPick: (icon) => App.store.updateWorkspace(ws.id, { icon }),
        onRemove: App.store.workspaceIcon(ws) ? () => App.store.updateWorkspace(ws.id, { icon: null }) : null,
      }));
      const name = h("input", { class: "input set-ws-name", type: "text", value: ws.name || "", "aria-label": "Workspace name", maxlength: "200" });
      const commit = () => {
        const next = name.value.trim();
        if (!next) { name.value = ws.name || ""; return; }
        if (next === ws.name) return;
        const old = ws.name || "";
        const root = App.store.rootPage(ws.id);
        // The root page usually carries the workspace's name; keep them in step
        // unless someone gave the root page a title of its own.
        App.store.group("Rename workspace", () => {
          App.store.updateWorkspace(ws.id, { name: next });
          if (root && (root.title || "") === old) App.store.updatePage(root.id, { title: next });
        });
      };
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); name.blur(); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); name.value = ws.name || ""; name.blur(); }
      });
      name.addEventListener("blur", () => {
        commit();
        if (pendingRender) setTimeout(render, 0);
      });

      const prev = all[i - 1];
      const next = all[i + 1];
      const up = h("button", { class: "icon-btn set-up", type: "button", title: "Move up", "aria-label": "Move up", disabled: !prev,
        html: App.icon("chevron-down", 16), onclick: () => App.store.moveWorkspace(ws.id, { before: prev.id }) });
      const down = h("button", { class: "icon-btn", type: "button", title: "Move down", "aria-label": "Move down", disabled: !next,
        html: App.icon("chevron-down", 16), onclick: () => App.store.moveWorkspace(ws.id, { after: next.id }) });
      const only = all.length <= 1;
      const del = h("button", {
        class: "icon-btn set-ws-del", type: "button", disabled: only,
        title: only ? "You need at least one workspace" : "Delete workspace", "aria-label": `Delete ${ws.name}`,
        html: App.icon("trash", 16), onclick: () => remove(ws),
      });
      const count = countPages(ws);
      return h("div", { class: "set-ws-row" },
        iconBtn,
        h("div", { class: "set-ws-main" }, name,
          h("div", { class: "set-ws-meta", text: count === 0 ? "No pages yet" : count === 1 ? "1 page" : `${count.toLocaleString()} pages` })),
        h("div", { class: "set-ws-actions" }, up, down, del));
    }

    async function remove(ws) {
      if (App.store.workspaces().length <= 1) {
        App.toast("You need at least one workspace.", { kind: "warning" });
        return;
      }
      const count = countPages(ws);
      const ok = await App.ui.confirm(
        `"${ws.name || "Untitled"}" and ${count === 0 ? "its home page" : count === 1 ? "its page" : `all ${count.toLocaleString()} of its pages`} will be deleted, on every device.`,
        { title: "Delete this workspace?", confirmLabel: "Delete workspace", danger: true });
      if (!ok) return;
      App.store.deleteWorkspace(ws.id);
      App.toast(`Deleted "${ws.name || "Untitled"}"`, {
        duration: 7000,
        action: { label: "Undo", run: () => App.store.updateWorkspace(ws.id, { deleted: false }) },
      });
    }

    const addInput = h("input", { class: "input", type: "text", placeholder: "New workspace, like House or Farm", maxlength: "200", "aria-label": "New workspace name" });
    const addBtn = h("button", { class: "btn", type: "button", disabled: true }, h("span", { html: App.icon("plus", 15) }), "Add a workspace");
    const add = () => {
      const nm = addInput.value.trim();
      if (!nm) { addInput.focus(); return; }
      const { root } = App.store.createWorkspace({ name: nm });
      addInput.value = "";
      addBtn.disabled = true;
      App.toast(`Created "${nm}"`, {
        kind: "ok",
        action: App.nav && App.nav.openPage && root ? { label: "Open", run: () => App.nav.openPage(root.id) } : undefined,
      });
    };
    addInput.addEventListener("input", () => { addBtn.disabled = !addInput.value.trim(); });
    addInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); add(); } });
    addBtn.addEventListener("click", add);

    // The demo the first-run welcome offers (app.welcome.js), for a second look
    // or for anyone who started empty.
    const demoBtn = h("button", { class: "btn", type: "button" }, h("span", { html: App.icon("plus", 15) }), "Add the demo");
    demoBtn.addEventListener("click", async () => {
      busyButton(demoBtn, true, "Adding…");
      try {
        await App.welcome.addDemo();
        ctx.close();
      } catch (e) {
        if (ctx.gone()) return;
        busyButton(demoBtn, false);
        App.toast(`Could not add the demo: ${e.message}`, { kind: "error" });
      }
    });

    ctx.on("store:change", (e) => { if (e && e.workspaces && e.workspaces.size) render(); });
    render();
    return h("div", { class: "set-section" },
      sectionHead("Workspaces", "Each workspace is a page tree of its own. They appear in the sidebar in this order."),
      list,
      h("div", { class: "set-ws-add" }, addInput, addBtn),
      h("div", { class: "set-group" },
        h("div", { class: "setting-row" },
          h("div", { class: "setting-text" },
            h("div", { class: "setting-title", text: "Demo workspace" }),
            h("div", { class: "setting-desc", text: "Sunny Acre Farm: example pages, databases and a website to try things out on. It is added as a workspace of its own; delete it when you are done." })),
          demoBtn)));
  }

  // --- API token --------------------------------------------------------------------
  function apiToken(ctx) {
    let token = (App.me && App.me.api_token) || null;
    let shown = false;
    const field = h("input", { class: "input input-mono set-token-input", type: "text", readonly: true, "aria-label": "API token", spellcheck: "false" });
    const reveal = h("button", { class: "btn", type: "button" });
    const copy = h("button", { class: "btn", type: "button", onclick: () => token && copyText(token, "Token copied") },
      h("span", { html: App.icon("copy", 14) }), "Copy");
    const rotate = h("button", { class: "btn", type: "button" }, h("span", { html: App.icon("refresh", 14) }), "Rotate");
    const msg = h("div", { class: "field-error", hidden: true, role: "alert" });
    const curlBox = h("pre", { class: "code-block" });
    const cliBox = h("pre", { class: "code-block" });

    function examples(real) {
      const t = token ? (real || shown ? token : mask(token)) : "<API token>";
      const ws = App.store.workspaces()[0];
      const curl = [
        `curl -F "file=@Export.zip" \\`,
        `     -F "workspace_id=${ws ? ws.id : "<workspace id>"}" \\`,
        `     "${location.origin}/api/import/notion?token=${t}"`,
      ].join("\n");
      const cli = [
        "python tools/notion_import.py \\",
        `    --server ${location.origin} \\`,
        `    --token ${t} \\`,
        `    --workspace ${shellQuote(ws ? ws.name : "Work")} \\`,
        "    <export folder or zip>",
      ].join("\n");
      return { curl, cli };
    }

    function render() {
      field.value = token ? (shown ? token : mask(token)) : "";
      field.placeholder = token ? "" : "Loading…";
      reveal.replaceChildren(h("span", { html: App.icon(shown ? "eye-off" : "eye", 14) }), shown ? "Hide" : "Reveal");
      [reveal, copy, rotate].forEach((b) => { b.disabled = !token; });
      const ex = examples(false);
      curlBox.textContent = ex.curl;
      cliBox.textContent = ex.cli;
    }
    reveal.addEventListener("click", () => { shown = !shown; render(); });

    rotate.addEventListener("click", async () => {
      const ok = await App.ui.confirm(
        "The current token stops working right away. Scripts and the import tool need the new one.",
        { title: "Rotate your API token?", confirmLabel: "Rotate token", danger: true });
      if (!ok || ctx.gone()) return;
      msg.hidden = true;
      busyButton(rotate, true, "Rotating…");
      try {
        const me = await App.api.post("/api/auth/api-token/rotate");
        token = me.api_token;
        if (App.me) App.me.api_token = token;
        if (ctx.gone()) return;
        busyButton(rotate, false);
        shown = true;
        render();
        App.toast("New token created. The old one no longer works.", { kind: "ok" });
      } catch (e) {
        if (ctx.gone()) return;
        busyButton(rotate, false);
        render();
        msg.textContent = e.status ? e.message : "You are offline. Rotating the token needs a connection.";
        msg.hidden = false;
      }
    });

    render();
    if (!token) {
      // POST creates the token on first use; afterwards it just returns it.
      App.api.post("/api/auth/api-token").then((me) => {
        token = me.api_token;
        if (App.me) App.me.api_token = token;
        if (!ctx.gone()) render();
      }).catch((e) => {
        if (ctx.gone()) return;
        field.placeholder = "Not available offline";
        msg.textContent = e.status ? e.message : "You are offline. Your token shows up here once you are back online.";
        msg.hidden = false;
      });
    }

    const copyBtn = (which, label) => h("button", { class: "btn btn-small set-copy-example", type: "button",
      onclick: () => copyText(examples(true)[which], label) }, h("span", { html: App.icon("copy", 13) }), "Copy");

    return h("div", { class: "set-section" },
      sectionHead("API token"),
      h("p", { class: "set-text" },
        "The token lets scripts act as you, without signing in: the Notion import command line tool, and uploads to the import endpoint with ",
        h("code", { class: "inline-code", text: "?token=" }), ". Treat it like a password."),
      h("div", { class: "field" },
        h("label", { class: "field-label", text: "Your token" }),
        h("div", { class: "set-token-row" }, field, reveal, copy),
        msg),
      h("div", { class: "set-group" },
        h("div", { class: "setting-row" },
          h("div", { class: "setting-text" },
            h("div", { class: "setting-title", text: "Replace the token" }),
            h("div", { class: "setting-desc", text: "If it leaked, or a script should no longer have access. The old token stops working at once." })),
          rotate)),
      h("h4", { class: "section-title set-subtitle", text: "Examples" }),
      h("div", { class: "set-example" },
        h("div", { class: "set-example-head" }, h("span", { text: "Upload a Notion export with curl" }), copyBtn("curl", "Command copied")),
        curlBox),
      h("div", { class: "set-example" },
        h("div", { class: "set-example-head" }, h("span", { text: "Or with the importer, from a checkout of meerpad" }), copyBtn("cli", "Command copied")),
        cliBox),
      h("p", { class: "field-help", text: "Copy puts the real token into the command, even while it is hidden here." }));
  }

  // --- Sync -----------------------------------------------------------------------------
  function syncSection(ctx) {
    const card = h("div", { class: "set-sync-card" });
    const parkedBox = h("div", { class: "set-parked" });
    const syncNow = h("button", { class: "btn", type: "button" }, h("span", { html: App.icon("refresh", 14) }), "Sync now");
    const redownload = h("button", { class: "btn", type: "button" }, h("span", { html: App.icon("download", 14) }), "Re-download");
    const msg = h("div", { class: "field-help set-sync-msg", "aria-live": "polite" });
    let last = null;
    let parkedShown = -1;

    function describe(op) {
      const data = op.data || {};
      const fields = Object.keys(data).filter((k) => k !== "updated_at");
      let what;
      if (op.entity === "page") {
        const p = App.store.page(op.id);
        what = p ? `Page "${App.ui.titleOf(p)}"` : "A page";
      } else if (op.entity === "block") {
        const b = App.store.block ? App.store.block(op.id) : null;
        const p = b ? App.store.page(b.page_id) : null;
        what = p ? `A block on "${App.ui.titleOf(p)}"` : "A block";
      } else if (op.entity === "workspace") {
        const w = App.store.workspace(op.id);
        what = w ? `Workspace "${w.name}"` : "A workspace";
      } else {
        what = op.entity || "A change";
      }
      if (data.deleted === true) what += ", deleted";
      else if (fields.length) what += `: ${fields.join(", ")}`;
      return what;
    }

    async function renderParked(count) {
      if (count === parkedShown) return;
      parkedShown = count;
      if (!count) { parkedBox.replaceChildren(); return; }
      let ops = [];
      try { ops = await App.sync.parkedOps(); } catch (e) { /* the list is a nicety */ }
      if (ctx.gone()) return;
      const retry = h("button", { class: "btn btn-small", type: "button", text: "Retry" });
      const discard = h("button", { class: "btn btn-small btn-danger-quiet", type: "button", text: "Discard" });
      retry.addEventListener("click", async () => {
        busyButton(retry, true, "Retrying…");
        const r = await App.sync.retryParked();
        if (ctx.gone()) return;
        parkedShown = -1;
        await refresh();
        msg.textContent = r && r.ok ? (r.parked ? "The server still refuses some changes." : "Sent.") : "Could not reach the server.";
      });
      discard.addEventListener("click", async () => {
        const ok = await App.ui.confirm(
          "These changes are never sent. This device keeps showing them until you re-download everything, which replaces them with the server's version.",
          { title: `Discard ${count === 1 ? "this change" : `${count} changes`}?`, confirmLabel: "Discard", danger: true });
        if (!ok || ctx.gone()) return;
        await App.sync.discardParked();
        parkedShown = -1;
        await refresh();
      });
      parkedBox.replaceChildren(h("div", { class: "note note-warning set-parked-note" },
        h("span", { html: App.icon("warning", 16) }),
        h("div", { class: "grow" },
          h("p", {}, h("strong", { text: count === 1 ? "1 change was refused by the server." : `${count} changes were refused by the server.` })),
          h("p", { text: "They were set aside after three tries so the rest can sync. Retry them, or discard them to stop trying." }),
          ops.length ? h("ul", { class: "parked-list" }, ops.slice(0, 20).map((op) => h("li", { class: "parked-item" },
            h("div", { class: "parked-what", text: describe(op) }),
            h("div", { class: "parked-why", text: op.last_error || "Refused by the server" }),
            h("div", { class: "parked-meta", text: op.updated_at ? `Changed ${App.fmt.ago(op.updated_at)}` : "" })))) : null,
          ops.length > 20 ? h("p", { class: "muted", text: `and ${ops.length - 20} more` }) : null,
          h("div", { class: "btn-row set-parked-actions" }, retry, discard))));
    }

    function renderCard(s) {
      last = s;
      const offline = !s.online;
      let state;
      let title;
      if (offline) { state = "offline"; title = "Offline"; }
      else if (s.busy) { state = "busy"; title = "Syncing…"; }
      else if (s.parked) { state = "parked"; title = "Some changes need attention"; }
      else if (s.pending) { state = "pending"; title = s.pending === 1 ? "1 change waiting to sync" : `${s.pending} changes waiting to sync`; }
      else { state = "ok"; title = "Everything is synced"; }
      const lines = [];
      if (offline) lines.push(s.pending ? `${s.pending === 1 ? "1 change is" : `${s.pending} changes are`} saved here and sync when you are back online.` : "Your changes are saved here and sync when you are back online.");
      if (s.lastOk) lines.push(`Last synced ${App.fmt.ago(new Date(s.lastOk).toISOString())}`);
      else if (!offline) lines.push("Not synced yet in this session");
      card.className = `set-sync-card is-${state}`;
      fill(card,
        h("span", { class: "set-sync-dot" }),
        h("div", { class: "set-sync-text" },
          h("div", { class: "set-sync-title", text: title }),
          ...lines.map((l) => h("div", { class: "set-sync-sub", text: l })),
          s.lastError && !offline ? h("div", { class: "set-sync-sub danger-text", text: `Last problem: ${s.lastError}` }) : null),
        s.pending || s.parked ? h("div", { class: "set-sync-counts" },
          s.pending ? h("span", { class: "badge badge-accent", text: `${s.pending} pending` }) : null,
          s.parked ? h("span", { class: "badge badge-warning", text: `${s.parked} set aside` }) : null) : null);
      syncNow.disabled = offline || s.busy;
      redownload.disabled = offline;
      renderParked(s.parked);
    }

    async function refresh() {
      try { renderCard(await App.sync.status()); } catch (e) { /* no sync engine yet */ }
    }

    syncNow.addEventListener("click", async () => {
      msg.textContent = "";
      busyButton(syncNow, true, "Syncing…");
      const r = await App.sync.flush();
      if (ctx.gone()) return;
      busyButton(syncNow, false);
      await refresh();
      if (!r || !r.ok) msg.textContent = "Could not reach the server. Your changes stay here and are sent later.";
      else if (r.synced) msg.textContent = r.synced === 1 ? "Sent 1 change." : `Sent ${r.synced} changes.`;
      else msg.textContent = "Up to date.";
    });

    redownload.addEventListener("click", async () => {
      const ok = await App.ui.confirm(
        "This replaces the copy of your pages in this browser with a fresh one from the server. Changes that already synced are safe, and changes still waiting to sync are kept and sent first. With many pages it can take a moment.",
        { title: "Re-download everything?", confirmLabel: "Re-download" });
      if (!ok || ctx.gone()) return;
      busyButton(redownload, true, "Downloading…");
      const r = await App.sync.fullResync();
      if (ctx.gone()) return;
      busyButton(redownload, false);
      await refresh();
      App.toast(r && r.ok ? "Fresh copy downloaded" : "Could not reach the server. Try again when you are online.", { kind: r && r.ok ? "ok" : "error" });
    });

    ctx.on("sync:status", renderCard);
    ctx.listen(window, "online", refresh);
    ctx.listen(window, "offline", refresh);
    // "2 min ago" goes stale while the dialog sits open.
    ctx.every(20000, () => { if (last) renderCard(last); });
    refresh();

    return h("div", { class: "set-section" },
      sectionHead("Sync", "Changes save on this device first and sync with the server in the background."),
      card,
      h("div", { class: "btn-row set-sync-actions" }, syncNow, msg),
      parkedBox,
      h("div", { class: "set-group" },
        h("div", { class: "setting-row" },
          h("div", { class: "setting-text" },
            h("div", { class: "setting-title", text: "Re-download everything" }),
            h("div", { class: "setting-desc", text: "If something looks out of date or different from another device: pulls a fresh copy from the server." })),
          redownload)),
      h("div", { class: "note set-local-note" },
        h("span", { html: App.icon("database", 16) }),
        h("div", {},
          h("p", { text: "A copy of your pages lives in this browser (in IndexedDB), which is why meerpad opens instantly and works offline." }),
          h("p", { class: "muted", text: "Clearing this site's data in the browser removes that copy. Anything already synced is safe on the server." }))));
  }

  // --- About --------------------------------------------------------------------------------
  function about(ctx) {
    const version = h("span", { class: "set-version", text: "Version …" });
    App.api.get("/api/version")
      .then((v) => { if (!ctx.gone()) version.textContent = `Version ${(v && v.version) || "unknown"}`; })
      .catch(() => { if (!ctx.gone()) version.textContent = "Version unknown (offline)"; });
    const link = (href, icon, label) => h("a", { class: "set-about-link", href, target: "_blank", rel: "noopener" },
      h("span", { html: App.icon(icon, 15) }), h("span", { text: label }), h("span", { class: "set-about-ext", html: App.icon("arrow-up-right", 13) }));
    return h("div", { class: "set-section set-about" },
      h("div", { class: "set-about-hero" },
        h("img", { class: "set-about-logo", src: "/static/img/logo.png", alt: "" }),
        h("div", {},
          h("div", { class: "set-about-name", text: "meerpad" }),
          version)),
      h("p", { class: "set-text", text: "Open-source notes and docs. meerpad is local-first: your pages live on your device and work offline, then sync to the server in the background. Any page can be published as a website." }),
      h("div", { class: "set-about-links" },
        link(SOURCE_URL, "code", "Source code on GitHub"),
        link(LICENSE_URL, "file", "License: GNU AGPL v3"),
        link(FAMILY_URL, "globe", "The meer* family")),
      h("p", { class: "field-help", text: "Free software under the GNU Affero General Public License, version 3: you may run, study, change and share it. If you run a changed version as a service, offer its source to its users too." }));
  }

  // --- the dialog -------------------------------------------------------------------------------
  function open(section = "account") {
    let current = null;
    let cleanups = [];
    let generation = 0;
    const want = ALIASES[section] || section;

    const nav = h("nav", { class: "set-nav", role: "tablist", "aria-orientation": "vertical", "aria-label": "Settings sections" });
    const navUser = h("div", { class: "set-nav-user" });
    const content = h("div", { class: "set-content", role: "tabpanel", tabindex: "-1" });
    const layout = h("div", { class: "set-layout" }, nav, content);

    const modal = App.ui.modal({
      title: "Settings",
      body: layout,
      wide: true,
      className: "set-modal",
      onClose: () => { generation += 1; drop(); },
    });

    function drop() {
      cleanups.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
      cleanups = [];
    }

    function refreshNav() {
      const me = App.me || App.local.get("me") || {};
      navUser.replaceChildren(
        h("span", { class: "set-avatar small", text: initialOf(me) }),
        h("div", { class: "set-nav-user-text" },
          h("div", { class: "set-nav-user-name", text: me.name || me.email || "" }),
          me.name && me.email ? h("div", { class: "set-nav-user-email", text: me.email }) : null));
    }

    const buttons = SECTIONS.map((s) => h("button", {
      class: "set-nav-item", type: "button", role: "tab", dataset: { id: s.id }, id: `set-tab-${s.id}`,
      onclick: () => show(s.id, true),
    }, h("span", { class: "set-nav-icon", html: App.icon(s.icon, 16) }), h("span", { class: "set-nav-label", text: s.label })));
    nav.append(navUser, ...buttons);
    nav.addEventListener("keydown", (e) => {
      const i = SECTIONS.findIndex((s) => s.id === current);
      let j = null;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") j = (i + 1) % SECTIONS.length;
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = (i - 1 + SECTIONS.length) % SECTIONS.length;
      if (e.key === "Home") j = 0;
      if (e.key === "End") j = SECTIONS.length - 1;
      if (j === null) return;
      e.preventDefault();
      show(SECTIONS[j].id);
      buttons[j].focus();
    });

    function show(id, fromClick) {
      const s = SECTIONS.find((x) => x.id === id) || SECTIONS[0];
      if (s.id === current && content.childElementCount) return;
      drop();
      generation += 1;
      const gen = generation;
      current = s.id;
      buttons.forEach((b) => {
        const on = b.dataset.id === s.id;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
      });
      content.setAttribute("aria-labelledby", `set-tab-${s.id}`);
      const ctx = {
        gone: () => gen !== generation,
        on(name, fn) { cleanups.push(App.bus.on(name, fn)); },
        listen(target, evt, fn) { target.addEventListener(evt, fn); cleanups.push(() => target.removeEventListener(evt, fn)); },
        every(ms, fn) { const t = setInterval(fn, ms); cleanups.push(() => clearInterval(t)); },
        close: () => modal.close(),
        refreshNav,
      };
      content.replaceChildren(s.render(ctx));
      content.scrollTop = 0;
      // On a phone the tab row scrolls sideways: keep the chosen one in view.
      const btn = buttons.find((b) => b.dataset.id === s.id);
      if (btn && nav.scrollWidth > nav.clientWidth) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (fromClick && matchMedia("(hover: hover)").matches) content.focus({ preventScroll: true });
    }

    refreshNav();
    show(want);
    if (!App.me) loadMe().then(() => refreshNav());
    // App.ui.modal focuses the first field it finds, which here would be a
    // workspace's name or the token; the chosen tab is the better start (and
    // a phone does not pop its keyboard up for nothing).
    setTimeout(() => {
      const tab = buttons.find((b) => b.dataset.id === current);
      if (tab) tab.focus({ preventScroll: true });
    }, 0);
    return modal;
  }

  return { open };
})();
