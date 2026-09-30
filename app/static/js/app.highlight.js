/* Syntax highlighting for code blocks: highlight.js, vendored and loaded on
   first use.

   Vendored (app/static/vendor/highlight/, the "common" build plus dockerfile,
   latex, nginx, powershell and scala) rather than fetched from a CDN, because a
   code block must look the same offline, and the service worker precaches it
   with the rest of the app. Loaded lazily all the same: a page without code
   never pays for its 140 KB.

   highlight.js only wraps the source in spans and escapes it, so the text
   content of its output is exactly the code. That is what lets the editor
   highlight a block *while it is being typed in*: caret positions are
   character offsets, and they mean the same thing before and after. */

window.App = window.App || {};

App.highlight = (() => {
  const SRC = "/static/vendor/highlight/highlight.min.js";
  // Beyond this, highlighting on every keystroke is noticeable; the block is
  // shown as plain text instead.
  const MAX_CHARS = 60000;
  // The editor's language names where highlight.js spells them differently.
  const ALIAS = { plain: null, plaintext: null, text: null, mermaid: null, shell: "bash", html: "xml" };
  let loading = null;

  function ready() {
    return Boolean(window.hljs && window.hljs.highlight);
  }

  function load() {
    if (ready()) return Promise.resolve(true);
    if (!loading) {
      loading = new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = SRC;
        s.async = true;
        s.onload = () => resolve(ready());
        s.onerror = () => { loading = null; resolve(false); };
        document.head.append(s);
      });
    }
    return loading;
  }

  /* The highlight.js name for a block's language, or null for none. */
  function language(lang) {
    const l = String(lang || "plain").toLowerCase();
    if (l in ALIAS) return ALIAS[l];
    return l;
  }

  /* Would this language be highlighted once the library is here? */
  function wants(lang) {
    return language(lang) !== null;
  }

  /* Highlighted HTML for `code`, or null (not loaded, no language, unknown
     language, or too long): the caller then escapes the text itself. */
  function html(code, lang) {
    const l = language(lang);
    if (!l || !ready() || code.length > MAX_CHARS || !window.hljs.getLanguage(l)) return null;
    try {
      return window.hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
    } catch (e) {
      return null;
    }
  }

  return { ready, load, wants, html, language };
})();
