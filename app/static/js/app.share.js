/* The share popover: turn a page's view link and edit link on and off, copy
   them, or replace them (which kills the old link).

   Tokens are made by the server (POST /api/pages/{id}/share), never here, so
   they are unguessable whatever the client does. A link covers the page and
   everything below it; a subpage of a shared page says so ("inherited_from")
   and offers the link to itself within that share. */

window.App = window.App || {};

App.share = (() => {
  let handle = null;

  function open(pageId, anchor) {
    if (handle) handle.close();
    const page = App.store.page(pageId);
    if (!page) return;
    const body = App.el("div", { class: "share-body" });
    const root = App.el("div", {},
      App.el("div", { class: "share-head" },
        App.el("span", { html: App.icon("share", 17) }),
        App.el("span", { class: "grow ellipsis", text: `Share "${App.ui.titleOf(page)}"` })),
      body,
      App.el("div", { class: "share-foot" },
        App.el("span", { html: App.icon("info", 14) }),
        App.el("span", { text: "A link covers this page and every page inside it. Turn a link off and it stops working at once." })));
    handle = App.ui.popover(anchor, root, { className: "share-pop", placement: "bottom-end", onClose: () => { handle = null; } });
    const me = handle;

    let state = null;
    let busy = false;

    const setBody = (...nodes) => { body.replaceChildren(...nodes); if (!me.closed) me.reposition(); };

    async function load() {
      if (!navigator.onLine) {
        setBody(App.el("div", { class: "note note-warning" }, App.el("span", { html: App.icon("cloud-off") }),
          App.el("p", { text: "Sharing needs a connection. Try again when you are back online." })));
        return;
      }
      setBody(App.el("div", { class: "empty-state", style: "padding:1.5rem" }, App.el("div", { class: "spinner" })));
      try {
        state = await App.api.get(`/api/pages/${encodeURIComponent(pageId)}/share`);
        render();
      } catch (e) {
        setBody(App.el("div", { class: "note note-danger" }, App.el("span", { html: App.icon("warning") }),
          App.el("p", { text: `Could not load the sharing settings: ${e.message}` })));
      }
    }

    async function change(kind, enabled, rotate = false) {
      if (busy) return;
      busy = true;
      try {
        state = await App.api.post(`/api/pages/${encodeURIComponent(pageId)}/share`, { kind, enabled, rotate });
        render();
        // The tokens are page fields: pull them so the tree knows too.
        App.sync.flush();
        if (rotate) App.toast("New link made. The old one no longer works.");
      } catch (e) {
        App.toast(`Could not change the link: ${e.message}`, { kind: "error" });
        render();
      } finally {
        busy = false;
      }
    }

    function linkRow({ kind, icon, title, desc, url, warn }) {
      const on = Boolean(url);
      const input = App.el("input", { type: "checkbox", "aria-label": title });
      input.checked = on;
      input.addEventListener("change", () => change(kind, input.checked));
      const row = App.el("div", { class: `share-row${on ? " on" : ""}`, dataset: { kind } },
        App.el("span", { class: "share-row-icon", html: App.icon(icon, 17) }),
        App.el("div", { class: "share-row-text" },
          App.el("div", { class: "share-row-title", text: title }),
          App.el("div", { class: "share-row-desc", text: desc })),
        App.el("label", { class: "switch" }, input, App.el("span", { class: "switch-track" })));
      if (!on) return [row];
      const field = App.el("input", { class: "input input-small share-url", type: "text", readonly: true, value: url, "aria-label": `${title} link` });
      field.addEventListener("focus", () => field.select());
      const extra = App.el("div", { class: "share-link" }, field,
        App.el("div", { class: "share-link-actions" },
          App.el("button", {
            class: "btn btn-small btn-primary", type: "button", html: `${App.icon("copy", 14)}<span>Copy link</span>`,
            onclick: () => App.shell.copy(url, "Link copied"),
          }),
          App.el("button", {
            class: "btn btn-small", type: "button", html: `${App.icon("refresh", 14)}<span>Replace link</span>`, title: "Make a new link; the current one stops working",
            // Confirmed inline: a modal on top would count as a click outside
            // and close this popover under the user's hand.
            onclick: (e) => {
              const actions = e.currentTarget.parentElement;
              actions.replaceChildren(
                App.el("span", { class: "share-confirm", text: "The current link stops working. Replace it?" }),
                App.el("button", { class: "btn btn-small", type: "button", text: "Cancel", onclick: () => render() }),
                App.el("button", { class: "btn btn-small btn-primary", type: "button", text: "Replace", onclick: () => change(kind, true, true) }));
            },
          })),
        warn ? App.el("div", { class: "note note-warning", style: "margin-top:.5rem" }, App.el("span", { html: App.icon("warning", 15) }), App.el("p", { text: warn })) : null);
      row.querySelector(".share-row-text").append(extra);
      return [row];
    }

    function render() {
      if (!state) return;
      const nodes = [];
      if (state.inherited_from) {
        const anc = App.store.page(state.inherited_from);
        const via = App.el("div", { class: "note share-inherited" }, App.el("span", { html: App.icon("info", 15) }));
        const p = App.el("p", {}, "This page is already shared through ");
        const link = App.el("a", { class: "text-link", href: App.nav.pageHref(state.inherited_from), text: anc ? App.ui.titleOf(anc) : "a page above it" });
        link.addEventListener("click", () => { if (handle) handle.close(); });
        p.append(link, ". Its links include this page.");
        via.append(App.el("div", {}, p, inheritedLinks(anc)));
        nodes.push(via);
      }
      nodes.push(...linkRow({
        kind: "view", icon: "eye", title: "Anyone with the link can view",
        desc: "Read this page and the pages inside it. No account needed.",
        url: state.share_url,
      }));
      nodes.push(...linkRow({
        kind: "edit", icon: "text", title: "Anyone with the link can edit",
        desc: "Change, add and delete content here and in every page inside it, without signing in.",
        url: state.edit_url,
        warn: "This is powerful: anyone who gets this link can change or delete content. Share it only with people you trust, and replace it if it leaks.",
      }));
      setBody(...nodes);
    }

    /* The ancestor's own links, pointed at this page, so the owner can send
       someone straight here. The owner's copy of the ancestor carries its
       tokens. */
    function inheritedLinks(anc) {
      if (!anc) return null;
      const box = App.el("div", { class: "btn-row", style: "margin-top:.45rem" });
      const add = (token, label) => {
        if (!token) return;
        const url = App.shell.absoluteUrl(`/s/${token}/${pageId}`);
        box.append(App.el("button", { class: "btn btn-tiny", type: "button", html: `${App.icon("copy", 13)}<span>${App.esc(label)}</span>`, onclick: () => App.shell.copy(url, "Link copied") }));
      };
      add(anc.share_token, "Copy view link to this page");
      add(anc.edit_token, "Copy edit link to this page");
      return box.childNodes.length ? box : null;
    }

    load();
    return handle;
  }

  return { open };
})();
