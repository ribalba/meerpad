/* The trash: pages that were deleted, grouped by workspace, newest first.

   Restoring is an ordinary synced write (deleted = false). Deleting forever is
   not: the server has to drop the blocks and files, so it needs a connection,
   and the page has to be in the trash on the server first, which is why the
   queue is flushed before a purge. */

window.App = window.App || {};

App.trash = (() => {
  let handle = null;

  function open() {
    if (handle) return;
    const search = App.el("input", { class: "input", type: "search", placeholder: "Filter by page title…", "aria-label": "Filter the trash" });
    const list = App.el("div", { class: "trash-list" });
    const body = App.el("div", {}, App.el("div", { class: "trash-search" }, search), list);
    const modal = App.ui.modal({
      title: "Trash", body, className: "trash-modal",
      onClose: () => { off(); handle = null; },
    });
    handle = modal;
    const off = App.bus.on("store:change", (ch) => { if (ch.pages.size || ch.workspaces.size) render(); });
    search.addEventListener("input", render);

    function render() {
      const q = search.value.trim().toLowerCase();
      const items = App.store.trash().filter((p) => !q || App.ui.titleOf(p).toLowerCase().includes(q));
      list.replaceChildren();
      if (!items.length) {
        list.append(App.el("div", { class: "empty-state" },
          App.el("div", { class: "empty-icon", html: App.icon("trash", 36) }),
          App.el("h2", { text: q ? "Nothing matches" : "The trash is empty" }),
          App.el("p", { text: q ? "Try another word." : "Deleted pages wait here until you restore them or delete them forever." })));
        return;
      }
      const groups = new Map();
      for (const p of items) {
        if (!groups.has(p.workspace_id)) groups.set(p.workspace_id, []);
        groups.get(p.workspace_id).push(p);
      }
      for (const [wsId, pages] of groups) {
        const ws = App.store.workspace(wsId);
        const group = App.el("div", { class: "trash-group" },
          App.el("div", { class: "trash-group-title" },
            ws && App.sidebar ? App.sidebar.workspaceIcon(ws) : null,
            App.el("span", { text: ws ? ws.name || "Untitled" : "Unknown workspace" })));
        pages.forEach((p) => group.append(item(p)));
        list.append(group);
      }
    }

    function item(p) {
      const where = p.parent_id && App.store.page(p.parent_id) ? App.ui.pathOf(App.store.page(p.parent_id)) : "";
      const meta = [where && `in ${where}`, p.deleted_at && `deleted ${App.fmt.ago(p.deleted_at)}`].filter(Boolean).join(" · ");
      const main = App.el("div", { class: "trash-item-main", title: "Open this page", role: "button", tabindex: "0" },
        App.el("div", { class: "trash-item-title", text: App.ui.titleOf(p) }),
        meta ? App.el("div", { class: "trash-item-meta", text: meta }) : null);
      const openIt = () => { modal.close(); App.nav.openPage(p.id); };
      main.addEventListener("click", openIt);
      main.addEventListener("keydown", (e) => { if (e.key === "Enter") openIt(); });
      return App.el("div", { class: "trash-item", dataset: { id: p.id } },
        App.el("span", { class: "trash-item-icon" }, App.shell.pageIcon(p, { size: 16 })),
        main,
        App.el("button", {
          class: "icon-btn restore", type: "button", title: "Restore", "aria-label": `Restore ${App.ui.titleOf(p)}`,
          html: App.icon("undo", 17),
          onclick: () => { App.store.restorePage(p.id); App.toast(`Restored "${App.ui.titleOf(p)}"`); },
        }),
        App.el("button", {
          class: "icon-btn purge", type: "button", title: "Delete forever", "aria-label": `Delete ${App.ui.titleOf(p)} forever`,
          html: App.icon("trash", 17),
          onclick: () => purge([p]),
        }));
    }

    async function purge(pages) {
      if (!navigator.onLine) { App.toast("Deleting forever needs a connection.", { kind: "error" }); return; }
      const what = pages.length === 1 ? `"${App.ui.titleOf(pages[0])}" and every page inside it` : `${pages.length} pages and every page inside them`;
      const ok = await App.ui.confirm(`${what} will be deleted for good, with their files. This cannot be undone.`, {
        title: "Delete forever?", confirmLabel: "Delete forever", danger: true,
      });
      if (!ok) return;
      try {
        await App.sync.flush();
        for (const p of pages) await App.store.purgePage(p.id);
        App.toast(pages.length === 1 ? "Deleted forever" : `${pages.length} pages deleted forever`);
      } catch (e) {
        App.toast(e.status === 409 ? "The trash has not synced yet. Try again in a moment." : `Could not delete: ${e.message}`, { kind: "error" });
      }
      render();
    }

    // Empty the trash: in the footer, away from the per-page buttons.
    const foot = App.el("div", { class: "modal-foot" },
      App.el("span", { class: "grow field-help", text: "Pages in the trash stay until you delete them." }),
      App.el("button", {
        class: "btn btn-small btn-danger-quiet", type: "button", text: "Empty trash",
        onclick: () => { const all = App.store.trash(); if (all.length) purge(all); },
      }));
    modal.el.append(foot);
    render();
  }

  return { open };
})();
