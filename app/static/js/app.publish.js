/* Publish to the web: the dialog behind the topbar's "Publish" button.

   One page (and every live page below it) becomes a website at
   <this app>/v/<name>, optionally also at a custom domain, rendered with one
   of the server's templates. docs/DESIGN.md §7 and §9 have the API.

   A few choices worth knowing about:

   * The server is the judge of every address. The dialog asks it as you type
     (GET /api/sites/check, debounced), so "taken" shows up next to the field
     before you press Publish, and a refusal on save lands in the same place.
     Errors are never only a toast: a toast is gone before anyone has read
     which field it was about.
   * The address is a path on this app's own host, so the dialog knows it
     without asking: location.origin + "/v/" + the name.
   * Everything the user or the server typed reaches the screen as text
     (App.el's `text`); `html` is only ever an App.icon. */

window.App = window.App || {};

App.publish = (() => {
  const h = App.el;
  const DEFAULT_ACCENT = "#2383e2"; // the server's default (app/sites.py)
  const SWATCHES = [
    ["#2383e2", "Blue"], ["#0f7b6c", "Green"], ["#d9730d", "Orange"], ["#9065b0", "Purple"],
    ["#e03e3e", "Red"], ["#c14c8a", "Pink"], ["#37352f", "Ink"],
  ];
  // The server's SLUG_RE (app/sites.py): an instant answer before it is asked.
  const SUB_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const CHECK_DELAY = 350;

  // Where published sites live: this app's own host (see the header comment).
  const siteBase = () => `${location.origin}/v/`;

  /* "Hühnerfarm & Co." -> "huehnerfarm-co": the server's slugify (app/render.py),
     so the suggestion here and the one the server would make agree. */
  function slugify(text, max = 63) {
    const s = String(text || "").toLowerCase()
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s.slice(0, max).replace(/-+$/, "");
  }

  /* What people paste into a domain field: "https://Example.com/about" is
     "example.com" (the server normalises the same way). */
  function normalizeDomain(raw) {
    return String(raw || "").trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split("/")[0].replace(/\.+$/, "");
  }

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

  /* Which field a refusal from PUT /site is about, from the server's wording
     (app/routers/publish.py). Anything unrecognised goes to the top. */
  function fieldForError(detail) {
    const d = String(detail || "");
    if (/domain name|app's own address|Addresses under|Another site already uses this domain/i.test(d)) return "domain";
    if (/options\.|colour|color/i.test(d)) return "options";
    if (/template/i.test(d)) return "template";
    if (/address|\/v\/|taken|lowercase letters|choose another name/i.test(d)) return "sub";
    return "top";
  }

  // --- the template previews ---------------------------------------------------
  /* A tiny drawing of each layout, made of blocks: enough to tell a sidebar
     from a hero at a glance. Purely decorative (aria-hidden). */
  function mockup(id) {
    const bar = (cls = "") => h("span", { class: `pm-l ${cls}` });
    const title = (cls = "") => h("span", { class: `pm-t ${cls}` });
    const lines = (n) => Array.from({ length: n }, (_, i) => bar(i % 3 === 2 ? "s" : ""));
    let page;
    if (id === "minimal") {
      page = h("span", { class: "pm-page pm-minimal" },
        h("span", { class: "pm-crumbs" }, bar("xs"), bar("xs")), title(), ...lines(5));
    } else if (id === "docs") {
      page = h("span", { class: "pm-page pm-docs" },
        h("span", { class: "pm-side" }, bar("xs strong"), bar("xs"), bar("xs accent"), bar("xs"), bar("xs"), bar("xs")),
        h("span", { class: "pm-main" }, title(), ...lines(4)),
        h("span", { class: "pm-toc" }, bar("xs"), bar("xs"), bar("xs")));
    } else if (id === "blog") {
      const post = () => h("span", { class: "pm-post" }, h("span", { class: "pm-img" }),
        h("span", { class: "pm-post-text" }, bar("strong"), bar(), bar("s")));
      page = h("span", { class: "pm-page pm-blog" }, title("c"), post(), post(), post());
    } else if (id === "landing") {
      const feat = () => h("span", { class: "pm-feat" }, bar("strong"), bar(), bar("s"));
      page = h("span", { class: "pm-page pm-landing" },
        h("span", { class: "pm-hero" }, h("span", { class: "pm-t light" }), h("span", { class: "pm-l light" }), h("span", { class: "pm-btn" })),
        h("span", { class: "pm-feats" }, feat(), feat(), feat()));
    } else {
      page = h("span", { class: "pm-page pm-minimal" }, title(), ...lines(6));
    }
    return h("span", { class: "pm-window" },
      h("span", { class: "pm-chrome" }, h("i"), h("i"), h("i")), page);
  }

  // --- the dialog ----------------------------------------------------------------
  function open(pageId) {
    const page = App.store && App.store.page ? App.store.page(pageId) : null;
    const pageTitle = App.ui.titleOf(page);

    const st = {
      site: null,
      templates: [],
      template: "minimal",
      slug: "",
      subTouched: false,
      domain: "",
      options: { title: "", description: "", footer: "", show_header: true, show_nav: true, accent: DEFAULT_ACCENT },
      saving: false,
      subOk: null,
      domainOk: null,
    };
    const timers = { sub: null, domain: null };
    const seqs = { sub: 0, domain: 0 };
    let closed = false;

    const body = h("div", { class: "pub" });
    const foot = h("div", { class: "modal-foot pub-foot" });
    const modal = App.ui.modal({
      title: "Publish to the web",
      body,
      wide: true,
      className: "pub-modal",
      onClose: () => {
        closed = true;
        clearTimeout(timers.sub);
        clearTimeout(timers.domain);
      },
    });
    modal.el.append(foot);

    // Pieces updated in place once the form exists.
    const ui = {};

    function showLoading() {
      body.replaceChildren(h("div", { class: "pub-loading" }, h("span", { class: "spinner" }), h("span", { text: "Loading…" })));
      foot.replaceChildren(h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => modal.close() }));
    }

    function showProblem(message, retry) {
      body.replaceChildren(h("div", { class: "note note-danger pub-problem" },
        h("span", { html: App.icon("warning", 16) }),
        h("div", {}, h("p", { text: message }))));
      fill(foot,
        h("button", { class: "btn", type: "button", text: "Close", onclick: () => modal.close() }),
        retry ? h("button", { class: "btn btn-primary", type: "button", text: "Try again", onclick: retry }) : null);
    }

    async function load() {
      if (!navigator.onLine) {
        showProblem("You are offline. Publishing needs a connection; open this again once you are back online.", load);
        return;
      }
      showLoading();
      const notFound = (e) => { if (e && e.status === 404) return null; throw e; };
      try {
        const [site, templates, check] = await Promise.all([
          App.api.get(`/api/pages/${encodeURIComponent(pageId)}/site`).catch(notFound),
          App.api.get("/api/sites/templates"),
          App.api.get(`/api/sites/check?page_id=${encodeURIComponent(pageId)}`).catch(() => null),
        ]);
        if (closed) return;
        st.templates = Array.isArray(templates) ? templates : (templates && templates.templates) || [];
        applySite(site, check && check.suggestion);
        render();
        if (st.slug) runCheck("sub");
        if (st.domain) runCheck("domain");
      } catch (e) {
        if (closed) return;
        showProblem(e.status === 404 ? "This page was not found on the server. If you just created it, wait a moment for it to sync, then try again."
          : `Could not load the publishing settings: ${e.message || e}`, load);
      }
    }

    /* Take the server's site (or none) as the form's starting point. */
    function applySite(site, suggestion) {
      st.site = site || null;
      if (site) {
        const o = site.options || {};
        st.template = site.template || "minimal";
        st.slug = site.slug || "";
        st.domain = site.custom_domain || "";
        st.options = {
          title: o.title || "",
          description: o.description || "",
          footer: o.footer || "",
          show_header: o.show_header !== false,
          show_nav: o.show_nav !== false,
          accent: HEX_RE.test(o.accent || "") ? o.accent.toLowerCase() : DEFAULT_ACCENT,
        };
      } else if (!st.subTouched) {
        // The server's suggestion already skips taken names ("farm-2").
        st.slug = (suggestion && SUB_RE.test(suggestion) ? suggestion : slugify(pageTitle)) || "";
      }
      if (st.templates.length && !st.templates.some((t) => t.id === st.template)) {
        // A template this server does not offer (any more): it renders such a
        // site as "minimal", so that is what the dialog shows as chosen.
        st.template = st.templates.some((t) => t.id === "minimal") ? "minimal" : st.templates[0].id;
      }
    }

    // --- rendering ---------------------------------------------------------------
    function render() {
      body.replaceChildren(
        ui.status = h("div", { class: "pub-status" }),
        ui.topError = h("div", { class: "note note-danger pub-top-error", hidden: true }),
        section("Template", "How the site looks. You can switch at any time.", templateSection(), "template"),
        section("Address", "Choose the site's name in the address: lowercase letters, digits and dashes.", addressSection()),
        domainSection(),
        section("Options", null, optionsSection(), "options"));
      renderStatus();
      renderFoot();
    }

    /* A titled block of the form. `key` gives it its own error line, for
       refusals that are about the section rather than one field. */
    function section(title, help, content, key) {
      const err = key ? h("div", { class: "field-error pub-section-error", hidden: true }) : null;
      if (key) ui[`${key}SectionError`] = err;
      return h("section", { class: "pub-section" },
        h("h3", { class: "section-title", text: title }),
        help ? h("p", { class: "pub-section-help", text: help }) : null,
        content, err);
    }

    function renderStatus() {
      const s = st.site;
      ui.status.replaceChildren();
      ui.status.classList.toggle("on", Boolean(s && s.enabled !== false));
      const mark = h("span", { class: "pub-status-mark", html: App.icon("globe", 20) });
      if (!s) {
        fill(ui.status, mark, h("div", { class: "pub-status-text" },
          h("div", { class: "pub-status-title" }, "Not published yet"),
          h("div", { class: "pub-status-desc", text: "Publish this page and its subpages as a website. Anyone with the address can read it; nobody can edit it." })));
        return;
      }
      const links = h("div", { class: "pub-links" });
      for (const url of [s.url, s.custom_url].filter(Boolean)) {
        links.append(h("div", { class: "pub-link" },
          h("a", { class: "pub-link-url", href: url, target: "_blank", rel: "noopener", text: url.replace(/^https?:\/\//, "") }),
          h("button", { class: "icon-btn icon-btn-small", type: "button", title: "Copy link", "aria-label": "Copy link",
            html: App.icon("copy", 14), onclick: () => copyText(url, "Link copied") }),
          h("a", { class: "icon-btn icon-btn-small", href: url, target: "_blank", rel: "noopener", title: "Open the site",
            "aria-label": "Open the site", html: App.icon("external", 14) })));
      }
      const badge = s.enabled === false
        ? h("span", { class: "badge badge-warning", text: "Switched off" })
        : h("span", { class: "badge badge-ok" }, h("span", { class: "pub-dot" }), "Published");
      fill(ui.status, mark,
        h("div", { class: "pub-status-text" },
          h("div", { class: "pub-status-title" }, badge),
          links,
          s.custom_domain ? h("div", { class: "pub-status-desc", text: "The custom domain answers once its DNS record points at the server." }) : null),
        s.preview_url ? h("a", { class: "btn btn-small pub-preview", href: s.preview_url, target: "_blank", rel: "noopener" },
          h("span", { html: App.icon("eye", 14) }), "Preview") : null);
    }

    function renderFoot() {
      const published = Boolean(st.site);
      ui.primary = h("button", { class: "btn btn-primary pub-submit", type: "button", onclick: submit },
        published ? "Save changes" : "Publish");
      fill(foot,
        published ? h("button", { class: "btn btn-danger-quiet pub-unpublish", type: "button", text: "Unpublish", onclick: unpublish }) : null,
        h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => modal.close() }),
        ui.primary);
    }

    function templateSection() {
      const grid = h("div", { class: "pub-templates", role: "radiogroup", "aria-label": "Template" });
      ui.templates = grid;
      setAccentVar();
      const list = st.templates.length ? st.templates : [{ id: "minimal", name: "Minimal", description: "" }];
      for (const t of list) {
        const card = h("button", {
          class: "pub-tpl", type: "button", role: "radio", dataset: { id: t.id },
          onclick: () => { st.template = t.id; markTemplate(); clearError("template"); },
        },
        h("span", { class: "pub-tpl-preview", "aria-hidden": "true" }, mockup(t.id)),
        h("span", { class: "pub-tpl-text" },
          h("span", { class: "pub-tpl-name", text: t.name || t.id }),
          t.description ? h("span", { class: "pub-tpl-desc", text: t.description }) : null),
        h("span", { class: "pub-tpl-check", "aria-hidden": "true", html: App.icon("check", 12) }));
        grid.append(card);
      }
      markTemplate();
      return grid;
    }

    function markTemplate() {
      for (const card of ui.templates.querySelectorAll(".pub-tpl")) {
        const on = card.dataset.id === st.template;
        card.classList.toggle("selected", on);
        card.setAttribute("aria-checked", String(on));
      }
    }

    function setAccentVar() {
      if (ui.templates) ui.templates.style.setProperty("--pub-accent", HEX_RE.test(st.options.accent) ? st.options.accent : DEFAULT_ACCENT);
    }

    function addressSection() {
      ui.sub = h("input", {
        class: "input pub-sub-input", type: "text", value: st.slug, maxlength: "63", autocomplete: "off",
        autocapitalize: "off", spellcheck: "false", "aria-label": "Site name", placeholder: "my-site",
      });
      ui.sub.addEventListener("input", () => {
        // Only what the address allows, as you type: "My Farm" becomes "my-farm".
        const caret = ui.sub.selectionStart;
        const before = ui.sub.value.slice(0, caret);
        const clean = (s) => s.toLowerCase()
          .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
          .normalize("NFKD").replace(/[̀-ͯ]/g, "")
          .replace(/[\s_.]+/g, "-").replace(/[^a-z0-9-]/g, "");
        const next = clean(ui.sub.value).slice(0, 63);
        if (next !== ui.sub.value) {
          ui.sub.value = next;
          const pos = Math.min(clean(before).length, next.length);
          ui.sub.setSelectionRange(pos, pos);
        }
        st.slug = ui.sub.value;
        st.subTouched = true;
        clearError("sub");
        updateResultUrl();
        scheduleCheck("sub");
      });
      ui.sub.addEventListener("keydown", enterSubmits);
      ui.subState = h("div", { class: "pub-check", "aria-live": "polite" });
      ui.resultUrl = h("div", { class: "pub-result" });
      ui.subError = h("div", { class: "field-error", hidden: true });
      // The fixed part of the address in front of the name: "meerpad.com/v/".
      ui.prefix = h("span", { class: "input-addon start pub-prefix", text: `${location.host}/v/` });
      const group = h("div", { class: "input-group pub-sub-group" }, ui.prefix, ui.sub);
      updateResultUrl();
      return h("div", { class: "field" },
        group,
        h("div", { class: "pub-check-row" }, ui.subState, ui.resultUrl),
        ui.subError);
    }

    function updateResultUrl() {
      ui.resultUrl.replaceChildren(h("span", { class: "pub-result-url", text: siteBase() + (st.slug || "your-site") }));
    }

    function domainSection() {
      ui.domain = h("input", {
        class: "input", type: "text", value: st.domain, placeholder: "www.example.com", autocomplete: "off",
        autocapitalize: "off", spellcheck: "false", "aria-label": "Custom domain",
      });
      ui.domain.addEventListener("input", () => {
        st.domain = ui.domain.value;
        clearError("domain");
        renderDns();
        scheduleCheck("domain");
      });
      ui.domain.addEventListener("keydown", enterSubmits);
      ui.domainState = h("div", { class: "pub-check", "aria-live": "polite" });
      ui.domainError = h("div", { class: "field-error", hidden: true });
      ui.dns = h("div", { class: "pub-dns" });
      const details = h("details", { class: "pub-details", open: Boolean(st.domain) },
        h("summary", {},
          h("span", { class: "pub-summary-chev", html: App.icon("chevron-right", 14) }),
          h("span", { class: "pub-summary-title", text: "Custom domain" }),
          h("span", { class: "pub-summary-hint", text: "optional" })),
        h("div", { class: "pub-details-body" },
          h("div", { class: "field" },
            h("label", { class: "field-label", text: "Domain" }),
            ui.domain,
            ui.domainState,
            ui.domainError),
          ui.dns));
      renderDns();
      return h("section", { class: "pub-section" }, details);
    }

    function renderDns() {
      const d = normalizeDomain(st.domain);
      ui.dns.replaceChildren();
      if (!d) {
        ui.dns.append(h("p", { class: "field-help", text: "Serve the site at an address of your own as well, like www.example.com. You will need access to that domain's DNS settings." }));
        return;
      }
      const ip = st.site && st.site.dns && st.site.dns.value;
      const steps = h("ol", { class: "pub-steps" });
      steps.append(h("li", {},
        "Create an ", h("strong", { text: "A record" }), " for ", h("code", { class: "inline-code pub-code", text: d }),
        ip ? " pointing to " : " pointing to your server's public IP address.",
        ip ? h("code", { class: "inline-code pub-code", text: ip }) : null,
        ip ? h("button", { class: "icon-btn icon-btn-small pub-inline-copy", type: "button", title: "Copy IP address",
          "aria-label": "Copy IP address", html: App.icon("copy", 13), onclick: () => copyText(ip, "IP address copied") }) : null));
      if (ip) {
        steps.append(h("li", {}, h("div", { class: "pub-dns-table", role: "table" },
          h("span", { class: "pub-dns-h", text: "Type" }), h("span", { class: "pub-dns-h", text: "Name" }), h("span", { class: "pub-dns-h", text: "Value" }),
          h("span", { text: (st.site.dns && st.site.dns.type) || "A" }), h("span", { class: "pub-mono", text: d }), h("span", { class: "pub-mono", text: ip }))));
      }
      steps.append(h("li", { text: "Add the domain to your server's proxy as well (on Coolify: the service's Domains setting)." }));
      steps.append(h("li", { text: "Save. DNS changes can take a while to reach everyone; the site answers on the domain as soon as they do." }));
      ui.dns.append(steps);
    }

    function optionsSection() {
      const o = st.options;
      ui.title = h("input", { class: "input", type: "text", value: o.title, placeholder: pageTitle, maxlength: "200" });
      ui.title.addEventListener("input", () => { o.title = ui.title.value; clearError("options"); });
      ui.title.addEventListener("keydown", enterSubmits);
      ui.desc = h("textarea", { class: "textarea pub-desc", rows: "2", maxlength: "500",
        placeholder: "A sentence or two about the site" });
      ui.desc.value = o.description;
      ui.desc.addEventListener("input", () => { o.description = ui.desc.value; clearError("options"); });
      ui.footer = h("input", { class: "input", type: "text", value: o.footer, maxlength: "500", placeholder: "For example: © Hof Sonnenwiese" });
      ui.footer.addEventListener("input", () => { o.footer = ui.footer.value; clearError("options"); });
      ui.footer.addEventListener("keydown", enterSubmits);

      const header = h("input", { type: "checkbox", checked: o.show_header });
      header.addEventListener("change", () => { o.show_header = header.checked; });
      const nav = h("input", { type: "checkbox", checked: o.show_nav });
      nav.addEventListener("change", () => { o.show_nav = nav.checked; });

      return h("div", { class: "pub-options" },
        h("div", { class: "field" },
          h("label", { class: "field-label", text: "Site title" }), ui.title,
          h("div", { class: "field-help", text: "Shown in the browser tab and the site's header. Leave it empty to use the page title." })),
        h("div", { class: "field" },
          h("label", { class: "field-label", text: "Description" }), ui.desc,
          h("div", { class: "field-help", text: "For search engines and link previews." })),
        h("div", { class: "field" },
          h("label", { class: "field-label", text: "Footer text" }), ui.footer),
        h("div", { class: "pub-option-rows" },
          h("div", { class: "setting-row" },
            h("div", { class: "setting-text" },
              h("div", { class: "setting-title", text: "Show header" }),
              h("div", { class: "setting-desc", text: "The bar along the top with the site title. In the Minimal and Landing page templates it also holds the navigation links." })),
            h("label", { class: "switch" }, header, h("span", { class: "switch-track" }))),
          h("div", { class: "setting-row" },
            h("div", { class: "setting-text" },
              h("div", { class: "setting-title", text: "Show navigation" }),
              h("div", { class: "setting-desc", text: "Links to the subpages in the site's header or sidebar." })),
            h("label", { class: "switch" }, nav, h("span", { class: "switch-track" }))),
          h("div", { class: "setting-row pub-accent-row" },
            h("div", { class: "setting-text" },
              h("div", { class: "setting-title", text: "Accent colour" }),
              h("div", { class: "setting-desc", text: "Links, buttons and highlights on the site." })),
            accentPicker())));
    }

    function accentPicker() {
      const wrap = h("div", { class: "pub-swatches", role: "radiogroup", "aria-label": "Accent colour" });
      const custom = h("input", { type: "color", class: "pub-color-input", value: st.options.accent, "aria-label": "Custom colour" });
      const customWrap = h("label", { class: "pub-swatch pub-swatch-custom", title: "Custom colour" }, custom);
      const hex = h("span", { class: "pub-hex" });
      const mark = () => {
        const a = st.options.accent.toLowerCase();
        let matched = false;
        for (const b of wrap.querySelectorAll("button.pub-swatch")) {
          const on = b.dataset.color === a;
          matched ||= on;
          b.classList.toggle("selected", on);
          b.setAttribute("aria-checked", String(on));
        }
        customWrap.classList.toggle("selected", !matched);
        customWrap.style.setProperty("--swatch", matched ? "transparent" : a);
        hex.textContent = a;
        setAccentVar();
      };
      for (const [color, name] of SWATCHES) {
        const b = h("button", { class: "pub-swatch", type: "button", role: "radio", title: name, "aria-label": name,
          dataset: { color }, onclick: () => { st.options.accent = color; custom.value = color; mark(); clearError("options"); } });
        b.style.setProperty("--swatch", color);
        wrap.append(b);
      }
      custom.addEventListener("input", () => {
        if (HEX_RE.test(custom.value)) { st.options.accent = custom.value.toLowerCase(); mark(); clearError("options"); }
      });
      wrap.append(customWrap, hex);
      mark();
      return wrap;
    }

    function enterSubmits(e) {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
    }

    // --- live checks ---------------------------------------------------------------
    function scheduleCheck(kind) {
      clearTimeout(timers[kind]);
      seqs[kind] += 1; // an answer still in flight is now out of date
      const stateEl = kind === "sub" ? ui.subState : ui.domainState;
      if (kind === "sub" && !st.slug) { setState(stateEl, "error", "Choose an address"); st.subOk = false; return; }
      if (kind === "domain" && !normalizeDomain(st.domain)) { setState(stateEl, null); st.domainOk = true; return; }
      setState(stateEl, "busy", "Checking…");
      timers[kind] = setTimeout(() => runCheck(kind), CHECK_DELAY);
    }

    function localSubProblem(sub) {
      if (!sub) return "Choose an address";
      if (!SUB_RE.test(sub)) return "Use lowercase letters, digits and dashes, not starting or ending with a dash";
      return null;
    }

    async function runCheck(kind) {
      const seq = ++seqs[kind];
      const stateEl = kind === "sub" ? ui.subState : ui.domainState;
      const value = kind === "sub" ? st.slug : normalizeDomain(st.domain);
      if (!value) { scheduleCheck(kind); return; }
      // The pattern needs no round trip; whether the name is free does.
      const local = kind === "sub" ? localSubProblem(value) : null;
      if (local) { st.subOk = false; setState(stateEl, "error", local); return; }
      if (!navigator.onLine) { setState(stateEl, "muted", "Offline: availability is checked when you are back online"); return; }
      setState(stateEl, "busy", "Checking…");
      const q = new URLSearchParams({ page_id: pageId });
      q.set(kind === "sub" ? "slug" : "domain", value);
      try {
        const r = await App.api.get(`/api/sites/check?${q}`);
        if (closed || seq !== seqs[kind]) return;
        if (kind === "sub") {
          st.subOk = Boolean(r.slug_ok);
          if (r.slug_ok) {
            const current = st.site && st.site.slug === value;
            setState(stateEl, "ok", current ? "This is the site's current address" : "Available");
          } else {
            setState(stateEl, "error", r.detail || "This address cannot be used");
          }
        } else {
          st.domainOk = r.domain_ok !== false;
          if (st.domainOk) setState(stateEl, "ok", st.site && st.site.custom_domain === value ? "Connected to this site" : "This domain can be used");
          else setState(stateEl, "error", r.detail || "This domain cannot be used");
        }
      } catch (e) {
        if (closed || seq !== seqs[kind]) return;
        setState(stateEl, "muted", "Could not check right now; the server checks again when you save");
      }
    }

    function setState(el, kind, text) {
      el.className = `pub-check${kind ? ` is-${kind}` : ""}`;
      el.replaceChildren();
      if (!kind) return;
      if (kind === "busy") el.append(h("span", { class: "spinner spinner-small" }));
      if (kind === "ok") el.append(h("span", { class: "pub-check-icon", html: App.icon("check", 14) }));
      if (kind === "error") el.append(h("span", { class: "pub-check-icon", html: App.icon("warning", 14) }));
      el.append(h("span", { text }));
    }

    // --- errors in place -------------------------------------------------------------
    function showError(detail, field = fieldForError(detail)) {
      if (field === "sub") {
        ui.subError.textContent = detail;
        ui.subError.hidden = false;
        ui.sub.classList.add("invalid");
        setState(ui.subState, null);
        ui.sub.focus();
        ui.sub.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (field === "domain") {
        const det = ui.domain.closest("details");
        if (det) det.open = true;
        ui.domainError.textContent = detail;
        ui.domainError.hidden = false;
        ui.domain.classList.add("invalid");
        setState(ui.domainState, null);
        ui.domain.focus();
        ui.domain.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (field === "template" || field === "options") {
        const el = ui[`${field}SectionError`];
        el.textContent = detail;
        el.hidden = false;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        ui.topError.replaceChildren(h("span", { html: App.icon("warning", 16) }), h("div", {}, h("p", { text: detail })));
        ui.topError.hidden = false;
        body.closest(".modal-body").scrollTo({ top: 0, behavior: "smooth" });
      }
    }

    function clearError(field) {
      if (field === "sub" && ui.subError) { ui.subError.hidden = true; ui.sub.classList.remove("invalid"); }
      if (field === "domain" && ui.domainError) { ui.domainError.hidden = true; ui.domain.classList.remove("invalid"); }
      if ((field === "template" || field === "options") && ui[`${field}SectionError`]) ui[`${field}SectionError`].hidden = true;
      if (ui.topError) ui.topError.hidden = true;
    }

    /* The site was published, saved or unpublished: refresh what depends on
       it. `toTop` brings the status (the news) into view. */
    function afterSiteChange(toTop) {
      renderStatus();
      renderFoot();
      updateResultUrl();
      renderDns();
      runCheck("sub");
      if (normalizeDomain(st.domain)) runCheck("domain");
      if (toTop) body.closest(".modal-body").scrollTo({ top: 0, behavior: "smooth" });
    }

    function clearAllErrors() { ["sub", "domain", "template", "options"].forEach(clearError); }

    // --- saving ------------------------------------------------------------------------
    function setBusy(on, label) {
      st.saving = on;
      foot.querySelectorAll("button").forEach((b) => { b.disabled = on; });
      if (on && label) ui.primary.replaceChildren(h("span", { class: "spinner spinner-small pub-btn-spin" }), label);
    }

    /* Forget checks still waiting or in flight: the save answers for them. */
    function cancelChecks() {
      for (const kind of ["sub", "domain"]) {
        clearTimeout(timers[kind]);
        seqs[kind] += 1;
      }
    }

    async function submit() {
      if (st.saving || !ui.primary) return;
      clearAllErrors();
      cancelChecks();
      if (!navigator.onLine) { showError("You are offline. Publishing needs a connection.", "top"); return; }
      if (!SUB_RE.test(st.slug || "")) { showError(localSubProblem(st.slug), "sub"); return; }
      const wasPublished = Boolean(st.site);
      const o = st.options;
      const payload = {
        slug: st.slug,
        custom_domain: normalizeDomain(st.domain) || null,
        template: st.template,
        enabled: true,
        options: {
          title: o.title.trim(),
          description: o.description.trim(),
          footer: o.footer.trim(),
          show_header: Boolean(o.show_header),
          show_nav: Boolean(o.show_nav),
          accent: HEX_RE.test(o.accent) ? o.accent.toLowerCase() : DEFAULT_ACCENT,
        },
      };
      setBusy(true, wasPublished ? "Saving…" : "Publishing…");
      try {
        const site = await App.api.put(`/api/pages/${encodeURIComponent(pageId)}/site`, payload);
        st.saving = false;
        if (closed) { App.bus.emit("site:changed", { pageId, site }); return; }
        st.subTouched = false;
        st.site = site;
        // Show what was stored ("https://WWW.Example.com/" is www.example.com).
        st.slug = site.slug || st.slug;
        st.domain = site.custom_domain || "";
        ui.sub.value = st.slug;
        ui.domain.value = st.domain;
        // The form already holds what was saved: only the parts that depend
        // on the site change, so nothing jumps under the pointer.
        afterSiteChange(!wasPublished);
        App.bus.emit("site:changed", { pageId, site });
        App.toast(wasPublished ? "Changes saved" : "Published. Your site is live.", {
          kind: "ok",
          action: site && site.url ? { label: "Open", run: () => window.open(site.url, "_blank", "noopener") } : undefined,
        });
      } catch (e) {
        if (closed) { App.toast(`Publishing failed: ${e.message || e}`, { kind: "error" }); return; }
        setBusy(false);
        renderFoot();
        showError(e.status ? (e.message || `Error ${e.status}`) : "Could not reach the server. Check your connection and try again.");
      }
    }

    async function unpublish() {
      if (st.saving || !st.site) return;
      const where = (st.site.url || "").replace(/^https?:\/\//, "") || "The site";
      const ok = await App.ui.confirm(
        `${where}${st.site.custom_domain ? ` and ${st.site.custom_domain}` : ""} will stop answering right away, and the address becomes free for anyone to take. The page itself stays as it is.`,
        { title: "Unpublish this site?", confirmLabel: "Unpublish", danger: true });
      if (!ok || closed) return;
      clearAllErrors();
      setBusy(true);
      try {
        await App.api.del(`/api/pages/${encodeURIComponent(pageId)}/site`);
        st.saving = false;
        st.site = null;
        st.subTouched = true; // keep the address in the field, in case of a change of heart
        if (closed) { App.bus.emit("site:changed", { pageId, site: null }); return; }
        afterSiteChange(true);
        App.bus.emit("site:changed", { pageId, site: null });
        App.toast("Unpublished. The site is offline.", { kind: "ok" });
      } catch (e) {
        if (e.status === 404) {
          // Already gone (another tab or device): that is what was wanted.
          st.saving = false;
          st.site = null;
          afterSiteChange(true);
          App.bus.emit("site:changed", { pageId, site: null });
          return;
        }
        setBusy(false);
        renderFoot();
        showError(e.status ? (e.message || `Error ${e.status}`) : "Could not reach the server. Check your connection and try again.");
      }
    }

    load();
    return modal;
  }

  return { open, slugify };
})();
