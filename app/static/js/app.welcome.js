/* The first-run welcome, and the demo workspace.

   A new account is asked once, after its first sync, whether it wants the demo:
   Sunny Acre Farm, a workspace of example pages that shows what meerpad does
   (the server builds it, app/demo). The answer is kept on the server
   (users.welcomed_at), so an account is asked once, not once per device.
   Settings, Workspaces adds the demo at any time. */

window.App = window.App || {};

App.welcome = (() => {
  const h = App.el;

  /* Have the server add the demo, pull it in and open it. Throws when the
     server could not add it; the caller says so. */
  async function addDemo() {
    const r = await App.api.post("/api/demo", {}, { timeout: 60000 });
    if (App.me && !App.me.welcomed_at) App.me.welcomed_at = new Date().toISOString();
    await App.sync.flush();
    if (App.store.workspace(r.workspace_id)) App.sidebar.openWorkspace(r.workspace_id);
    else App.toast("The demo farm is added. It shows up here once this device has synced.", { kind: "warning", duration: 7000 });
    return r;
  }

  /* "Start empty", or the dialog closed without an answer: do not ask again.
     If this does not reach the server, the next start asks once more. */
  function dismiss() {
    App.api.patch("/api/auth/me", { welcomed: true })
      .then((me) => { if (App.me && me) App.me.welcomed_at = me.welcomed_at; })
      .catch((e) => console.debug("welcome not saved", e));
  }

  function offer() {
    const names = App.store.workspaces().map((w) => w.name).filter(Boolean);
    const intro = names.length
      ? `Your pages start out in ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}, empty for now. `
      : "";
    const item = (emoji, text) => h("li", {}, h("span", { class: "welcome-emoji", text: emoji, "aria-hidden": "true" }), h("span", { text }));
    const body = h("div", { class: "welcome" },
      h("p", { text: `${intro}Would you like a demo workspace to look around in first?` }),
      h("div", { class: "welcome-demo" },
        h("div", { class: "welcome-demo-head" },
          h("span", { class: "welcome-demo-icon", text: "🚜", "aria-hidden": "true" }),
          h("div", {},
            h("div", { class: "welcome-demo-name", text: "Sunny Acre Farm" }),
            h("div", { class: "muted", text: "A made-up farm, written down in meerpad" }))),
        h("ul", { class: "welcome-list" },
          item("📝", "Every kind of block: to-dos, toggles, callouts, tables, code, equations, images and a PDF"),
          item("🗂️", "Databases as a table, a board, a list, a gallery and a Gantt chart"),
          item("🌐", "A farm shop page, ready to publish as a website"))),
      h("p", { class: "muted", text: "It is an ordinary workspace: change anything, and delete it when you are done. Settings, Workspaces can add it later, too." }));

    let answered = false;
    const modal = App.ui.modal({
      title: "Welcome to meerpad",
      body,
      className: "welcome-modal",
      actions: [
        { label: "Start empty", onClick: () => { answered = true; dismiss(); } },
        {
          label: "Add the demo farm", primary: true,
          onClick: async () => {
            const buttons = [...modal.el.querySelectorAll(".modal-foot .btn")];
            const primary = modal.el.querySelector(".modal-foot .btn-primary");
            const label = primary.textContent;
            buttons.forEach((b) => { b.disabled = true; });
            primary.replaceChildren(h("span", { class: "spinner spinner-small" }), "Adding the farm…");
            try {
              await addDemo();
              answered = true;
              return false;
            } catch (e) {
              buttons.forEach((b) => { b.disabled = false; });
              primary.textContent = label;
              App.toast(`Could not add the demo: ${e.message}`, { kind: "error" });
              return true; // keep the dialog: "Start empty" is still an answer
            }
          },
        },
      ],
      onClose: () => { if (!answered) dismiss(); },
    });
    return modal;
  }

  return { offer, addDemo };
})();
