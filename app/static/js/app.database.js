/* Database pages: table, board, list, gallery and Gantt views over a database's rows.

   docs/DESIGN.md §4 is the contract. A database is a page with a `schema`
   ({ properties, views }); its rows are its child pages, and a row's values
   live in `row.props[property_id]` (the title property is the row's `title`).
   Everything here reads through App.store and writes through it:

   * a schema change is always a whole new schema object
     (App.store.updatePage(dbId, { schema })), because the server replaces
     `schema` whole (§5);
   * a row value change is always a whole new `props` object, for the same
     reason.

   The UI is rebuilt from the store on every relevant "store:change", which
   keeps it simple and correct, with three exceptions that make it feel solid:
   the active view, horizontal scroll positions, and an open cell editor all
   survive a rebuild. An open editor defers the rebuild until it closes, so a
   sync landing mid-edit never throws away what the user is typing.

   Public API (other modules call exactly this):
     App.database.defaultSchema()
     App.database.ganttSchema()   the "Gantt chart" preset: tasks with dates
     App.database.mount(el, { pageId, inline, readOnly, viewId }) -> { destroy() }
     App.database.propertiesPanel(rowId, { readOnly }) -> HTMLElement (with .destroy())
     App.database.PROPERTY_TYPES

   User text only ever reaches the DOM as text (App.el's `text` or child
   strings). The `html` attribute is used for App.icon markup alone. */

window.App = window.App || {};

App.database = (() => {
  const el = (...a) => App.el(...a);
  const icon = (name, size) => App.icon(name, size);

  // A few glyphs the shared icon set does not have. Registered only when
  // missing, so a later icon set that defines them wins.
  const EXTRA_ICONS = {
    "db-lines": '<path d="M4 6h16M4 12h16M4 18h10"/>',
    "db-status": '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
    "db-paperclip": '<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
    "db-title": '<path d="M3 18L7.5 6h1L13 18M4.6 14h6.8"/><path d="M20.5 18v-4.8a2.7 2.7 0 0 0-5-1.4M20.5 15.2c-3.8-.6-5.5.4-5.5 1.6s1 1.5 2 1.5c1.6 0 3.5-1.1 3.5-3.1"/>',
    "db-arrow-down": '<path d="M12 5v14M6 13l6 6 6-6"/>',
    "db-arrow-up": '<path d="M12 19V5M6 11l6-6 6 6"/>',
    "db-gantt": '<rect x="3.5" y="4.5" width="10" height="4" rx="2"/><rect x="8.5" y="10" width="12" height="4" rx="2"/><rect x="5.5" y="15.5" width="8" height="4" rx="2"/>',
    "db-scale": '<path d="M3 12h18M3 8.5v7M21 8.5v7M9 10.5v3M15 10.5v3"/>',
  };
  if (App.ICONS) for (const [k, v] of Object.entries(EXTRA_ICONS)) if (!App.ICONS[k]) App.ICONS[k] = v;

  /* The property types a user can pick. "title" is not in the list: every
     database has exactly one, and it cannot be created or converted. */
  const PROPERTY_TYPES = [
    { type: "text", label: "Text", icon: "db-lines" },
    { type: "number", label: "Number", icon: "hash" },
    { type: "select", label: "Select", icon: "select" },
    { type: "multi_select", label: "Multi-select", icon: "tags" },
    { type: "status", label: "Status", icon: "db-status" },
    { type: "date", label: "Date", icon: "calendar" },
    { type: "checkbox", label: "Checkbox", icon: "checkbox" },
    { type: "person", label: "Person", icon: "person" },
    { type: "files", label: "Files & media", icon: "db-paperclip" },
    { type: "url", label: "URL", icon: "link" },
    { type: "email", label: "Email", icon: "mail" },
    { type: "phone", label: "Phone", icon: "phone" },
    { type: "created_time", label: "Created time", icon: "clock" },
    { type: "last_edited_time", label: "Last edited time", icon: "history" },
  ];
  const TYPE_INFO = Object.fromEntries(PROPERTY_TYPES.map((t) => [t.type, t]));
  TYPE_INFO.title = { type: "title", label: "Title", icon: "db-title" };
  const typeIcon = (type) => (TYPE_INFO[type] || TYPE_INFO.text).icon;
  const typeLabel = (type) => (TYPE_INFO[type] || { label: type }).label;

  const VIEW_TYPES = [
    { type: "table", label: "Table", icon: "table" },
    { type: "board", label: "Board", icon: "board" },
    { type: "list", label: "List", icon: "list" },
    { type: "gallery", label: "Gallery", icon: "gallery" },
    { type: "gantt", label: "Gantt", icon: "db-gantt" },
  ];
  const viewIcon = (type) => (VIEW_TYPES.find((v) => v.type === type) || VIEW_TYPES[0]).icon;

  const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
  const COLOR_LABEL = (c) => c.charAt(0).toUpperCase() + c.slice(1);
  const randomColor = () => COLORS[1 + Math.floor(Math.random() * (COLORS.length - 1))];

  const SELECT_LIKE = new Set(["select", "multi_select", "status"]);
  const COMPUTED = new Set(["created_time", "last_edited_time"]);
  // Types whose value is a plain string typed into an input.
  const TEXT_LIKE = new Set(["title", "text", "url", "email", "phone", "person"]);

  const NUMBER_FORMATS = [
    { id: "number", label: "Number" },
    { id: "comma", label: "Number with commas" },
    { id: "percent", label: "Percent" },
    { id: "dollar", label: "US dollar" },
    { id: "euro", label: "Euro" },
    { id: "pound", label: "Pound" },
    { id: "yen", label: "Yen" },
  ];

  const OP_LABEL = {
    contains: "contains", eq: "is", neq: "is not", empty: "is empty", not_empty: "is not empty",
    checked: "is checked", unchecked: "is not checked",
  };
  const NO_VALUE_OPS = new Set(["empty", "not_empty", "checked", "unchecked"]);

  /* The filter operators that make sense for a type (DESIGN §4 lists them all). */
  function opsFor(type) {
    if (type === "checkbox") return ["checked", "unchecked"];
    if (type === "select" || type === "status") return ["eq", "neq", "empty", "not_empty"];
    if (type === "multi_select" || type === "files") return ["contains", "empty", "not_empty"];
    if (type === "number") return ["eq", "neq", "empty", "not_empty"];
    if (type === "date" || COMPUTED.has(type)) return ["eq", "empty", "not_empty"];
    return ["contains", "eq", "neq", "empty", "not_empty"];
  }

  // --- ids -------------------------------------------------------------------
  const rid = (prefix) => prefix + App.uuid().replace(/-/g, "").slice(0, 10);

  function defaultSchema() {
    return {
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: rid("p_"), name: "Tags", type: "multi_select", options: [] },
      ],
      views: [{ id: rid("v_"), name: "Table", type: "table" }],
    };
  }

  const statusOptions = () => [
    { id: rid("o_"), name: "Not started", color: "gray" },
    { id: rid("o_"), name: "In progress", color: "blue" },
    { id: rid("o_"), name: "Done", color: "green" },
  ];

  /* The "Gantt chart" preset: tasks with a date range, a status that colours
     the bars, an owner and a progress, shown as a Gantt first and a table
     second. */
  function ganttSchema() {
    const dates = rid("p_");
    const status = rid("p_");
    return {
      properties: [
        { id: "title", name: "Task", type: "title" },
        { id: dates, name: "Dates", type: "date" },
        { id: status, name: "Status", type: "status", options: statusOptions() },
        { id: rid("p_"), name: "Owner", type: "person" },
        { id: rid("p_"), name: "Progress", type: "number", number_format: "percent" },
      ],
      views: [
        { id: rid("v_"), name: "Gantt", type: "gantt", date_property: dates, color_by: status, zoom: "week" },
        { id: rid("v_"), name: "Table", type: "table" },
      ],
    };
  }

  // --- schema ----------------------------------------------------------------
  /* A usable copy of a database's schema. Imported or hand-made pages may lack
     parts of it; this fills the gaps so the UI never has to check, and the
     fill is only written back when the user changes something. */
  function schemaOf(page) {
    const raw = page && page.schema && typeof page.schema === "object" ? structuredClone(page.schema) : {};
    const s = { ...raw };
    s.properties = Array.isArray(raw.properties) ? raw.properties.filter((p) => p && p.id && p.type) : [];
    if (!s.properties.some((p) => p.id === "title")) s.properties.unshift({ id: "title", name: "Name", type: "title" });
    for (const p of s.properties) {
      if (p.id === "title") p.type = "title";
      if (typeof p.name !== "string") p.name = typeLabel(p.type);
      if (SELECT_LIKE.has(p.type)) p.options = Array.isArray(p.options) ? p.options.filter((o) => o && typeof o.name === "string") : [];
    }
    s.views = Array.isArray(raw.views) ? raw.views.filter((v) => v && v.id) : [];
    if (!s.views.length) s.views.push({ id: "v_default", name: "Table", type: "table" });
    for (const v of s.views) {
      if (!VIEW_TYPES.some((t) => t.type === v.type)) v.type = "table";
      if (typeof v.name !== "string") v.name = "Table";
    }
    return s;
  }

  const propById = (schema, id) => schema.properties.find((p) => p.id === id) || null;

  /* Properties in a view's order: the listed ids first, then everything else
     in schema order (so a property added later simply appears at the end). */
  function orderedProps(schema, view) {
    const order = Array.isArray(view && view.order) ? view.order : [];
    const listed = order.map((id) => propById(schema, id)).filter(Boolean);
    const seen = new Set(listed.map((p) => p.id));
    return [...listed, ...schema.properties.filter((p) => !seen.has(p.id))];
  }

  const isHidden = (view, id) => Array.isArray(view && view.hidden) && view.hidden.includes(id);

  /* The columns of a table: the title is always shown there. */
  function tableColumns(schema, view) {
    return orderedProps(schema, view).filter((p) => p.id === "title" || !isHidden(view, p.id));
  }

  /* The properties shown on cards and list lines (the title is the card itself). */
  function cardProps(schema, view) {
    return orderedProps(schema, view).filter((p) => p.id !== "title" && !isHidden(view, p.id)
      && !(view.type === "board" && p.id === view.group_by));
  }

  function uniqueName(existing, base) {
    const names = new Set(existing.map((x) => String(x.name).toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }

  // --- values ----------------------------------------------------------------
  function getValue(row, prop) {
    if (!row || !prop) return undefined;
    if (prop.type === "title") return row.title || "";
    if (prop.type === "created_time") return row.created_at || "";
    if (prop.type === "last_edited_time") return App.store.lastEdited(row.id) || row.updated_at || "";
    return (row.props || {})[prop.id];
  }

  // Stored values can be anything (an old type, an import): coerce on read.
  const asList = (v) => (Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === "" ? [] : [String(v)]);
  const asOne = (v) => (Array.isArray(v) ? (v[0] === undefined ? "" : String(v[0])) : v === null || v === undefined ? "" : String(v));
  const asFiles = (v) => (Array.isArray(v) ? v.filter((f) => f && typeof f === "object" && (f.file_id || f.url)) : []);
  const asBool = (v) => v === true || v === "true" || v === 1;

  function dateParts(v) {
    if (!v) return { start: "", end: "" };
    if (typeof v === "string") return { start: v, end: "" };
    if (typeof v === "object") return { start: String(v.start || ""), end: String(v.end || "") };
    return { start: "", end: "" };
  }

  function isEmpty(prop, v) {
    if (prop.type === "checkbox") return !asBool(v);
    if (prop.type === "multi_select") return asList(v).length === 0;
    if (prop.type === "files") return asFiles(v).length === 0;
    if (prop.type === "date") return !dateParts(v).start;
    if (prop.type === "number") return v === null || v === undefined || v === "" || !Number.isFinite(Number(v));
    return v === null || v === undefined || String(asOne(v)).trim() === "";
  }

  /* A value as plain text: for sorting, text filters and tooltips. */
  function textOf(prop, v) {
    if (prop.type === "multi_select") return asList(v).join(", ");
    if (prop.type === "files") return asFiles(v).map((f) => f.name || "").join(", ");
    if (prop.type === "date") return dateParts(v).start;
    if (prop.type === "checkbox") return asBool(v) ? "true" : "false";
    return asOne(v);
  }

  /* Write one value. The title goes to the row's title; everything else into
     a whole new props object (the server replaces props whole). */
  function setValue(rowId, prop, value) {
    const row = App.store.page(rowId);
    if (!row || COMPUTED.has(prop.type)) return false;
    if (prop.type === "title") {
      const title = String(value || "");
      if (title === (row.title || "")) return false;
      App.store.updatePage(rowId, { title });
      return true;
    }
    const props = structuredClone(row.props || {});
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
    const before = JSON.stringify(props[prop.id] === undefined ? null : props[prop.id]);
    if (empty) delete props[prop.id];
    else props[prop.id] = value;
    if (before === JSON.stringify(props[prop.id] === undefined ? null : props[prop.id])) return false;
    App.store.updatePage(rowId, { props });
    return true;
  }

  // --- formatting --------------------------------------------------------------
  /* "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM" are wall-clock values, not instants:
     parse them as local time (new Date("2026-09-30") would be UTC midnight,
     which is the day before anywhere west of Greenwich). */
  function parseLocal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ""));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
    return Number.isNaN(d.getTime()) ? null : { date: d, hasTime: m[4] !== undefined };
  }
  // Built once: toLocaleDateString() makes a new formatter on every call,
  // which is most of the cost of a few hundred date cells.
  const fmts = {};
  const dayFmt = () => (fmts.day ||= new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }));
  const timeFmt = () => (fmts.time ||= new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }));
  function fmtLocal(s) {
    const p = parseLocal(s);
    if (!p) return String(s || "");
    const day = dayFmt().format(p.date);
    return p.hasTime ? `${day} ${timeFmt().format(p.date)}` : day;
  }
  function fmtDate(v) {
    const { start, end } = dateParts(v);
    if (!start) return "";
    return end ? `${fmtLocal(start)} → ${fmtLocal(end)}` : fmtLocal(start);
  }
  /* A server instant ("...Z") with its time, for created and edited times. */
  function fmtInstant(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${dayFmt().format(d)} ${timeFmt().format(d)}`;
  }
  function fmtNumber(prop, v) {
    const n = Number(v);
    if (v === "" || v === null || v === undefined || !Number.isFinite(n)) return asOne(v);
    const f = prop.number_format;
    const cur = { dollar: "USD", euro: "EUR", pound: "GBP", yen: "JPY" }[f];
    try {
      if (cur) return (fmts[f] ||= new Intl.NumberFormat(undefined, { style: "currency", currency: cur })).format(n);
      if (f === "percent") return (fmts[f] ||= new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 })).format(n / 100);
      if (f === "comma") return (fmts[f] ||= new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 })).format(n);
    } catch (e) { /* an unknown locale or currency: plain digits below */ }
    return String(n);
  }

  // --- Gantt: whole days -------------------------------------------------------------
  /* A Gantt chart works in calendar days. A day is an integer (days since
     1970-01-01 on the calendar, not an instant), so moving a bar by a day
     never trips over a daylight saving change, and "YYYY-MM-DD" maps to a day
     and back without a time zone. A Date made from a day is read with the
     getUTC* methods and formatted with timeZone "UTC", for the same reason. */
  const DAY_MS = 86400000;
  function dayFromYMD(y, m, d) {
    const t = new Date(0);
    t.setUTCFullYear(y, m, d); // unlike Date.UTC, years below 100 stay themselves
    return Math.round(t.getTime() / DAY_MS);
  }
  function dayOf(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof s === "string" ? s : "");
    return m ? dayFromYMD(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  const dayDate = (n) => new Date(n * DAY_MS);
  function dayStr(n) {
    const d = dayDate(n);
    const pad = (x, w = 2) => String(x).padStart(w, "0");
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  function todayNum() {
    const d = new Date();
    return dayFromYMD(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const weekdayOf = (n) => (((n + 4) % 7) + 7) % 7; // 0 is Sunday; 1970-01-01 was a Thursday
  const mondayOf = (n) => n - ((weekdayOf(n) + 6) % 7);
  const monthOf = (n, k = 0) => { const d = dayDate(n); return dayFromYMD(d.getUTCFullYear(), d.getUTCMonth() + k, 1); };
  const yearOf = (n, k = 0) => dayFromYMD(dayDate(n).getUTCFullYear() + k, 0, 1);
  const utcFmt = (key, o) => (fmts[key] ||= new Intl.DateTimeFormat(undefined, { ...o, timeZone: "UTC" }));
  const fmtDay = (n) => utcFmt("g-day", { year: "numeric", month: "short", day: "numeric" }).format(dayDate(n));
  function fmtSpan(s, e) {
    if (s === e) return fmtDay(s);
    const f = utcFmt("g-day", { year: "numeric", month: "short", day: "numeric" });
    const n = e - s + 1;
    const range = f.formatRange ? f.formatRange(dayDate(s), dayDate(e)) : `${fmtDay(s)} → ${fmtDay(e)}`;
    return `${range} (${n} days)`;
  }

  const GANTT_ZOOMS = [
    { id: "day", label: "Day", px: 36 },
    { id: "week", label: "Week", px: 18 },
    { id: "month", label: "Month", px: 4 },
  ];
  const zoomOf = (id) => GANTT_ZOOMS.find((z) => z.id === id) || GANTT_ZOOMS[1];
  // How wide a bar's title is, to know whether it fits inside the bar. One
  // canvas measures them all (a few hundred titles take well under a frame).
  let measurer = null;
  function textWidth(text, font) {
    measurer ||= document.createElement("canvas").getContext("2d");
    if (!measurer) return text.length * 7;
    measurer.font = font;
    return measurer.measureText(text).width;
  }
  // Past this many days a strip would be millions of pixels wide (a typo like
  // the year 0206 does that); the range is cut around today instead.
  const GANTT_MAX_DAYS = 366 * 30;

  /* What a Gantt view draws with: its date property (the view's, else the
     first date property), an optional second date property for the end, and
     an optional select or status property whose option colours the bars. */
  function ganttConfig(schema, view) {
    const dates = schema.properties.filter((p) => p.type === "date");
    const start = dates.find((p) => p.id === view.date_property) || dates[0] || null;
    const end = start ? dates.find((p) => p.id === view.end_property && p.id !== start.id) || null : null;
    const color = schema.properties.find((p) => p.id === view.color_by && (p.type === "select" || p.type === "status")) || null;
    return { dates, start, end, color };
  }

  /* A row's span in days ({ s, e, milestone }), or null without a start. The
     end is the date's own end, or the end property's date. A single date is
     a milestone; an end before the start is read the other way round rather
     than hidden. */
  function ganttSpan(row, cfg) {
    const props = (row && row.props) || {};
    const own = dateParts(props[cfg.start.id]);
    let s = dayOf(own.start);
    if (s === null) return null;
    let e = dayOf(cfg.end ? dateParts(props[cfg.end.id]).start : own.end);
    const milestone = e === null;
    if (e === null) e = s;
    if (e < s) [s, e] = [e, s];
    return { s, e, milestone };
  }

  /* The row's props with a new span written into them: a whole new props
     object for App.store.updatePage. A time of day stays with its date. A
     milestone stays a single date; anything else is a { start, end } range,
     or a start and an end property. */
  function ganttProps(row, cfg, s, e, milestone = false) {
    const props = structuredClone((row && row.props) || {});
    const withTime = (old, n) => dayStr(n) + (dayOf(old) !== null ? String(old).slice(10) : "");
    const cur = dateParts(props[cfg.start.id]);
    if (cfg.end) {
      props[cfg.start.id] = withTime(cur.start, s);
      if (!milestone) props[cfg.end.id] = withTime(dateParts(props[cfg.end.id]).start, e);
    } else if (milestone) {
      props[cfg.start.id] = withTime(cur.start, s);
    } else {
      props[cfg.start.id] = { start: withTime(cur.start, s), end: withTime(cur.end, e) };
    }
    return props;
  }

  /* A new or re-laid-out Gantt view: dates from the first date property, a
     week at a glance, bars coloured by the first status property. */
  function ganttDefaults(v, s) {
    const d = s.properties.find((p) => p.type === "date");
    if (d && !propById(s, v.date_property)) v.date_property = d.id;
    if (!GANTT_ZOOMS.some((z) => z.id === v.zoom)) v.zoom = "week";
    if (v.color_by === undefined) {
      const st = s.properties.find((p) => p.type === "status");
      if (st) v.color_by = st.id;
    }
  }

  // Links built from values: only these schemes ever reach an href.
  function hrefFor(type, v) {
    const s = String(v || "").trim();
    if (!s) return "";
    if (type === "email") return `mailto:${s}`;
    if (type === "phone") return `tel:${s.replace(/[^\d+#*,;]/g, "")}`;
    if (type === "url") return /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return "";
  }
  function fileHref(f) {
    if (f.file_id) return App.files.url(f.file_id, f.name || undefined);
    return /^https?:\/\//i.test(String(f.url || "")) ? f.url : "";
  }

  // --- filtering and sorting ----------------------------------------------------
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const hasValue = (f) => f.value !== undefined && f.value !== null && String(f.value).trim() !== "";

  function matchFilter(row, f, schema) {
    const prop = propById(schema, f.property);
    if (!prop) return true; // a filter on a deleted property filters nothing
    const v = getValue(row, prop);
    switch (f.op) {
      case "empty": return isEmpty(prop, v);
      case "not_empty": return !isEmpty(prop, v);
      case "checked": return asBool(v);
      case "unchecked": return !asBool(v);
      default: break;
    }
    // An unfinished filter (no value yet) lets everything through, the way a
    // half-typed filter should not blank the table.
    if (!hasValue(f)) return true;
    const want = String(f.value).trim();
    const eq = () => {
      if (prop.type === "number") return !isEmpty(prop, v) && Number(v) === Number(want);
      if (prop.type === "multi_select") return asList(v).includes(want);
      if (prop.type === "date") return dateParts(v).start.slice(0, 10) === want.slice(0, 10);
      if (COMPUTED.has(prop.type)) {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return false;
        const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return local === want.slice(0, 10);
      }
      if (prop.type === "select" || prop.type === "status") return asOne(v) === want;
      return textOf(prop, v).trim().toLowerCase() === want.toLowerCase();
    };
    if (f.op === "eq") return eq();
    if (f.op === "neq") return !eq();
    if (f.op === "contains") {
      if (prop.type === "multi_select") return asList(v).includes(want);
      return textOf(prop, v).toLowerCase().includes(want.toLowerCase());
    }
    return true;
  }

  function sortKey(row, prop) {
    const v = getValue(row, prop);
    if (prop.type === "checkbox") return { empty: false, key: asBool(v) ? 1 : 0 };
    if (isEmpty(prop, v)) return { empty: true };
    if (prop.type === "number") return { empty: false, key: Number(v) };
    if (prop.type === "select" || prop.type === "status") {
      const i = (prop.options || []).findIndex((o) => o.name === asOne(v));
      return { empty: false, key: i < 0 ? 1e9 : i, text: asOne(v) };
    }
    if (prop.type === "date") return { empty: false, key: dateParts(v).start, str: true };
    if (COMPUTED.has(prop.type)) return { empty: false, key: String(v), str: true };
    return { empty: false, text: textOf(prop, v) };
  }

  function compareKeys(a, b) {
    if (a.text !== undefined && a.key === undefined) return collator.compare(a.text, b.text || "");
    if (a.str) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.text !== undefined ? collator.compare(a.text, b.text || "") : 0;
  }

  /* The rows a view shows, in the order it shows them. Rows arrive in
     position order; Array.prototype.sort is stable, so ties keep it. */
  function viewRows(dbId, schema, view) {
    let rows = App.store.children(dbId);
    const filters = Array.isArray(view.filter) ? view.filter : [];
    if (filters.length) rows = rows.filter((r) => filters.every((f) => matchFilter(r, f, schema)));
    const sorts = (Array.isArray(view.sort) ? view.sort : []).map((s) => ({ ...s, prop: propById(schema, s.property) })).filter((s) => s.prop);
    if (sorts.length) {
      const keyed = rows.map((r) => ({ r, keys: sorts.map((s) => sortKey(r, s.prop)) }));
      keyed.sort((x, y) => {
        for (let i = 0; i < sorts.length; i++) {
          const a = x.keys[i];
          const b = y.keys[i];
          if (a.empty || b.empty) {
            if (a.empty && b.empty) continue;
            return a.empty ? 1 : -1; // empty values last, whichever direction
          }
          const c = compareKeys(a, b);
          if (c) return sorts[i].direction === "desc" ? -c : c;
        }
        return 0;
      });
      rows = keyed.map((k) => k.r);
    }
    return rows;
  }

  /* Values a new row should start with so that it stays visible in a
     filtered view: the simple filters (is, contains, checked) say what. */
  function prefillFor(schema, view) {
    const props = {};
    let title = "";
    for (const f of Array.isArray(view.filter) ? view.filter : []) {
      const prop = propById(schema, f.property);
      if (!prop || COMPUTED.has(prop.type)) continue;
      if (f.op === "checked" && prop.type === "checkbox") { props[prop.id] = true; continue; }
      if (!hasValue(f) || !(f.op === "eq" || f.op === "contains")) continue;
      const want = String(f.value).trim();
      if (prop.type === "title") title = want;
      else if (prop.type === "multi_select") props[prop.id] = [...new Set([...asList(props[prop.id]), want])];
      else if (prop.type === "number") { if (Number.isFinite(Number(want))) props[prop.id] = Number(want); }
      else if (prop.type === "files") continue;
      else props[prop.id] = want;
    }
    return { props, title };
  }

  // --- writes ------------------------------------------------------------------
  /* Run a write, turning a refusal (a read-only page, a vanished row) into a
     toast instead of an uncaught error in an event handler. */
  function safely(fn) {
    try { return fn(); } catch (e) {
      console.error(e);
      App.toast(e.message || "That change could not be saved", { kind: "error" });
      return undefined;
    }
  }

  /* Change a database's schema: clone, let `fn` modify, write it whole.
     `fn` returning false means "nothing to change". */
  function mutateSchema(dbId, fn) {
    return safely(() => {
      const page = App.store.page(dbId);
      if (!page) return false;
      const s = schemaOf(page);
      if (fn(s) === false) return false;
      App.store.updatePage(dbId, { schema: s });
      return true;
    });
  }

  function mutateView(dbId, viewId, fn) {
    return mutateSchema(dbId, (s) => {
      const v = s.views.find((x) => x.id === viewId);
      if (!v) return false;
      return fn(v, s);
    });
  }

  function addProperty(dbId, type, name) {
    let created = null;
    mutateSchema(dbId, (s) => {
      created = { id: rid("p_"), name: uniqueName(s.properties, name || typeLabel(type)), type };
      if (type === "status") {
        created.options = [
          { id: rid("o_"), name: "Not started", color: "gray" },
          { id: rid("o_"), name: "In progress", color: "blue" },
          { id: rid("o_"), name: "Done", color: "green" },
        ];
      } else if (SELECT_LIKE.has(type)) created.options = [];
      s.properties.push(created);
    });
    return created;
  }

  /* Remove a property and every trace of it in the views. Stored row values
     are left alone: nothing can read them without the property, and
     rewriting every row would cost a mutation per row for nothing. */
  function deleteProperty(dbId, propId) {
    if (propId === "title") return;
    mutateSchema(dbId, (s) => {
      s.properties = s.properties.filter((p) => p.id !== propId);
      for (const v of s.views) {
        if (Array.isArray(v.sort)) v.sort = v.sort.filter((x) => x.property !== propId);
        if (Array.isArray(v.filter)) v.filter = v.filter.filter((x) => x.property !== propId);
        if (Array.isArray(v.hidden)) v.hidden = v.hidden.filter((x) => x !== propId);
        if (Array.isArray(v.order)) v.order = v.order.filter((x) => x !== propId);
        if (v.widths) delete v.widths[propId];
        if (v.group_by === propId) delete v.group_by;
      }
    });
  }

  /* Convert a property to another type. Values move along where the
     conversion is obvious (text, select, multi-select and status into each
     other; text and numbers); anything else stays stored as it was, and the
     renderers cope with a value of the "wrong" shape. */
  function changeType(dbId, propId, type) {
    const page = App.store.page(dbId);
    if (!page || propId === "title") return;
    const prop = propById(schemaOf(page), propId);
    if (!prop || prop.type === type) return;
    const from = prop.type;
    const stringy = new Set(["text", "url", "email", "phone", "person", "select", "status"]);
    const rows = App.store.children(dbId);
    const convert = (v) => {
      if (v === undefined || v === null) return undefined;
      if (type === "multi_select" && (stringy.has(from) || from === "number")) {
        return String(v).split(from === "text" ? "," : "\u0000").map((x) => x.trim()).filter(Boolean);
      }
      if (SELECT_LIKE.has(type) && type !== "multi_select" && (from === "multi_select" || stringy.has(from) || from === "number")) {
        const one = asOne(v).trim();
        return one || undefined;
      }
      if (stringy.has(type) && !SELECT_LIKE.has(type) && (stringy.has(from) || from === "multi_select" || from === "number")) {
        return from === "multi_select" ? asList(v).join(", ") : String(v);
      }
      if (type === "number" && (stringy.has(from) || from === "multi_select")) {
        const n = Number(String(asOne(v)).replace(",", ".").replace(/[^\d.eE+-]/g, ""));
        return Number.isFinite(n) && String(asOne(v)).trim() !== "" ? n : v;
      }
      if (type === "checkbox" && stringy.has(from)) return /^(true|yes|x|1|done|checked)$/i.test(String(v).trim());
      return v;
    };
    safely(() => App.store.group("Change property type", () => {
      const newValues = new Map();
      if (!COMPUTED.has(from) && !COMPUTED.has(type)) {
        for (const r of rows) {
          const v = (r.props || {})[propId];
          if (v === undefined) continue;
          const nv = convert(v);
          if (JSON.stringify(nv) !== JSON.stringify(v)) newValues.set(r.id, nv);
        }
      }
      mutateSchema(dbId, (s) => {
        const p = propById(s, propId);
        if (!p) return false;
        p.type = type;
        if (SELECT_LIKE.has(type)) {
          // Keep the options there were; add one for every value in use.
          const opts = Array.isArray(p.options) ? p.options : [];
          const known = new Set(opts.map((o) => o.name));
          for (const r of rows) {
            const v = newValues.has(r.id) ? newValues.get(r.id) : (r.props || {})[propId];
            for (const name of asList(v)) {
              if (name && !known.has(name)) { known.add(name); opts.push({ id: rid("o_"), name, color: randomColor() }); }
            }
          }
          if (type === "status" && !opts.length) {
            opts.push({ id: rid("o_"), name: "Not started", color: "gray" }, { id: rid("o_"), name: "In progress", color: "blue" }, { id: rid("o_"), name: "Done", color: "green" });
          }
          p.options = opts;
        }
        if (type !== "number") delete p.number_format;
        // Filters whose operator no longer fits the type would silently
        // match nothing; reset them to the type's first operator.
        for (const v of s.views) {
          for (const f of Array.isArray(v.filter) ? v.filter : []) {
            if (f.property === propId && !opsFor(type).includes(f.op)) { f.op = opsFor(type)[0]; f.value = ""; }
          }
          if (v.group_by === propId && !(type === "select" || type === "status")) delete v.group_by;
        }
      });
      for (const [id, nv] of newValues) setValue(id, { id: propId, type: "text" }, nv);
    }));
  }

  /* Rename an option: rows store option names, so their values (and any view
     filter pointing at the old name) follow the rename. One undo step. */
  function renameOption(dbId, propId, optionId, name) {
    name = String(name || "").trim();
    const page = App.store.page(dbId);
    const prop = page && propById(schemaOf(page), propId);
    const opt = prop && (prop.options || []).find((o) => o.id === optionId);
    if (!opt || !name || name === opt.name) return false;
    if ((prop.options || []).some((o) => o.id !== optionId && o.name === name)) {
      App.toast(`There is already an option called "${name}"`, { kind: "warning" });
      return false;
    }
    const old = opt.name;
    safely(() => App.store.group("Rename option", () => {
      mutateSchema(dbId, (s) => {
        const p = propById(s, propId);
        const o = p && (p.options || []).find((x) => x.id === optionId);
        if (!o) return false;
        o.name = name;
        for (const v of s.views) for (const f of Array.isArray(v.filter) ? v.filter : []) {
          if (f.property === propId && f.value === old) f.value = name;
        }
      });
      for (const r of App.store.children(dbId)) {
        const v = (r.props || {})[propId];
        if (v === undefined) continue;
        if (Array.isArray(v) ? v.includes(old) : v === old) {
          setValue(r.id, prop, Array.isArray(v) ? v.map((x) => (x === old ? name : x)) : name);
        }
      }
    }));
    return true;
  }

  function deleteOption(dbId, propId, optionId) {
    const page = App.store.page(dbId);
    const prop = page && propById(schemaOf(page), propId);
    const opt = prop && (prop.options || []).find((o) => o.id === optionId);
    if (!opt) return;
    safely(() => App.store.group("Delete option", () => {
      mutateSchema(dbId, (s) => {
        const p = propById(s, propId);
        if (!p) return false;
        p.options = (p.options || []).filter((o) => o.id !== optionId);
      });
      for (const r of App.store.children(dbId)) {
        const v = (r.props || {})[propId];
        if (Array.isArray(v) ? v.includes(opt.name) : v === opt.name) {
          setValue(r.id, prop, Array.isArray(v) ? v.filter((x) => x !== opt.name) : null);
        }
      }
    }));
  }

  /* Add an option (a random colour, the way Notion does) and return it. */
  function addOption(dbId, propId, name) {
    name = String(name || "").trim();
    if (!name) return null;
    let out = null;
    mutateSchema(dbId, (s) => {
      const p = propById(s, propId);
      if (!p) return false;
      p.options = Array.isArray(p.options) ? p.options : [];
      const existing = p.options.find((o) => o.name === name);
      if (existing) { out = existing; return false; }
      out = { id: rid("o_"), name, color: randomColor() };
      p.options.push(out);
    });
    return out;
  }

  function createRow(dbId, { props = {}, title = "", after, before } = {}) {
    return safely(() => App.store.createPage({ parentId: dbId, title, props, after, before }));
  }

  const openRow = (id) => {
    if (App.nav && App.nav.openPage) App.nav.openPage(id);
  };

  // --- display --------------------------------------------------------------------
  function optionOf(prop, name) {
    return (prop.options || []).find((o) => o.name === name) || null;
  }

  /* A coloured pill for a select, multi-select or status value. */
  function pill(prop, name, { onRemove } = {}) {
    const opt = optionOf(prop, name);
    const color = opt && COLORS.includes(opt.color) ? opt.color : "default";
    const node = el("span", { class: `db-pill${prop.type === "status" ? " db-pill-status" : ""}`, style: `--pill: var(--tag-${color})`, title: name },
      el("span", { class: "db-pill-text", text: name }));
    if (onRemove) {
      node.append(el("button", {
        class: "db-pill-x", type: "button", "aria-label": `Remove ${name}`, html: icon("x", 12),
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => { e.stopPropagation(); onRemove(); },
      }));
    }
    return node;
  }

  function linkNode(type, v) {
    const href = hrefFor(type, v);
    return el("a", {
      class: "db-link", href, text: String(v), title: String(v),
      target: type === "url" ? "_blank" : null, rel: type === "url" ? "noopener noreferrer" : null,
      // A link opens; it never starts an edit of the cell it sits in.
      onclick: (e) => e.stopPropagation(),
      onmousedown: (e) => e.stopPropagation(),
    });
  }

  function fileChip(f) {
    const href = fileHref(f);
    const name = f.name || (f.url ? String(f.url).split("/").pop() : "") || "File";
    const chip = href
      ? el("a", { class: "db-file", href, target: "_blank", rel: "noopener noreferrer", title: name, onclick: (e) => e.stopPropagation(), onmousedown: (e) => e.stopPropagation() })
      : el("span", { class: "db-file", title: name });
    chip.append(el("span", { class: "db-file-icon", html: icon("db-paperclip", 12) }), el("span", { class: "db-file-name", text: name }));
    return chip;
  }

  function checkBox(on) {
    return el("span", { class: `db-check${on ? " on" : ""}`, role: "checkbox", "aria-checked": on ? "true" : "false", html: on ? icon("check", 12) : "" });
  }

  /* A value as display nodes: the same in a table cell, on a card and in the
     properties panel. Returns a DocumentFragment (possibly empty). */
  function renderValue(prop, v) {
    const frag = document.createDocumentFragment();
    if (prop.type === "checkbox") { frag.append(checkBox(asBool(v))); return frag; }
    if (isEmpty(prop, v)) return frag;
    switch (prop.type) {
      case "select": case "status":
        frag.append(pill(prop, asOne(v)));
        break;
      case "multi_select": {
        const wrap = el("span", { class: "db-pills" });
        asList(v).forEach((name) => wrap.append(pill(prop, name)));
        frag.append(wrap);
        break;
      }
      case "url": case "email": case "phone":
        frag.append(linkNode(prop.type, asOne(v)));
        break;
      case "number":
        frag.append(el("span", { class: "db-number", text: fmtNumber(prop, v) }));
        break;
      case "date":
        frag.append(el("span", { class: "db-date", text: fmtDate(v), title: fmtDate(v) }));
        break;
      case "files": {
        const wrap = el("span", { class: "db-files" });
        asFiles(v).forEach((f) => wrap.append(fileChip(f)));
        frag.append(wrap);
        break;
      }
      case "created_time": case "last_edited_time":
        frag.append(el("span", { class: "db-muted-value", text: fmtInstant(v) }));
        break;
      case "person": {
        const name = asOne(v);
        frag.append(el("span", { class: "db-person" },
          el("span", { class: "db-avatar", text: (name.trim()[0] || "?").toUpperCase() }),
          el("span", { class: "db-text", text: name })));
        break;
      }
      default:
        frag.append(el("span", { class: "db-text", text: asOne(v), title: asOne(v).length > 24 ? asOne(v) : null }));
    }
    return frag;
  }

  /* A row's icon: emoji, Tabler icon or image. `fallback` shows a quiet page glyph. */
  function rowIcon(row, { fallback = false } = {}) {
    const ref = row && row.icon ? App.files.ref(row.icon) : null;
    if (App.files.isGlyph(ref)) return el("span", { class: "db-row-icon" }, App.glyph(ref));
    if (ref && ref.kind === "url") return el("span", { class: "db-row-icon" }, el("img", { src: ref.url, alt: "", loading: "lazy" }));
    if (fallback) return el("span", { class: "db-row-icon db-row-icon-empty", html: icon("page", 16) });
    return null;
  }

  // --- popovers with panes ------------------------------------------------------------
  /* A popover whose content can switch to sub-panes and back (type picker,
     option editor, colours). One popover rather than stacked submenus, so a
     click in a sub-pane never counts as "outside" and closes its parent.
     Anchored to a snapshot of the anchor's rectangle: the anchor may be
     rebuilt by a store change while the popover is open. */
  function panes(anchor, first, { className = "", placement, onClose } = {}) {
    const box = el("div", { class: `db-pop ${className}` });
    const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    const stack = [];
    let handle = null;
    const api = {
      show(build) { stack.push(build); draw(); },
      back() { if (stack.length > 1) stack.pop(); draw(); },
      redraw() { draw(); },
      reposition() { if (handle && !handle.closed) handle.reposition(); },
      close() { if (handle) handle.close(); },
      get el() { return box; },
      get closed() { return handle ? handle.closed : false; },
    };
    function draw() {
      const node = stack[stack.length - 1](api);
      if (!node) return;
      box.replaceChildren(node);
      if (handle) handle.reposition();
      const auto = box.querySelector("[data-autofocus]");
      if (auto) setTimeout(() => { auto.focus(); if (auto.select && auto.dataset.autofocus === "select") auto.select(); }, 0);
    }
    stack.push(first);
    const node = first(api);
    box.append(node);
    handle = App.ui.popover(rect, box, { className: "db-popover", placement, onClose });
    const auto = box.querySelector("[data-autofocus]");
    if (auto) setTimeout(() => { auto.focus(); if (auto.select && auto.dataset.autofocus === "select") auto.select(); }, 0);
    return api;
  }

  /* One row of a menu-like list inside a pane. */
  function mi({ label, iconName, iconHtml, hint, danger, checked, chevron, disabled, onClick, className = "" }) {
    return el("button", {
      class: `menu-item db-mi${danger ? " danger" : ""} ${className}`, type: "button", disabled: disabled || null,
      onclick: (e) => { e.preventDefault(); if (!disabled && onClick) onClick(e); },
    },
    iconName || iconHtml ? el("span", { class: "menu-icon", html: iconHtml || icon(iconName) }) : null,
    el("span", { class: "menu-label", text: label }),
    hint ? el("span", { class: "menu-hint", text: hint }) : null,
    checked ? el("span", { class: "menu-check", html: icon("check", 14) }) : null,
    chevron ? el("span", { class: "menu-hint", html: icon("chevron-right", 14) }) : null);
  }

  function paneHead(api, title) {
    return el("div", { class: "db-pane-head" },
      el("button", { class: "icon-btn icon-btn-small", type: "button", "aria-label": "Back", html: icon("chevron-left", 16), onclick: () => api.back() }),
      el("span", { class: "db-pane-title", text: title }));
  }

  const divider = () => el("div", { class: "menu-divider" });

  // --- the edit host: rebuilds, deferred while something is being edited ------------
  /* Is a mouse button (or finger) down right now? A rebuild between mousedown
     and click would swap the element under the pointer and swallow the click
     (clicking from one cell into the next is exactly that), so rebuilds wait
     for the pointer to come up. */
  let pointerDown = false;
  window.addEventListener("pointerdown", () => { pointerDown = true; }, true);
  window.addEventListener("pointerup", () => { pointerDown = false; }, true);
  window.addEventListener("pointercancel", () => { pointerDown = false; }, true);
  window.addEventListener("dragend", () => { pointerDown = false; }, true);

  function whenPointerFree(fn) {
    if (!pointerDown) { fn(); return; }
    let fired = false;
    const done = () => {
      if (fired) return;
      fired = true;
      window.removeEventListener("pointerup", done, true);
      window.removeEventListener("pointercancel", done, true);
      clearTimeout(guard);
      setTimeout(fn, 20); // after the click that follows pointerup
    };
    // A release the page never hears about (outside the window, into an
    // iframe) must not hold rebuilds back for good.
    const guard = setTimeout(() => { pointerDown = false; done(); }, 1500);
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  }

  /* Both the database view and the properties panel are "hosts": they own a
     rebuild function, know whether editing is allowed, and hold at most one
     open cell editor. */
  function makeHost(dbId, roOpt, render) {
    return {
      dbId, roOpt, render, editing: null, dirty: false, scheduled: false, destroyed: false,
      readOnly() { return Boolean(this.roOpt) || App.store.isReadOnly(); },
      schema() { return schemaOf(App.store.page(this.dbId)); },
    };
  }

  function requestRender(host) {
    if (host.destroyed) return;
    if (host.editing) { host.dirty = true; return; }
    if (host.scheduled) return;
    host.scheduled = true;
    queueMicrotask(() => whenPointerFree(() => {
      host.scheduled = false;
      if (host.destroyed) return;
      if (host.editing) { host.dirty = true; return; }
      host.dirty = false;
      host.render();
    }));
  }

  function beginEdit(host, session) {
    if (host.editing && host.editing !== session) host.editing.finish(true);
    host.editing = session;
  }

  function endEdit(host, session) {
    if (host.editing !== session) return;
    host.editing = null;
    if (host.dirty) requestRender(host);
  }

  // --- cells ---------------------------------------------------------------------------
  /* Fill a cell (a table cell or a properties-panel value) with its value. */
  function fillCell(host, cell, row, prop) {
    cell.replaceChildren();
    if (!row) return;
    if (prop.type === "title") {
      const titleText = row.title || "";
      cell.append(el("span", { class: "db-title-cell" },
        rowIcon(row),
        el("span", { class: `db-title-text${titleText ? "" : " empty"}`, text: titleText || (host.readOnly() ? "Untitled" : "") })));
      cell.append(el("button", {
        class: "db-open", type: "button", title: "Open as a page",
        onclick: (e) => { e.stopPropagation(); openRow(row.id); },
        onmousedown: (e) => e.stopPropagation(),
      }, el("span", { html: icon("expand", 12) }), el("span", { class: "db-open-label", text: "Open" })));
      return;
    }
    cell.append(renderValue(prop, getValue(row, prop)));
    if (!cell.childNodes.length && cell.dataset.placeholder) {
      cell.append(el("span", { class: "db-placeholder", text: cell.dataset.placeholder }));
    }
  }

  const INPUT_TYPES = new Set(["title", "text", "url", "email", "phone", "person", "number"]);

  /* Start editing a cell. Checkboxes toggle at once; strings and numbers edit
     in place; options, dates and files open a popover next to the cell. */
  function startEdit(host, cell, rowId, propId) {
    if (host.readOnly()) return;
    const row = App.store.page(rowId);
    const prop = propById(host.schema(), propId);
    if (!row || !prop || COMPUTED.has(prop.type)) return;
    if (host.editing && host.editing.cell === cell) return;
    if (host.editing) host.editing.finish(true);
    if (prop.type === "checkbox") {
      safely(() => setValue(rowId, prop, !asBool(getValue(row, prop))));
      fillCell(host, cell, App.store.page(rowId), prop);
      return;
    }
    if (INPUT_TYPES.has(prop.type)) return inputEditor(host, cell, row, prop);
    if (SELECT_LIKE.has(prop.type)) return selectEditor(host, cell, row, prop);
    if (prop.type === "date") return dateEditor(host, cell, row, prop);
    if (prop.type === "files") return filesEditor(host, cell, row, prop);
    return undefined;
  }

  function inputEditor(host, cell, row, prop) {
    const isNum = prop.type === "number";
    const cur = getValue(row, prop);
    const input = el("input", {
      class: `db-cell-input${isNum ? " db-num-input" : ""}`, type: isNum ? "number" : "text", step: isNum ? "any" : null,
      inputmode: { email: "email", phone: "tel", url: "url" }[prop.type] || null,
      placeholder: prop.type === "title" ? "Untitled" : "", "aria-label": prop.name,
      spellcheck: prop.type === "title" || prop.type === "text" ? null : "false",
    });
    input.value = isNum ? (isEmpty(prop, cur) ? "" : String(Number(cur))) : asOne(cur);
    const session = { cell, rowId: row.id, propId: prop.id, finish: null };
    let done = false;
    session.finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        let val = input.value;
        if (isNum) val = val.trim() === "" || !Number.isFinite(Number(val)) ? null : Number(val);
        else if (prop.type !== "title") val = val.trim() === "" ? null : val.trim();
        safely(() => setValue(row.id, prop, val));
      }
      cell.classList.remove("editing");
      fillCell(host, cell, App.store.page(row.id) || row, prop);
      endEdit(host, session);
    };
    beginEdit(host, session);
    cell.classList.add("editing");
    cell.replaceChildren(input);
    input.focus();
    if (prop.type !== "title") input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") { e.preventDefault(); session.finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); session.finish(false); }
      else if (e.key === "Tab") {
        e.preventDefault();
        session.finish(true);
        const next = host.nextCell ? host.nextCell(cell, e.shiftKey) : null;
        if (next) startEdit(host, next, next.dataset.rowId, next.dataset.propId);
      }
    });
    input.addEventListener("blur", () => session.finish(true));
    return session;
  }

  /* Open a popover editor as the cell's edit session. `build(api, session)`
     makes the pane; the session ends when the popover closes. */
  function popoverEditor(host, cell, build, className) {
    const session = { cell, finish: null };
    let api = null;
    session.finish = () => { if (api) api.close(); };
    beginEdit(host, session);
    cell.classList.add("editing");
    api = panes(cell, (a) => build(a, session), {
      className,
      onClose: () => { cell.classList.remove("editing"); endEdit(host, session); },
    });
    return session;
  }

  function selectEditor(host, cell, row, prop0) {
    const multi = prop0.type === "multi_select";
    const prop = () => propById(host.schema(), prop0.id) || prop0;
    const values = () => {
      const r = App.store.page(row.id);
      const v = getValue(r, prop());
      return multi ? asList(v) : (asOne(v) ? [asOne(v)] : []);
    };
    const write = (vals) => {
      safely(() => setValue(row.id, prop(), multi ? vals : (vals[0] || null)));
      fillCell(host, cell, App.store.page(row.id), prop());
    };
    return popoverEditor(host, cell, (api) => {
      let filter = "";
      let active = 0;
      let items = [];
      const pills = el("div", { class: "db-sel-pills" });
      const input = el("input", { class: "db-sel-input", type: "text", placeholder: values().length ? "" : "Search for an option…", "data-autofocus": "1", "aria-label": `${prop().name} options` });
      const top = el("div", { class: "db-sel-top", onclick: () => input.focus() }, pills, input);
      const list = el("div", { class: "db-sel-list" });
      const drawPills = () => {
        pills.replaceChildren(...values().map((name) => pill(prop(), name, {
          onRemove: () => { write(values().filter((x) => x !== name)); drawPills(); drawList(); input.focus(); },
        })));
        input.placeholder = values().length ? "" : "Search for an option…";
      };
      const pick = (name) => {
        const cur = values();
        if (multi) {
          write(cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]);
          filter = "";
          input.value = "";
          drawPills();
          drawList();
          input.focus();
        } else {
          write([name]);
          api.close();
        }
      };
      const drawList = () => {
        const f = filter.trim().toLowerCase();
        const opts = (prop().options || []).filter((o) => !f || o.name.toLowerCase().includes(f));
        const selected = new Set(values());
        items = [];
        list.replaceChildren(el("div", { class: "db-sel-hint", text: (prop().options || []).length ? "Select an option or create one" : "Type a name to create an option" }));
        for (const o of opts) {
          const rowEl = el("div", {
            class: "db-sel-item", role: "option", "aria-selected": selected.has(o.name) ? "true" : "false",
            onmousedown: (e) => e.preventDefault(),
            onclick: () => pick(o.name),
          },
          el("span", { class: "db-sel-pill" }, pill(prop(), o.name)),
          selected.has(o.name) ? el("span", { class: "db-sel-check", html: icon("check", 14) }) : null,
          el("button", {
            class: "icon-btn icon-btn-small db-sel-more", type: "button", title: "Edit option", html: icon("dots", 14),
            onmousedown: (e) => e.preventDefault(),
            onclick: (e) => { e.stopPropagation(); api.show((a) => optionPane(host, a, prop0.id, o.id)); },
          }));
          items.push({ node: rowEl, run: () => pick(o.name) });
          list.append(rowEl);
        }
        const typed = filter.trim();
        if (typed && !(prop().options || []).some((o) => o.name === typed)) {
          const createEl = el("div", {
            class: "db-sel-item db-sel-create", onmousedown: (e) => e.preventDefault(),
            onclick: () => create(typed),
          }, el("span", { class: "db-sel-create-label", text: "Create" }), pill({ type: prop0.type, options: [] }, typed));
          items.push({ node: createEl, run: () => create(typed) });
          list.append(createEl);
        }
        active = Math.min(active, Math.max(0, items.length - 1));
        items.forEach((it, i) => it.node.classList.toggle("active", i === active));
      };
      const create = (name) => {
        if (!addOption(host.dbId, prop0.id, name)) return;
        pick(name);
      };
      input.addEventListener("input", () => { filter = input.value; active = 0; drawList(); });
      input.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); drawActive(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); drawActive(); }
        else if (e.key === "Enter") {
          e.preventDefault();
          const typed = filter.trim();
          const exact = (prop().options || []).find((o) => o.name.toLowerCase() === typed.toLowerCase());
          if (typed && exact) pick(exact.name);
          else if (typed && !exact) create(typed);
          else if (items[active]) items[active].run();
          else api.close();
        } else if (e.key === "Backspace" && !input.value && multi && values().length) {
          write(values().slice(0, -1));
          drawPills();
          drawList();
        }
      });
      const drawActive = () => {
        items.forEach((it, i) => it.node.classList.toggle("active", i === active));
        if (items[active]) items[active].node.scrollIntoView({ block: "nearest" });
      };
      drawPills();
      drawList();
      return el("div", { class: "db-sel" }, top, list);
    }, "db-sel-pop");
  }

  /* Edit one option: rename, recolour, delete. Used from the cell editor and
     from the property menu's option list. */
  function optionPane(host, api, propId, optionId) {
    const prop = propById(host.schema(), propId);
    const opt = prop && (prop.options || []).find((o) => o.id === optionId);
    if (!opt) { setTimeout(() => api.back(), 0); return el("div"); }
    const input = el("input", { class: "input input-small", type: "text", value: opt.name, "data-autofocus": "select", "aria-label": "Option name" });
    const commit = () => { if (input.value.trim() && input.value.trim() !== opt.name) renameOption(host.dbId, propId, optionId, input.value); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); api.back(); } });
    input.addEventListener("blur", commit);
    const list = el("div", { class: "menu" });
    list.append(mi({
      label: "Delete option", iconName: "trash", danger: true,
      onClick: () => { deleteOption(host.dbId, propId, optionId); api.back(); },
    }));
    list.append(divider(), el("div", { class: "menu-heading", text: "Colour" }));
    for (const c of COLORS) {
      list.append(mi({
        label: COLOR_LABEL(c), checked: (opt.color || "default") === c,
        iconHtml: `<span class="db-swatch" style="--pill: var(--tag-${c})"></span>`,
        onClick: () => {
          commit();
          mutateSchema(host.dbId, (s) => {
            const p = propById(s, propId);
            const o = p && (p.options || []).find((x) => x.id === optionId);
            if (!o) return false;
            o.color = c;
          });
          api.back();
        },
      }));
    }
    return el("div", { class: "db-pane" }, paneHead(api, "Edit option"), el("div", { class: "db-pane-field" }, input), list);
  }

  function dateEditor(host, cell, row, prop) {
    return popoverEditor(host, cell, (api) => {
      const cur = dateParts(getValue(App.store.page(row.id), prop));
      let hasTime = /T\d{2}:\d{2}/.test(cur.start);
      let hasEnd = Boolean(cur.end);
      const type = () => (hasTime ? "datetime-local" : "date");
      const start = el("input", { class: "input input-small", type: type(), "aria-label": "Date", "data-autofocus": "1" });
      const end = el("input", { class: "input input-small", type: type(), "aria-label": "End date" });
      start.value = cur.start.slice(0, hasTime ? 16 : 10);
      end.value = cur.end.slice(0, hasTime ? 16 : 10);
      const write = () => {
        let s = start.value;
        let e = hasEnd ? end.value : "";
        if (!s && e) { s = e; e = ""; }
        const value = !s ? null : e ? { start: s, end: e } : s;
        safely(() => setValue(row.id, prop, value));
        fillCell(host, cell, App.store.page(row.id), prop);
      };
      start.addEventListener("change", write);
      end.addEventListener("change", write);
      [start, end].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); write(); api.close(); } }));
      const now = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
      const convert = (v) => (!v ? v : hasTime ? (v.length > 10 ? v : `${v}T${now()}`) : v.slice(0, 10));
      const toggle = (label, on, onChange) => {
        const box = el("input", { type: "checkbox", checked: on || null });
        box.addEventListener("change", () => onChange(box.checked));
        return el("label", { class: "setting-row db-date-toggle" },
          el("span", { class: "setting-text", text: label }),
          el("span", { class: "switch" }, box, el("span", { class: "switch-track" })));
      };
      const endRow = el("div", { class: "db-date-row", hidden: hasEnd ? null : true }, el("span", { class: "db-date-arrow", text: "→" }), end);
      const body = el("div", { class: "db-date-pop" },
        el("div", { class: "db-date-row" }, start),
        endRow,
        toggle("End date", hasEnd, (on) => {
          hasEnd = on;
          endRow.hidden = !on;
          if (on && !end.value) end.value = start.value;
          write();
        }),
        toggle("Include time", hasTime, (on) => {
          hasTime = on;
          const [a, b] = [convert(start.value), convert(end.value)];
          start.type = type();
          end.type = type();
          start.value = a || "";
          end.value = b || "";
          write();
        }),
        el("div", { class: "db-date-foot" },
          el("button", { class: "link-btn", type: "button", text: "Clear", onclick: () => { start.value = ""; end.value = ""; write(); api.close(); } }),
          el("button", { class: "btn btn-small", type: "button", text: "Done", onclick: () => { write(); api.close(); } })));
      return body;
    }, "db-date-popover");
  }

  function filesEditor(host, cell, row, prop) {
    return popoverEditor(host, cell, (api) => {
      const list = el("div", { class: "db-files-list" });
      const current = () => asFiles(getValue(App.store.page(row.id), prop));
      const write = (files) => {
        safely(() => setValue(row.id, prop, files));
        fillCell(host, cell, App.store.page(row.id), prop);
        draw();
      };
      let uploading = 0;
      const draw = () => {
        const files = current();
        list.replaceChildren();
        if (!files.length && !uploading) list.append(el("div", { class: "db-files-empty", text: "No files yet" }));
        files.forEach((f, i) => list.append(el("div", { class: "db-files-item" },
          fileChip(f),
          el("button", {
            class: "icon-btn icon-btn-small", type: "button", title: "Remove", html: icon("x", 14),
            onclick: () => write(current().filter((_, n) => n !== i)),
          }))));
        if (uploading) list.append(el("div", { class: "db-files-item db-files-busy" }, el("span", { class: "spinner spinner-small" }), el("span", { text: `Uploading ${uploading}…` })));
        api.reposition();
      };
      const fileInput = el("input", { type: "file", multiple: true, hidden: true });
      fileInput.addEventListener("change", async () => {
        const chosen = [...fileInput.files];
        fileInput.value = "";
        for (const file of chosen) {
          uploading += 1;
          draw();
          try {
            const res = await App.files.upload(file, { pageId: row.id });
            uploading -= 1;
            write([...current(), { file_id: res.id, name: res.filename || file.name }]);
          } catch (e) {
            uploading -= 1;
            draw();
            App.toast(e.message || "Upload failed", { kind: "error" });
          }
        }
      });
      const link = el("input", { class: "input input-small", type: "url", placeholder: "Paste a link and press Enter", "aria-label": "Add a link" });
      link.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        let url = link.value.trim();
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        let name = url;
        try { name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || new URL(url).hostname); } catch (err) { /* keep the URL */ }
        link.value = "";
        write([...current(), { url, name }]);
      });
      draw();
      return el("div", { class: "db-files-pop" }, list,
        el("div", { class: "db-files-actions" },
          el("button", { class: "btn btn-small", type: "button", onclick: () => fileInput.click() },
            el("span", { html: icon("upload", 14) }), el("span", { text: "Upload" })),
          link, fileInput));
    }, "db-files-popover");
  }

  // --- small form helpers ----------------------------------------------------------------
  function selectEl(options, value, onChange, attrs = {}) {
    const s = el("select", { class: "select db-select", ...attrs });
    for (const o of options) {
      const opt = el("option", { value: o.value, text: o.label });
      if (String(o.value) === String(value)) opt.selected = true;
      s.append(opt);
    }
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  /* Drag to reorder the [data-index] children of a list (options, properties).
     Calls onMove(from, to) with `to` counted in the list before removal. */
  function makeSortable(container, onMove) {
    let from = -1;
    const clear = () => container.querySelectorAll(".db-drop-before, .db-drop-after, .dragging")
      .forEach((n) => n.classList.remove("db-drop-before", "db-drop-after", "dragging"));
    container.addEventListener("dragstart", (e) => {
      const item = e.target.closest && e.target.closest("[data-index]");
      if (!item || !container.contains(item)) return;
      from = Number(item.dataset.index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(from));
      item.classList.add("dragging");
      e.stopPropagation();
    });
    container.addEventListener("dragover", (e) => {
      if (from < 0) return;
      const item = e.target.closest && e.target.closest("[data-index]");
      if (!item || !container.contains(item)) return;
      e.preventDefault();
      e.stopPropagation();
      container.querySelectorAll(".db-drop-before, .db-drop-after").forEach((n) => n.classList.remove("db-drop-before", "db-drop-after"));
      const r = item.getBoundingClientRect();
      item.classList.add(e.clientY > r.top + r.height / 2 ? "db-drop-after" : "db-drop-before");
    });
    container.addEventListener("drop", (e) => {
      if (from < 0) return;
      const item = container.querySelector(".db-drop-before, .db-drop-after");
      e.preventDefault();
      e.stopPropagation();
      if (item) {
        let to = Number(item.dataset.index) + (item.classList.contains("db-drop-after") ? 1 : 0);
        if (to > from) to -= 1;
        if (to !== from) onMove(from, to);
      }
      clear();
      from = -1;
    });
    container.addEventListener("dragend", () => { clear(); from = -1; });
  }

  const moveItem = (list, from, to) => { const out = list.slice(); const [x] = out.splice(from, 1); out.splice(to, 0, x); return out; };

  // --- the property menu (table header, panel key) ----------------------------------------------
  /* opts: { view, focusName, onFilter } */
  function propertyMenu(host, anchor, propId, opts = {}) {
    if (host.readOnly()) return null;
    let commitName = () => {};
    const main = (api) => {
      const s = host.schema();
      const prop = propById(s, propId);
      if (!prop) { setTimeout(() => api.close(), 0); return el("div"); }
      const view = opts.view ? s.views.find((v) => v.id === opts.view) : null;
      const input = el("input", { class: "input input-small", type: "text", value: prop.name, "aria-label": "Property name", "data-autofocus": opts.focusName ? "select" : null, placeholder: "Property name" });
      commitName = () => {
        const n = input.value.trim();
        const p = propById(host.schema(), propId);
        if (n && p && n !== p.name) mutateSchema(host.dbId, (x) => { const q = propById(x, propId); if (!q) return false; q.name = n; });
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commitName(); api.close(); } });
      input.addEventListener("blur", () => commitName());
      const go = (pane) => { commitName(); api.show(pane); };
      const list = el("div", { class: "menu" });
      if (prop.id !== "title") {
        list.append(mi({ label: "Type", iconName: typeIcon(prop.type), hint: typeLabel(prop.type), chevron: true, onClick: () => go((a) => typePane(host, a, propId)) }));
      }
      if (SELECT_LIKE.has(prop.type)) list.append(mi({ label: "Edit options", iconName: "palette", chevron: true, onClick: () => go((a) => optionsPane(host, a, propId)) }));
      if (prop.type === "number") {
        const fmt = NUMBER_FORMATS.find((f) => f.id === (prop.number_format || "number")) || NUMBER_FORMATS[0];
        list.append(mi({ label: "Number format", iconName: "hash", hint: fmt.label, chevron: true, onClick: () => go((a) => formatPane(host, a, propId)) }));
      }
      if (view) {
        if (list.childNodes.length) list.append(divider());
        const sortBy = (direction) => {
          commitName();
          mutateView(host.dbId, view.id, (v) => { v.sort = [{ property: propId, direction }]; });
          api.close();
        };
        list.append(
          mi({ label: "Sort ascending", iconName: "db-arrow-up", onClick: () => sortBy("asc") }),
          mi({ label: "Sort descending", iconName: "db-arrow-down", onClick: () => sortBy("desc") }),
          mi({
            label: "Filter", iconName: "filter",
            onClick: () => {
              commitName();
              mutateView(host.dbId, view.id, (v) => { v.filter = [...(Array.isArray(v.filter) ? v.filter : []), { property: propId, op: opsFor(prop.type)[0], value: "" }]; });
              api.close();
              if (opts.onFilter) setTimeout(opts.onFilter, 0);
            },
          }));
        if (!(view.type === "table" && prop.id === "title")) {
          list.append(mi({
            label: "Hide in view", iconName: "eye-off",
            onClick: () => {
              commitName();
              mutateView(host.dbId, view.id, (v) => { v.hidden = [...new Set([...(Array.isArray(v.hidden) ? v.hidden : []), propId])]; });
              api.close();
            },
          }));
        }
      }
      if (prop.id !== "title") {
        list.append(divider(), mi({
          label: "Delete property", iconName: "trash", danger: true,
          onClick: async () => {
            commitName();
            api.close();
            const ok = await App.ui.confirm(`Delete the property "${prop.name}"? Its values disappear from every row.`, { title: "Delete property", confirmLabel: "Delete", danger: true });
            if (ok) deleteProperty(host.dbId, propId);
          },
        }));
      }
      return el("div", { class: "db-pane" }, el("div", { class: "db-pane-field" }, input), list);
    };
    return panes(anchor, main, { className: "db-prop-pop", onClose: () => commitName() });
  }

  function typePane(host, api, propId) {
    const prop = propById(host.schema(), propId);
    const list = el("div", { class: "menu db-scroll-menu" });
    for (const t of PROPERTY_TYPES) {
      list.append(mi({
        label: t.label, iconName: t.icon, checked: prop && prop.type === t.type,
        onClick: () => { changeType(host.dbId, propId, t.type); api.close(); },
      }));
    }
    return el("div", { class: "db-pane" }, paneHead(api, "Type"), list);
  }

  function formatPane(host, api, propId) {
    const prop = propById(host.schema(), propId);
    const list = el("div", { class: "menu" });
    for (const f of NUMBER_FORMATS) {
      list.append(mi({
        label: f.label, checked: prop && (prop.number_format || "number") === f.id,
        onClick: () => {
          mutateSchema(host.dbId, (s) => { const p = propById(s, propId); if (!p) return false; if (f.id === "number") delete p.number_format; else p.number_format = f.id; });
          api.back();
        },
      }));
    }
    return el("div", { class: "db-pane" }, paneHead(api, "Number format"), list);
  }

  function optionsPane(host, api, propId) {
    const prop = propById(host.schema(), propId);
    if (!prop) { setTimeout(() => api.close(), 0); return el("div"); }
    const list = el("div", { class: "db-opt-list" });
    (prop.options || []).forEach((o, i) => {
      list.append(el("div", { class: "db-opt-row", draggable: "true", dataset: { index: String(i) } },
        el("span", { class: "db-grip", html: icon("drag", 14), title: "Drag to reorder" }),
        el("button", { class: "db-opt-main", type: "button", onclick: () => api.show((a) => optionPane(host, a, propId, o.id)) }, pill(prop, o.name)),
        el("button", { class: "icon-btn icon-btn-small", type: "button", title: "Edit option", html: icon("chevron-right", 14), onclick: () => api.show((a) => optionPane(host, a, propId, o.id)) })));
    });
    if (!(prop.options || []).length) list.append(el("div", { class: "db-pane-empty", text: "No options yet" }));
    makeSortable(list, (from, to) => {
      mutateSchema(host.dbId, (s) => { const p = propById(s, propId); if (!p) return false; p.options = moveItem(p.options || [], from, to); });
      api.redraw();
    });
    const add = el("input", { class: "input input-small", type: "text", placeholder: "Add an option…", "aria-label": "New option name", "data-autofocus": "1" });
    add.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const name = add.value.trim();
      if (!name) return;
      if ((propById(host.schema(), propId).options || []).some((o) => o.name === name)) {
        App.toast(`There is already an option called "${name}"`, { kind: "warning" });
        return;
      }
      addOption(host.dbId, propId, name);
      api.redraw();
    });
    return el("div", { class: "db-pane" }, paneHead(api, "Options"), list, el("div", { class: "db-pane-field" }, add));
  }

  /* Pick a type, then create the property and hand it to onCreated. */
  function addPropertyMenu(host, anchor, onCreated) {
    App.ui.menu(anchor, PROPERTY_TYPES.map((t) => ({
      label: t.label, icon: t.icon,
      onSelect: () => { const p = addProperty(host.dbId, t.type); if (p && onCreated) onCreated(p); },
    })), { filter: true, placeholder: "Search for a property type…", className: "db-type-menu" });
  }

  // --- views ---------------------------------------------------------------------------------
  function createView(host, type) {
    let id = null;
    mutateSchema(host.dbId, (s) => {
      const label = VIEW_TYPES.find((t) => t.type === type).label;
      const v = { id: rid("v_"), name: uniqueName(s.views, label), type };
      if (type === "board") {
        const g = s.properties.find((p) => p.type === "status") || s.properties.find((p) => p.type === "select");
        if (g) v.group_by = g.id;
      }
      if (type === "gantt") ganttDefaults(v, s);
      s.views.push(v);
      id = v.id;
    });
    return id;
  }

  function viewMenu(host, anchor, viewId) {
    if (host.readOnly()) return null;
    let commitName = () => {};
    const main = (api) => {
      const s = host.schema();
      const view = s.views.find((v) => v.id === viewId);
      if (!view) { setTimeout(() => api.close(), 0); return el("div"); }
      const input = el("input", { class: "input input-small", type: "text", value: view.name, "aria-label": "View name", "data-autofocus": "select" });
      commitName = () => {
        const n = input.value.trim();
        const cur = host.schema().views.find((v) => v.id === viewId);
        if (n && cur && n !== cur.name) mutateView(host.dbId, viewId, (v) => { v.name = n; });
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commitName(); api.close(); } });
      input.addEventListener("blur", () => commitName());
      const list = el("div", { class: "menu" });
      list.append(mi({
        label: "Layout", iconName: viewIcon(view.type), hint: VIEW_TYPES.find((t) => t.type === view.type).label, chevron: true,
        onClick: () => { commitName(); api.show((a) => layoutPane(host, a, viewId)); },
      }));
      list.append(mi({
        label: "Duplicate view", iconName: "copy",
        onClick: () => {
          commitName();
          let id = null;
          mutateSchema(host.dbId, (x) => {
            const i = x.views.findIndex((v) => v.id === viewId);
            if (i < 0) return false;
            const copy = { ...structuredClone(x.views[i]), id: rid("v_") };
            copy.name = uniqueName(x.views, `${x.views[i].name} copy`);
            x.views.splice(i + 1, 0, copy);
            id = copy.id;
          });
          api.close();
          if (id && host.setView) host.setView(id);
        },
      }));
      list.append(mi({
        label: "Delete view", iconName: "trash", danger: true, disabled: s.views.length <= 1,
        onClick: async () => {
          api.close();
          const ok = await App.ui.confirm(`Delete the view "${view.name}"? The rows stay; only this way of looking at them goes.`, { title: "Delete view", confirmLabel: "Delete", danger: true });
          if (ok) mutateSchema(host.dbId, (x) => { if (x.views.length <= 1) return false; x.views = x.views.filter((v) => v.id !== viewId); });
        },
      }));
      return el("div", { class: "db-pane" }, el("div", { class: "db-pane-field" }, input), list);
    };
    return panes(anchor, main, { className: "db-prop-pop", onClose: () => commitName() });
  }

  function layoutPane(host, api, viewId) {
    const view = host.schema().views.find((v) => v.id === viewId);
    const list = el("div", { class: "menu" });
    for (const t of VIEW_TYPES) {
      list.append(mi({
        label: t.label, iconName: t.icon, checked: view && view.type === t.type,
        onClick: () => {
          mutateView(host.dbId, viewId, (v, s) => {
            v.type = t.type;
            if (t.type === "board" && !propById(s, v.group_by)) {
              const g = s.properties.find((p) => p.type === "status") || s.properties.find((p) => p.type === "select");
              if (g) v.group_by = g.id;
            }
            if (t.type === "gantt") ganttDefaults(v, s);
          });
          api.close();
        },
      }));
    }
    return el("div", { class: "db-pane" }, paneHead(api, "Layout"), list);
  }

  // --- toolbar popovers --------------------------------------------------------------------------
  function filterPopover(host, anchor, viewId) {
    return panes(anchor, (api) => {
      const s = host.schema();
      const view = s.views.find((v) => v.id === viewId);
      if (!view) { setTimeout(() => api.close(), 0); return el("div"); }
      const filters = Array.isArray(view.filter) ? view.filter : [];
      const change = (i, fn, redraw = true) => {
        mutateView(host.dbId, viewId, (v) => { const f = (v.filter || [])[i]; if (!f) return false; fn(f); });
        if (redraw) api.redraw();
      };
      const rows = el("div", { class: "db-rules" });
      filters.forEach((f, i) => {
        const prop = propById(s, f.property);
        const ops = prop ? opsFor(prop.type) : ["contains"];
        const propSel = selectEl(
          [...(prop ? [] : [{ value: f.property, label: "(deleted property)" }]), ...s.properties.map((p) => ({ value: p.id, label: p.name || typeLabel(p.type) }))],
          f.property,
          (id) => change(i, (x) => { const p = propById(host.schema(), id); x.property = id; x.op = opsFor(p ? p.type : "text")[0]; x.value = ""; }),
          { "aria-label": "Property" });
        const opSel = selectEl(ops.map((o) => ({ value: o, label: OP_LABEL[o] })), ops.includes(f.op) ? f.op : ops[0],
          (op) => change(i, (x) => { x.op = op; if (NO_VALUE_OPS.has(op)) x.value = ""; }), { "aria-label": "Condition" });
        let valueEl = el("span", { class: "db-rule-spacer" });
        if (prop && !NO_VALUE_OPS.has(f.op)) {
          if (SELECT_LIKE.has(prop.type)) {
            valueEl = selectEl([{ value: "", label: "Choose…" }, ...(prop.options || []).map((o) => ({ value: o.name, label: o.name }))],
              f.value || "", (val) => change(i, (x) => { x.value = val; }, false), { "aria-label": "Value" });
          } else {
            const t = prop.type === "number" ? "number" : (prop.type === "date" || COMPUTED.has(prop.type)) ? "date" : "text";
            valueEl = el("input", { class: "input input-small db-rule-value", type: t, placeholder: "Value", "aria-label": "Value" });
            valueEl.value = f.value === undefined || f.value === null ? "" : String(f.value);
            let timer = null;
            const push = () => {
              clearTimeout(timer);
              const raw = valueEl.value;
              const val = t === "number" ? (raw.trim() === "" ? "" : Number(raw)) : raw;
              change(i, (x) => { x.value = val; }, false);
            };
            valueEl.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(push, 300); });
            valueEl.addEventListener("change", push);
            valueEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); push(); } });
          }
        }
        rows.append(el("div", { class: "db-rule" },
          el("span", { class: "db-rule-lead", text: i === 0 ? "Where" : "And" }),
          propSel, opSel, valueEl,
          el("button", {
            class: "icon-btn icon-btn-small db-rule-x", type: "button", title: "Remove filter", html: icon("x", 14),
            onclick: () => { mutateView(host.dbId, viewId, (v) => { v.filter = (v.filter || []).filter((_, n) => n !== i); }); api.redraw(); },
          })));
      });
      if (!filters.length) rows.append(el("div", { class: "db-pane-empty", text: "No filters yet. A filter shows only the rows that match it." }));
      const addBtn = el("button", {
        class: "link-btn db-rule-add", type: "button",
        onclick: () => {
          const p = s.properties[0];
          mutateView(host.dbId, viewId, (v) => { v.filter = [...(Array.isArray(v.filter) ? v.filter : []), { property: p.id, op: opsFor(p.type)[0], value: "" }]; });
          api.redraw();
        },
      }, el("span", { html: icon("plus", 14) }), el("span", { text: "Add a filter" }));
      return el("div", { class: "db-pane db-rules-pane" }, rows, addBtn);
    }, { className: "db-rules-pop", placement: "bottom-end" });
  }

  function sortPopover(host, anchor, viewId) {
    return panes(anchor, (api) => {
      const s = host.schema();
      const view = s.views.find((v) => v.id === viewId);
      if (!view) { setTimeout(() => api.close(), 0); return el("div"); }
      const sorts = Array.isArray(view.sort) ? view.sort : [];
      const rows = el("div", { class: "db-rules" });
      sorts.forEach((srt, i) => {
        rows.append(el("div", { class: "db-rule" },
          selectEl(s.properties.map((p) => ({ value: p.id, label: p.name || typeLabel(p.type) })), srt.property,
            (id) => { mutateView(host.dbId, viewId, (v) => { v.sort[i].property = id; }); api.redraw(); }, { "aria-label": "Sort by" }),
          selectEl([{ value: "asc", label: "Ascending" }, { value: "desc", label: "Descending" }], srt.direction === "desc" ? "desc" : "asc",
            (d) => { mutateView(host.dbId, viewId, (v) => { v.sort[i].direction = d; }); api.redraw(); }, { "aria-label": "Direction" }),
          el("button", {
            class: "icon-btn icon-btn-small db-rule-x", type: "button", title: "Remove sort", html: icon("x", 14),
            onclick: () => { mutateView(host.dbId, viewId, (v) => { v.sort = (v.sort || []).filter((_, n) => n !== i); }); api.redraw(); },
          })));
      });
      if (!sorts.length) rows.append(el("div", { class: "db-pane-empty", text: "No sorts yet. Rows are in the order you arranged them." }));
      const used = new Set(sorts.map((x) => x.property));
      const next = s.properties.find((p) => !used.has(p.id));
      const addBtn = el("button", {
        class: "link-btn db-rule-add", type: "button", disabled: next ? null : true,
        onclick: () => {
          if (!next) return;
          mutateView(host.dbId, viewId, (v) => { v.sort = [...(Array.isArray(v.sort) ? v.sort : []), { property: next.id, direction: "asc" }]; });
          api.redraw();
        },
      }, el("span", { html: icon("plus", 14) }), el("span", { text: "Add a sort" }));
      return el("div", { class: "db-pane db-rules-pane" }, rows, addBtn);
    }, { className: "db-rules-pop db-sort-pop", placement: "bottom-end" });
  }

  function propertiesPopover(host, anchor, viewId) {
    return panes(anchor, (api) => {
      const s = host.schema();
      const view = s.views.find((v) => v.id === viewId);
      if (!view) { setTimeout(() => api.close(), 0); return el("div"); }
      const props = orderedProps(s, view);
      const locked = (p) => p.id === "title";
      const list = el("div", { class: "db-opt-list" });
      props.forEach((p, i) => {
        const hidden = !locked(p) && isHidden(view, p.id);
        list.append(el("div", { class: `db-opt-row db-vis-row${hidden ? " is-hidden" : ""}`, draggable: "true", dataset: { index: String(i) } },
          el("span", { class: "db-grip", html: icon("drag", 14), title: "Drag to reorder" }),
          el("span", { class: "db-vis-icon", html: icon(typeIcon(p.type), 15) }),
          el("span", { class: "db-vis-name", text: p.name || typeLabel(p.type) }),
          el("button", {
            class: `icon-btn icon-btn-small db-vis-eye${hidden ? "" : " on"}`, type: "button", disabled: locked(p) ? true : null,
            title: locked(p) ? "The title is always shown" : hidden ? "Show" : "Hide", html: icon(hidden ? "eye-off" : "eye", 15),
            onclick: () => {
              mutateView(host.dbId, viewId, (v) => {
                const h = new Set(Array.isArray(v.hidden) ? v.hidden : []);
                if (h.has(p.id)) h.delete(p.id); else h.add(p.id);
                v.hidden = [...h];
              });
              api.redraw();
            },
          })));
      });
      makeSortable(list, (from, to) => {
        mutateView(host.dbId, viewId, (v, x) => { v.order = moveItem(orderedProps(x, v).map((p) => p.id), from, to); });
        api.redraw();
      });
      const anyHidden = props.some((p) => !locked(p) && isHidden(view, p.id));
      const head = el("div", { class: "db-pane-head db-pane-head-plain" },
        el("span", { class: "db-pane-title", text: "Properties" }),
        el("button", {
          class: "link-btn", type: "button", text: anyHidden ? "Show all" : "Hide all",
          onclick: () => {
            mutateView(host.dbId, viewId, (v, x) => { v.hidden = anyHidden ? [] : x.properties.filter((p) => !locked(p)).map((p) => p.id); });
            api.redraw();
          },
        }));
      const add = el("button", {
        class: "link-btn db-rule-add", type: "button",
        onclick: (e) => { api.close(); addPropertyMenu(host, e.currentTarget.isConnected ? e.currentTarget : anchor, () => {}); },
      }, el("span", { html: icon("plus", 14) }), el("span", { text: "New property" }));
      return el("div", { class: "db-pane" }, head, list, add);
    }, { className: "db-props-pop", placement: "bottom-end" });
  }

  function groupPopover(host, anchor, viewId) {
    return panes(anchor, (api) => {
      const s = host.schema();
      const view = s.views.find((v) => v.id === viewId);
      if (!view) { setTimeout(() => api.close(), 0); return el("div"); }
      const candidates = s.properties.filter((p) => p.type === "select" || p.type === "status");
      const list = el("div", { class: "menu" });
      for (const p of candidates) {
        list.append(mi({
          label: p.name, iconName: typeIcon(p.type), checked: view.group_by === p.id,
          onClick: () => { mutateView(host.dbId, viewId, (v) => { v.group_by = p.id; }); api.close(); },
        }));
      }
      if (!candidates.length) list.append(el("div", { class: "db-pane-empty", text: "A board groups rows by a Select or Status property. This database has none yet." }));
      list.append(divider(), mi({ label: "New Status property", iconName: "plus", onClick: () => { groupByNewStatus(host, viewId); api.close(); } }));
      return el("div", { class: "db-pane" }, el("div", { class: "db-pane-head db-pane-head-plain" }, el("span", { class: "db-pane-title", text: "Group by" })), list);
    }, { className: "db-prop-pop", placement: "bottom-end" });
  }

  /* Create a Status property (Not started, In progress, Done) and group the
     board by it: one schema write, so one undo step. */
  function groupByNewStatus(host, viewId) {
    mutateSchema(host.dbId, (s) => {
      const p = {
        id: rid("p_"), name: uniqueName(s.properties, "Status"), type: "status",
        options: [
          { id: rid("o_"), name: "Not started", color: "gray" },
          { id: rid("o_"), name: "In progress", color: "blue" },
          { id: rid("o_"), name: "Done", color: "green" },
        ],
      };
      s.properties.push(p);
      const v = s.views.find((x) => x.id === viewId);
      if (v) v.group_by = p.id;
    });
  }

  /* A Gantt view's settings: which date property draws the bars, where their
     end comes from, and what colours them. */
  function ganttSettings(host, anchor, viewId) {
    return panes(anchor, (api) => {
      const s = host.schema();
      const view = s.views.find((v) => v.id === viewId);
      if (!view) { setTimeout(() => api.close(), 0); return el("div"); }
      const cfg = ganttConfig(s, view);
      const set = (fn) => { mutateView(host.dbId, viewId, fn); api.redraw(); };
      const rows = el("div", { class: "db-rules db-gt-set" });
      const line = (label, control) => rows.append(el("div", { class: "db-rule" }, el("span", { class: "db-gt-set-label", text: label }), control));
      const opt = (p) => ({ value: p.id, label: p.name || typeLabel(p.type) });
      if (cfg.start) {
        line("Start", selectEl(cfg.dates.map(opt), cfg.start.id,
          (id) => set((v) => { v.date_property = id; if (v.end_property === id) delete v.end_property; }), { "aria-label": "Dates" }));
        line("End", selectEl([{ value: "", label: `End of ${cfg.start.name || "the date"}` }, ...cfg.dates.filter((p) => p.id !== cfg.start.id).map(opt)],
          cfg.end ? cfg.end.id : "", (id) => set((v) => { if (id) v.end_property = id; else delete v.end_property; }), { "aria-label": "End date" }));
      }
      const colourable = s.properties.filter((p) => p.type === "select" || p.type === "status");
      line("Colour", selectEl([{ value: "", label: "None" }, ...colourable.map(opt)], cfg.color ? cfg.color.id : "",
        (id) => set((v) => { v.color_by = id || null; }), { "aria-label": "Colour by" }));
      const hint = cfg.end
        ? `Bars run from ${cfg.start.name} to ${cfg.end.name}. A row without an end is a milestone.`
        : "A date with an end is a bar; a single date is a milestone.";
      return el("div", { class: "db-pane" },
        el("div", { class: "db-pane-head db-pane-head-plain" }, el("span", { class: "db-pane-title", text: "Timeline" })),
        rows, el("div", { class: "db-pane-empty db-gt-set-hint", text: hint }));
    }, { className: "db-rules-pop db-sort-pop", placement: "bottom-end" });
  }

  // --- row menu ------------------------------------------------------------------------------
  function rowMenu(host, anchor, rowId) {
    if (host.readOnly()) return;
    App.ui.menu(anchor, [
      { label: "Open", icon: "expand", onSelect: () => openRow(rowId) },
      { label: "Duplicate", icon: "copy", onSelect: () => safely(() => App.store.duplicatePage(rowId)) },
      { divider: true },
      {
        label: "Delete", icon: "trash", danger: true,
        onSelect: () => {
          if (safely(() => App.store.trashPage(rowId)) === undefined) return;
          App.toast("Moved to trash", { action: { label: "Undo", run: () => safely(() => App.store.restorePage(rowId)) } });
        },
      },
    ]);
  }

  const MIN_W = 80;
  const ADD_W = 40;
  const colWidth = (view, p) => {
    const w = Number((view.widths || {})[p.id]);
    return Math.max(MIN_W, Number.isFinite(w) && w > 0 ? w : p.id === "title" ? 280 : 200);
  };
  const sel = (attr, value) => `[${attr}="${CSS.escape(value)}"]`;

  // --- mount ------------------------------------------------------------------------------------
  function mount(target, opts = {}) {
    const dbId = opts.pageId;
    const inline = Boolean(opts.inline);
    // Not editable even inside the block editor's editable area; the inputs
    // in here are form controls and work regardless.
    const root = el("div", { class: `db ${inline ? "db-inline" : "db-full"}`, contenteditable: "false" });
    const ctx = makeHost(dbId, opts.readOnly, () => draw());
    Object.assign(ctx, {
      inline,
      root,
      viewId: opts.viewId || App.local.get(`db.view.${dbId}`, null),
      rowIds: new Set(),
      scroll: {},
      pending: null,         // { rowId, propId } to edit after the next rebuild
      pendingPropMenu: null, // a property whose menu opens after the next rebuild
      drag: null,
      watchBlocks: false,
    });
    target.replaceChildren(root);

    const activeView = (s) => s.views.find((v) => v.id === ctx.viewId) || s.views[0];

    ctx.setView = (id) => {
      ctx.viewId = id;
      App.local.set(`db.view.${dbId}`, id);
      if (ctx.editing) ctx.editing.finish(true);
      draw();
    };
    ctx.openFilters = () => {
      const btn = root.querySelector(".db-tool-filter");
      const s = ctx.schema();
      if (btn) filterPopover(ctx, btn, activeView(s).id);
    };

    /* A new row, pre-filled so the active view keeps showing it, with its
       title ready for typing after the rebuild. */
    ctx.addRow = (extraProps = {}, placement = {}) => {
      const s = ctx.schema();
      const pre = prefillFor(s, activeView(s));
      if (ctx.editing) ctx.editing.finish(true);
      const row = createRow(dbId, { props: { ...pre.props, ...extraProps }, title: pre.title, ...placement });
      if (row) ctx.pending = { rowId: row.id, propId: "title" };
      return row;
    };

    // Typing in our inputs must not reach an editor or shell around us (an
    // inline database sits inside the block editor, whose keys mean other
    // things; Ctrl+Z in a cell is the input's undo, not the page's).
    for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "copy", "cut"]) {
      root.addEventListener(type, (e) => {
        const t = e.target;
        if (t && t.matches && t.matches("input, textarea, select")) e.stopPropagation();
      });
    }

    function onChange(ev) {
      if (ctx.destroyed) return;
      const pages = ev.pages || new Set();
      let hit = pages.has(dbId);
      if (!hit) {
        for (const id of pages) {
          if (ctx.rowIds.has(id)) { hit = true; break; }
          const p = App.store.page(id);
          if (p && p.parent_id === dbId) { hit = true; break; }
        }
      }
      if (!hit && ctx.watchBlocks && ev.blocks && ev.blocks.size) {
        for (const bid of ev.blocks) {
          const b = App.store.block(bid);
          if (b && ctx.rowIds.has(b.page_id)) { hit = true; break; }
        }
      }
      if (hit) requestRender(ctx);
    }
    const off = App.bus.on("store:change", onChange);

    function draw() {
      if (ctx.destroyed) return;
      root.querySelectorAll("[data-scroll-key]").forEach((n) => { ctx.scroll[n.dataset.scrollKey] = n.scrollLeft; });
      dropGantt();
      const page = App.store.page(dbId);
      const ro = ctx.readOnly();
      root.classList.toggle("db-readonly", ro);
      if (!page || page.deleted || page.kind !== "database") {
        root.replaceChildren(el("div", { class: "db-missing" },
          el("span", { html: icon("database", 18) }),
          el("span", { text: !page ? "This database is not available." : page.deleted ? "This database is in the trash." : "This page is not a database." })));
        ctx.rowIds = new Set();
        return;
      }
      const s = schemaOf(page);
      const view = activeView(s);
      const all = App.store.children(dbId);
      ctx.rowIds = new Set(all.map((r) => r.id));
      ctx.watchBlocks = view.type === "gallery" || s.properties.some((p) => p.type === "last_edited_time");
      const rows = viewRows(dbId, s, view);
      const parts = [];
      if (inline) parts.push(drawInlineHead(page));
      parts.push(drawBar(s, view, ro));
      const body = el("div", { class: `db-body db-body-${view.type}` });
      if (view.type === "board") body.append(...drawBoard(s, view, rows, ro));
      else if (view.type === "list") body.append(...drawList(s, view, rows, ro));
      else if (view.type === "gallery") body.append(...drawGallery(s, view, rows, ro));
      else if (view.type === "gantt") body.append(...drawGantt(s, view, rows, ro));
      else body.append(...drawTable(s, view, rows, ro));
      parts.push(body);
      root.replaceChildren(...parts);
      root.querySelectorAll("[data-scroll-key]").forEach((n) => {
        const x = ctx.scroll[n.dataset.scrollKey];
        if (x) n.scrollLeft = x;
      });
      // On a narrow screen the tab strip scrolls: keep the active tab in it.
      // (By hand: scrollIntoView would also scroll the page to the database.)
      const strip = root.querySelector(".db-tabs");
      const act = strip && strip.querySelector(".db-tab.active");
      if (act && strip.scrollWidth > strip.clientWidth) {
        const l = act.offsetLeft - strip.offsetLeft;
        const r = l + act.offsetWidth;
        if (l < strip.scrollLeft) strip.scrollLeft = Math.max(0, l - 8);
        else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth + 8;
      }
      afterDraw(view);
      // Last: a Gantt scrolls its strip to where it was (or to today) once
      // it is in the document and has a width.
      if (ctx.gantt) ctx.gantt.mounted();
    }

    function afterDraw(view) {
      if (ctx.pending) {
        const { rowId, propId } = ctx.pending;
        ctx.pending = null;
        const cell = root.querySelector(`.db-td${sel("data-row-id", rowId)}${sel("data-prop-id", propId)}`);
        if (cell) {
          cell.scrollIntoView({ block: "nearest", inline: "nearest" });
          startEdit(ctx, cell, rowId, propId);
        } else {
          const holder = root.querySelector(`${sel("data-row-id", rowId)} [data-edit-title]`);
          if (holder) {
            holder.scrollIntoView({ block: "nearest", inline: "nearest" });
            cardTitleEditor(ctx, holder, rowId);
          } else if (App.store.page(rowId)) {
            // Filters that cannot be pre-filled ("is not empty") hide it.
            App.toast("Added a row, but this view's filters hide it", { action: { label: "Open", run: () => openRow(rowId) } });
          }
        }
      }
      if (ctx.pendingPropMenu) {
        const id = ctx.pendingPropMenu;
        ctx.pendingPropMenu = null;
        const th = root.querySelector(`.db-th${sel("data-prop-id", id)}`);
        if (th) {
          th.scrollIntoView({ block: "nearest", inline: "nearest" });
          propertyMenu(ctx, th, id, { view: view.id, focusName: true, onFilter: ctx.openFilters });
        }
      }
    }

    function drawInlineHead(page) {
      const ref = page.icon ? App.files.ref(page.icon) : null;
      const ic = App.files.isGlyph(ref) ? el("span", { class: "db-inline-icon" }, App.glyph(ref))
        : ref && ref.kind === "url" ? el("span", { class: "db-inline-icon" }, el("img", { src: ref.url, alt: "" }))
          : el("span", { class: "db-inline-icon db-inline-icon-empty", html: icon("database", 18) });
      return el("div", { class: "db-inline-head" },
        el("button", { class: "db-inline-title", type: "button", title: "Open as a full page", onclick: () => openRow(dbId) },
          ic, el("span", { class: `db-inline-name${page.title ? "" : " untitled"}`, text: page.title || "Untitled" })));
    }

    function tool(cls, iconName, label, { on = false, count = 0, hint = "", onClick } = {}) {
      return el("button", { class: `db-tool ${cls}${on ? " on" : ""}`, type: "button", title: label, "aria-label": label, onclick: onClick },
        el("span", { class: "db-tool-icon", html: icon(iconName, 15) }),
        el("span", { class: "db-tool-label", text: hint ? `${label}: ${hint}` : label }),
        count ? el("span", { class: "db-tool-count", text: String(count) }) : null);
    }

    function drawBar(s, view, ro) {
      const tabs = el("div", { class: "db-tabs", role: "tablist", dataset: { scrollKey: "tabs" } });
      for (const v of s.views) {
        const active = v.id === view.id;
        const tab = el("button", {
          class: `db-tab${active ? " active" : ""}`, type: "button", role: "tab", "aria-selected": active ? "true" : "false",
          title: active && !ro ? "View options" : v.name,
          onclick: (e) => { if (active && !ro) viewMenu(ctx, e.currentTarget, v.id); else ctx.setView(v.id); },
          oncontextmenu: (e) => { if (ro) return; e.preventDefault(); viewMenu(ctx, e.currentTarget, v.id); },
        },
        // The face carries the hover tint; the tab itself spans the bar's
        // height so the active underline sits on the bar's bottom border.
        el("span", { class: "db-tab-face" },
          el("span", { class: "db-tab-icon", html: icon(viewIcon(v.type), 15) }),
          el("span", { class: "db-tab-name", text: v.name || "Untitled view" }),
          active && !ro ? el("span", { class: "db-tab-more", html: icon("chevron-down", 12) }) : null));
        tabs.append(tab);
      }
      if (!ro) {
        tabs.append(el("button", {
          class: "db-tab-add icon-btn icon-btn-small", type: "button", title: "Add a view", "aria-label": "Add a view", html: icon("plus", 15),
          onclick: (e) => App.ui.menu(e.currentTarget, [
            { heading: "Add a view" },
            ...VIEW_TYPES.map((t) => ({ label: t.label, icon: t.icon, onSelect: () => { const id = createView(ctx, t.type); if (id) ctx.setView(id); } })),
          ]),
        }));
      }
      const tools = el("div", { class: "db-tools" });
      const gantt = view.type === "gantt";
      if (gantt && ganttConfig(s, view).start) {
        // Looking around the timeline is for everyone, read-only or not.
        const z = ganttZoomOf(view);
        tools.append(
          tool("db-tool-today", "calendar", "Today", { onClick: () => ctx.ganttToday() }),
          el("button", {
            class: "db-tool db-tool-zoom", type: "button", title: "Zoom", "aria-label": `Zoom: ${z.label}`,
            onclick: (e) => App.ui.menu(e.currentTarget, GANTT_ZOOMS.map((x) => ({
              label: x.label, checked: x.id === z.id, onSelect: () => ctx.setGanttZoom(view, x.id),
            }))),
          },
          el("span", { class: "db-tool-icon", html: icon("db-scale", 15) }),
          el("span", { class: "db-gt-zoom-label", text: z.label }),
          el("span", { class: "db-gt-zoom-caret", html: icon("chevron-down", 12) })));
        if (!ro) tools.append(el("span", { class: "db-tools-sep" }));
      }
      if (!ro) {
        const nf = Array.isArray(view.filter) ? view.filter.length : 0;
        const ns = Array.isArray(view.sort) ? view.sort.length : 0;
        tools.append(
          tool("db-tool-filter", "filter", "Filter", { on: nf > 0, count: nf, onClick: (e) => filterPopover(ctx, e.currentTarget, view.id) }),
          tool("db-tool-sort", "sort", "Sort", { on: ns > 0, count: ns, onClick: (e) => sortPopover(ctx, e.currentTarget, view.id) }));
        if (view.type === "board") {
          const g = propById(s, view.group_by);
          tools.append(tool("db-tool-group", "board", "Group", { hint: g ? g.name : "", onClick: (e) => groupPopover(ctx, e.currentTarget, view.id) }));
        }
        tools.append(
          gantt
            ? tool("db-tool-timeline", "settings", "Timeline", { onClick: (e) => ganttSettings(ctx, e.currentTarget, view.id) })
            : tool("db-tool-props", "eye", "Properties", { onClick: (e) => propertiesPopover(ctx, e.currentTarget, view.id) }),
          el("button", { class: "btn btn-primary btn-small db-new-btn", type: "button", onclick: () => (gantt ? ctx.addGanttRow(view) : ctx.addRow()) },
            el("span", { html: icon("plus", 14) }), el("span", { class: "db-new-label", text: "New" })));
      }
      return el("div", { class: "db-bar" }, tabs, tools);
    }

    // --- table --------------------------------------------------------------------------------
    function drawTable(s, view, rows, ro) {
      const cols = tableColumns(s, view);
      const total = cols.reduce((a, p) => a + colWidth(view, p), 0) + (ro ? 0 : ADD_W);
      const table = el("div", { class: "db-table", role: "table", style: `width:${total}px` });
      const head = el("div", { class: "db-tr db-thead", role: "row" });
      for (const p of cols) {
        head.append(el("div", {
          class: `db-th${ro ? "" : " db-th-editable"}`, role: "columnheader", dataset: { propId: p.id }, style: `width:${colWidth(view, p)}px`,
          title: ro ? p.name : `${p.name} (click for options)`,
        },
        el("span", { class: "db-th-icon", html: icon(typeIcon(p.type), 15) }),
        el("span", { class: "db-th-name", text: p.name || typeLabel(p.type) }),
        ro ? null : el("span", { class: "db-resize", title: "Drag to resize" })));
      }
      if (!ro) head.append(el("button", { class: "db-th db-th-add", type: "button", title: "Add a property", "aria-label": "Add a property", html: icon("plus", 15), style: `width:${ADD_W}px` }));
      const canDrag = !ro && !(Array.isArray(view.sort) && view.sort.length);
      const tbody = el("div", { class: "db-tbody", role: "rowgroup" });
      for (const r of rows) {
        const tr = el("div", { class: "db-tr", role: "row", dataset: { rowId: r.id } });
        if (!ro) {
          tr.append(el("div", { class: "db-row-gutter" },
            el("button", {
              class: "db-row-handle", type: "button", draggable: canDrag ? "true" : null,
              title: canDrag ? "Drag to move, click for options" : "Row options", "aria-label": "Row options", html: icon("drag", 14),
            })));
        }
        for (const p of cols) {
          const td = el("div", {
            class: `db-td db-td-${p.type}${COMPUTED.has(p.type) || ro ? " db-td-static" : ""}`, role: "cell",
            dataset: { rowId: r.id, propId: p.id, type: p.type }, style: `width:${colWidth(view, p)}px`,
          });
          fillCell(ctx, td, r, p);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(head, tbody);
      if (!rows.length) {
        const filtered = Array.isArray(view.filter) && view.filter.length && App.store.children(dbId).length;
        table.append(el("div", { class: "db-table-empty", text: filtered ? "No rows match these filters." : ro ? "No rows yet." : "No rows yet. Add one to get started." }));
      }
      if (!ro) {
        table.append(el("button", { class: "db-new-row", type: "button", onclick: () => ctx.addRow() },
          el("span", { html: icon("plus", 15) }), el("span", { text: "New" })));
      }
      table.append(el("div", { class: "db-count" }, el("span", { class: "db-count-label", text: "Count" }), el("span", { class: "db-count-n", text: String(rows.length) })));

      // One set of listeners for the whole table rather than one per cell.
      table.addEventListener("click", (e) => {
        const t = e.target;
        if (t.closest(".db-resize") || ctx.justResized) return;
        const add = t.closest(".db-th-add");
        if (add) {
          addPropertyMenu(ctx, add, (p) => { ctx.pendingPropMenu = p.id; requestRender(ctx); });
          return;
        }
        const th = t.closest(".db-th");
        if (th) { propertyMenu(ctx, th, th.dataset.propId, { view: view.id, onFilter: ctx.openFilters }); return; }
        const handle = t.closest(".db-row-handle");
        if (handle) { rowMenu(ctx, handle, handle.closest(".db-tr").dataset.rowId); return; }
        const td = t.closest(".db-td");
        if (!td || td.classList.contains("editing")) return;
        if (ctx.readOnly()) { if (td.dataset.propId === "title") openRow(td.dataset.rowId); return; }
        startEdit(ctx, td, td.dataset.rowId, td.dataset.propId);
      });
      table.addEventListener("contextmenu", (e) => {
        const tr = e.target.closest(".db-tbody .db-tr");
        if (!tr || ctx.readOnly() || e.target.closest("input")) return;
        e.preventDefault();
        rowMenu(ctx, { x: e.clientX, y: e.clientY }, tr.dataset.rowId);
      });
      if (!ro) {
        table.addEventListener("pointerdown", (e) => {
          const grip = e.target.closest(".db-resize");
          if (grip) startResize(e, grip, table, view);
        });
        if (canDrag) wireRowDrag(tbody);
      }
      return [el("div", { class: "db-table-wrap db-scroll-x", dataset: { scrollKey: view.id } }, table)];
    }

    /* Drag a column's right edge. The width shows live and is saved once, on
       release (a width per pixel of movement would be a sync op per pixel). */
    function startResize(e, grip, table, view) {
      e.preventDefault();
      e.stopPropagation();
      const th = grip.closest(".db-th");
      const propId = th.dataset.propId;
      const cells = [th, ...table.querySelectorAll(`.db-td${sel("data-prop-id", propId)}`)];
      const startX = e.clientX;
      const startW = th.offsetWidth;
      const startTotal = table.offsetWidth;
      let w = startW;
      root.classList.add("db-resizing");
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => {
        w = Math.max(MIN_W, Math.round(startW + ev.clientX - startX));
        cells.forEach((c) => { c.style.width = `${w}px`; });
        table.style.width = `${startTotal + w - startW}px`;
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        root.classList.remove("db-resizing");
        ctx.justResized = true;
        setTimeout(() => { ctx.justResized = false; }, 60);
        if (w !== startW) mutateView(dbId, view.id, (v) => { v.widths = { ...(v.widths || {}), [propId]: w }; });
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    }

    /* Reorder rows by dragging the handle (only when the view is not sorted:
       a sort decides the order then). */
    function wireRowDrag(tbody) {
      const clear = () => tbody.querySelectorAll(".db-drop-before, .db-drop-after, .dragging")
        .forEach((n) => n.classList.remove("db-drop-before", "db-drop-after", "dragging"));
      tbody.addEventListener("dragstart", (e) => {
        const handle = e.target.closest && e.target.closest(".db-row-handle");
        if (!handle) return;
        const tr = handle.closest(".db-tr");
        ctx.drag = { kind: "row", rowId: tr.dataset.rowId };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", tr.dataset.rowId);
        e.dataTransfer.setDragImage(tr, 24, tr.offsetHeight / 2);
        tr.classList.add("dragging");
        e.stopPropagation();
      });
      tbody.addEventListener("dragover", (e) => {
        if (!ctx.drag || ctx.drag.kind !== "row") return;
        const tr = e.target.closest(".db-tr");
        if (!tr) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        tbody.querySelectorAll(".db-drop-before, .db-drop-after").forEach((n) => n.classList.remove("db-drop-before", "db-drop-after"));
        const r = tr.getBoundingClientRect();
        tr.classList.add(e.clientY > r.top + r.height / 2 ? "db-drop-after" : "db-drop-before");
      });
      tbody.addEventListener("drop", (e) => {
        if (!ctx.drag || ctx.drag.kind !== "row") return;
        e.preventDefault();
        e.stopPropagation();
        const target = tbody.querySelector(".db-drop-before, .db-drop-after");
        const id = ctx.drag.rowId;
        if (target && target.dataset.rowId !== id) {
          const where = target.classList.contains("db-drop-after") ? { after: target.dataset.rowId } : { before: target.dataset.rowId };
          safely(() => App.store.movePage(id, { parentId: dbId, ...where }));
        }
        clear();
        ctx.drag = null;
      });
      tbody.addEventListener("dragend", () => { clear(); ctx.drag = null; });
    }

    /* Tab moves to the next cell that edits in place (text, numbers). */
    ctx.nextCell = (cell, back) => {
      const cells = [...root.querySelectorAll(".db-tbody .db-td")].filter((c) => INPUT_TYPES.has(c.dataset.type) || c === cell);
      const i = cells.indexOf(cell);
      return i < 0 ? null : cells[i + (back ? -1 : 1)] || null;
    };

    // --- board --------------------------------------------------------------------------------
    function drawBoard(s, view, rows, ro) {
      const g = propById(s, view.group_by);
      if (!g || !(g.type === "select" || g.type === "status")) {
        const candidates = s.properties.filter((p) => p.type === "select" || p.type === "status");
        const actions = el("div", { class: "btn-row" });
        if (!ro) {
          candidates.forEach((p) => actions.append(el("button", {
            class: "btn btn-small", type: "button", text: `Group by ${p.name}`,
            onclick: () => mutateView(dbId, view.id, (v) => { v.group_by = p.id; }),
          })));
          actions.append(el("button", {
            class: `btn btn-small${candidates.length ? "" : " btn-primary"}`, type: "button", text: "Create a Status property",
            onclick: () => groupByNewStatus(ctx, view.id),
          }));
        }
        return [el("div", { class: "empty-state db-board-prompt" },
          el("div", { class: "empty-icon", html: icon("board", 36) }),
          el("h2", { text: "Choose how to group this board" }),
          el("p", { text: "A board shows each row as a card, in one column per option of a Select or Status property." }),
          ro ? null : actions)];
      }
      const options = g.options || [];
      const known = new Set(options.map((o) => o.name));
      const groups = [{ value: "", label: `No ${g.name}` }, ...options.map((o) => ({ value: o.name, color: COLORS.includes(o.color) ? o.color : "default" }))];
      const byValue = new Map(groups.map((x) => [x.value, []]));
      for (const r of rows) {
        const v = asOne(getValue(r, g));
        if (v && !known.has(v)) {
          // A value without an option (an import, a deleted option): its own column.
          known.add(v);
          groups.push({ value: v, color: "default" });
          byValue.set(v, []);
        }
        byValue.get(v || "").push(r);
      }
      const props = cardProps(s, view);
      const board = el("div", { class: "db-board db-scroll-x", dataset: { scrollKey: view.id } });
      for (const grp of groups) {
        const list = byValue.get(grp.value);
        const cards = el("div", { class: "db-col-cards" });
        list.forEach((r) => cards.append(card(r, props, ro)));
        board.append(el("div", {
          class: `db-col${grp.value ? "" : " db-col-none"}`, dataset: { value: grp.value },
          style: grp.value ? `--col: var(--tag-${grp.color})` : null,
        },
        el("div", { class: "db-col-head" },
          grp.value ? pill(g, grp.value) : el("span", { class: "db-col-none-label" }, el("span", { html: icon(typeIcon(g.type), 14) }), el("span", { text: grp.label })),
          el("span", { class: "db-col-count", text: String(list.length) })),
        cards,
        ro ? null : el("button", {
          class: "db-col-new", type: "button",
          onclick: () => ctx.addRow({ [g.id]: grp.value || undefined }),
        }, el("span", { html: icon("plus", 14) }), el("span", { text: "New" }))));
      }
      board.addEventListener("click", (e) => {
        const c = e.target.closest(".db-card");
        if (c && !c.classList.contains("editing")) openRow(c.dataset.rowId);
      });
      board.addEventListener("keydown", (e) => {
        const c = e.target.closest(".db-card");
        if (c && e.key === "Enter" && e.target === c) openRow(c.dataset.rowId);
      });
      board.addEventListener("contextmenu", (e) => {
        const c = e.target.closest(".db-card");
        if (!c || ctx.readOnly() || e.target.closest("input")) return;
        e.preventDefault();
        rowMenu(ctx, { x: e.clientX, y: e.clientY }, c.dataset.rowId);
      });
      if (!ro) wireBoardDrag(board, g);
      return [board];
    }

    /* Drag cards between columns (sets the group value, or clears it for the
       "No value" column) and within one (reorders). A line shows where the
       card lands. Value and position change as one undo step. */
    function wireBoardDrag(board, g) {
      const line = el("div", { class: "db-drop-line" });
      const clear = () => {
        line.remove();
        board.querySelectorAll(".db-col-over, .dragging").forEach((n) => n.classList.remove("db-col-over", "dragging"));
      };
      board.addEventListener("dragstart", (e) => {
        const c = e.target.closest && e.target.closest(".db-card");
        if (!c || c.classList.contains("editing")) return;
        ctx.drag = { kind: "card", rowId: c.dataset.rowId };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", c.dataset.rowId);
        e.stopPropagation();
        // Let the browser take its drag snapshot before the card dims.
        setTimeout(() => c.classList.add("dragging"), 0);
      });
      board.addEventListener("dragover", (e) => {
        if (!ctx.drag || ctx.drag.kind !== "card") return;
        const col = e.target.closest(".db-col");
        if (!col) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        board.querySelectorAll(".db-col-over").forEach((n) => { if (n !== col) n.classList.remove("db-col-over"); });
        col.classList.add("db-col-over");
        const holder = col.querySelector(".db-col-cards");
        const cards = [...holder.querySelectorAll(".db-card")].filter((c) => c.dataset.rowId !== ctx.drag.rowId);
        const next = cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
        if (next) { if (line.nextSibling !== next) holder.insertBefore(line, next); }
        else if (line.parentNode !== holder || line.nextSibling) holder.append(line);
      });
      board.addEventListener("dragleave", (e) => {
        if (!board.contains(e.relatedTarget)) clear();
      });
      board.addEventListener("drop", (e) => {
        if (!ctx.drag || ctx.drag.kind !== "card") return;
        e.preventDefault();
        e.stopPropagation();
        const col = line.parentNode ? line.closest(".db-col") : e.target.closest(".db-col");
        const id = ctx.drag.rowId;
        ctx.drag = null;
        if (!col) { clear(); return; }
        const findCard = (n, dir) => {
          let x = n ? n[dir] : null;
          while (x && !(x.classList && x.classList.contains("db-card") && x.dataset.rowId !== id)) x = x[dir];
          return x;
        };
        const next = line.parentNode ? findCard(line, "nextSibling") : null;
        const prev = line.parentNode ? findCard(line, "previousSibling") : null;
        const value = col.dataset.value || "";
        const row = App.store.page(id);
        clear();
        if (!row) return;
        const same = asOne(getValue(row, g)) === value;
        // Where the card was: dropping it back in place is not a move.
        const own = board.querySelector(`.db-card${sel("data-row-id", id)}`);
        const wasNext = own ? findCard(own, "nextSibling") : null;
        const wasPrev = own ? findCard(own, "previousSibling") : null;
        const moved = !same || (next ? next !== wasNext : prev !== wasPrev);
        safely(() => App.store.group("Move card", () => {
          if (!same) setValue(id, g, value || null);
          if (moved && next) App.store.movePage(id, { parentId: dbId, before: next.dataset.rowId });
          else if (moved && prev) App.store.movePage(id, { parentId: dbId, after: prev.dataset.rowId });
        }));
      });
      board.addEventListener("dragend", () => { clear(); ctx.drag = null; });
    }

    function card(r, props, ro, className = "db-card") {
      const node = el("div", { class: className, dataset: { rowId: r.id }, tabindex: "0", draggable: ro || className !== "db-card" ? null : "true" });
      node.append(el("div", { class: "db-card-title" },
        rowIcon(r),
        el("span", { class: `db-card-title-text${r.title ? "" : " untitled"}`, dataset: { editTitle: "1" }, text: r.title || "Untitled" })));
      const values = compactProps(r, props);
      if (values) node.append(values);
      return node;
    }

    // --- list ---------------------------------------------------------------------------------
    function drawList(s, view, rows, ro) {
      const props = cardProps(s, view);
      const list = el("div", { class: "db-list" });
      for (const r of rows) {
        list.append(el("div", { class: "db-list-row", dataset: { rowId: r.id }, tabindex: "0", role: "link" },
          rowIcon(r, { fallback: true }),
          el("span", { class: `db-list-title${r.title ? "" : " untitled"}`, dataset: { editTitle: "1" }, text: r.title || "Untitled" }),
          compactProps(r, props, "db-list-props") || el("span", { class: "db-list-props" })));
      }
      if (!rows.length) {
        const filtered = Array.isArray(view.filter) && view.filter.length && App.store.children(dbId).length;
        list.append(el("div", { class: "db-list-empty", text: filtered ? "No rows match these filters." : "No rows yet." }));
      }
      if (!ro) list.append(el("button", { class: "db-new-row db-list-new", type: "button", onclick: () => ctx.addRow() }, el("span", { html: icon("plus", 15) }), el("span", { text: "New" })));
      list.addEventListener("click", (e) => {
        const line = e.target.closest(".db-list-row");
        if (line && !line.classList.contains("editing")) openRow(line.dataset.rowId);
      });
      list.addEventListener("keydown", (e) => {
        const line = e.target.closest(".db-list-row");
        if (line && e.key === "Enter" && e.target === line) openRow(line.dataset.rowId);
      });
      list.addEventListener("contextmenu", (e) => {
        const line = e.target.closest(".db-list-row");
        if (!line || ctx.readOnly() || e.target.closest("input")) return;
        e.preventDefault();
        rowMenu(ctx, { x: e.clientX, y: e.clientY }, line.dataset.rowId);
      });
      return [list, el("div", { class: "db-count" }, el("span", { class: "db-count-label", text: "Count" }), el("span", { class: "db-count-n", text: String(rows.length) }))];
    }

    // --- gallery ------------------------------------------------------------------------------
    function preview(r) {
      const box = el("div", { class: "db-gcover" });
      const ref = r.cover ? App.files.ref(r.cover) : null;
      if (ref && ref.kind === "url") { box.append(el("img", { src: ref.url, alt: "", loading: "lazy" })); return box; }
      if (ref && ref.kind === "gradient") { box.classList.add(`gradient-${Math.abs(ref.n) % 8}`); return box; }
      const top = App.store.blocks(r.id);
      const isImg = (b) => b.type === "image" && b.props && (b.props.file_id || /^https?:\/\//i.test(String(b.props.url || "")));
      const img = top.find(isImg) || App.store.allBlocks(r.id).find(isImg);
      if (img) {
        const src = img.props.file_id ? App.files.url(img.props.file_id) : img.props.url;
        box.append(el("img", { src, alt: "", loading: "lazy" }));
        return box;
      }
      // No picture: the first lines of the page, the way Notion previews it.
      const lines = top.filter((b) => b.text && !["code", "equation", "divider"].includes(b.type)).slice(0, 4);
      box.classList.add("db-gcover-text");
      if (lines.length) {
        for (const b of lines) {
          const plain = String(b.text).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_~=`]/g, "");
          box.append(el("div", { class: `db-gline db-gline-${b.type}`, text: plain }));
        }
      } else box.append(el("span", { class: "db-gcover-empty", html: icon("page", 22) }));
      return box;
    }

    function drawGallery(s, view, rows, ro) {
      const props = cardProps(s, view);
      const grid = el("div", { class: "db-gallery" });
      for (const r of rows) {
        const c = card(r, props, ro, "db-gcard");
        c.prepend(preview(r));
        const body = el("div", { class: "db-gcard-body" }, ...[...c.childNodes].slice(1));
        c.append(body);
        grid.append(c);
      }
      if (!ro) grid.append(el("button", { class: "db-gcard db-gcard-new", type: "button", onclick: () => ctx.addRow() }, el("span", { html: icon("plus", 16) }), el("span", { text: "New" })));
      if (!rows.length && ro) grid.append(el("div", { class: "db-list-empty", text: "No rows yet." }));
      grid.addEventListener("click", (e) => {
        const c = e.target.closest(".db-gcard[data-row-id]");
        if (c && !c.classList.contains("editing")) openRow(c.dataset.rowId);
      });
      grid.addEventListener("keydown", (e) => {
        const c = e.target.closest(".db-gcard[data-row-id]");
        if (c && e.key === "Enter" && e.target === c) openRow(c.dataset.rowId);
      });
      grid.addEventListener("contextmenu", (e) => {
        const c = e.target.closest(".db-gcard[data-row-id]");
        if (!c || ctx.readOnly() || e.target.closest("input")) return;
        e.preventDefault();
        rowMenu(ctx, { x: e.clientX, y: e.clientY }, c.dataset.rowId);
      });
      return [grid];
    }

    // --- gantt --------------------------------------------------------------------------------
    /* A timeline: row titles on the left (sticky), a strip of days on the
       right that scrolls sideways, and one bar per row from its start to its
       end (whole days, both ends included; a single date is a milestone).

       Kept fast for a few hundred rows: the strip's header and grid are drawn
       only for the stretch on screen (redrawn as it scrolls), each row is one
       bar element, and a drag moves that element once per frame and writes
       the row once, on release. The scroll position is kept as a day, so a
       rebuild, a zoom or a range that grows keeps the same stretch in view. */
    ctx.gantt = null;        // the chart on screen: its scale and its hooks
    ctx.ganttAnchors = {};   // view id -> the day in the middle of the strip
    ctx.ganttZoomLocal = {}; // view id -> zoom, for viewers who cannot change the view
    ctx.ganttScrollTo = null;
    ctx.ganttFocus = null;   // a row whose bar takes the focus after the rebuild
    ctx.ganttNoClick = false; // true for the click that ends a drag (it opens nothing)

    function dropGantt() {
      if (!ctx.gantt) return;
      ctx.gantt.cleanup.forEach((fn) => fn());
      ctx.gantt = null;
    }

    const ganttZoomOf = (view) => zoomOf(ctx.readOnly() && ctx.ganttZoomLocal[view.id] ? ctx.ganttZoomLocal[view.id] : view.zoom);

    ctx.setGanttZoom = (view, id) => {
      const g = ctx.gantt;
      if (g && g.viewId === view.id) ctx.ganttAnchors[view.id] = g.centerDay();
      if (ctx.readOnly()) { ctx.ganttZoomLocal[view.id] = id; draw(); return; }
      mutateView(dbId, view.id, (v) => { if (v.zoom === id) return false; v.zoom = id; });
    };

    ctx.ganttToday = () => { if (ctx.gantt) ctx.gantt.scrollToDay(todayNum(), true); };

    /* "New" in a Gantt: a row that starts (and, until dragged longer, ends)
       today, scrolled into view. */
    ctx.addGanttRow = (view) => {
      const cfg = ganttConfig(ctx.schema(), view);
      if (!cfg.start) return ctx.addRow();
      const t = dayStr(todayNum());
      ctx.ganttScrollTo = todayNum();
      return ctx.addRow(cfg.end ? { [cfg.start.id]: t, [cfg.end.id]: t } : { [cfg.start.id]: { start: t, end: t } });
    };

    /* The days the strip covers: every bar and today, with room around them,
       whole weeks or months at both ends, and at least a couple of screens. */
    function ganttRange(dated, zoom, today) {
      let lo = today;
      let hi = today;
      for (const { sp } of dated) { if (sp.s < lo) lo = sp.s; if (sp.e > hi) hi = sp.e; }
      if (hi - lo > GANTT_MAX_DAYS) {
        lo = Math.max(lo, today - GANTT_MAX_DAYS / 2);
        hi = Math.min(hi, lo + GANTT_MAX_DAYS);
      }
      if (zoom.id === "month") {
        lo = monthOf(lo, -2);
        hi = Math.max(monthOf(hi, 4), monthOf(lo, 26)) - 1;
      } else if (zoom.id === "week") {
        lo = mondayOf(lo) - 14;
        hi = Math.max(mondayOf(hi) + 8 * 7, lo + 36 * 7) - 1;
      } else {
        lo = mondayOf(lo) - 7;
        hi = Math.max(mondayOf(hi) + 4 * 7, lo + 12 * 7) - 1;
      }
      return { lo, hi };
    }

    function ganttPrompt(view, ro) {
      const add = () => mutateSchema(dbId, (x) => {
        const p = { id: rid("p_"), name: uniqueName(x.properties, "Dates"), type: "date" };
        x.properties.push(p);
        const v = x.views.find((y) => y.id === view.id);
        if (v) v.date_property = p.id;
      });
      return el("div", { class: "empty-state db-board-prompt" },
        el("div", { class: "empty-icon", html: icon("db-gantt", 36) }),
        el("h2", { text: "Add dates to see a timeline" }),
        el("p", { text: "A Gantt chart draws each row as a bar from its start date to its end date. This database has no Date property yet." }),
        ro ? null : el("div", { class: "btn-row" }, el("button", { class: "btn btn-small btn-primary", type: "button", text: "Create a Date property", onclick: add })));
    }

    function drawGantt(s, view, rows, ro) {
      const cfg = ganttConfig(s, view);
      if (!cfg.start) return [ganttPrompt(view, ro)];
      const zoom = ganttZoomOf(view);
      const px = zoom.px;
      const today = todayNum();
      const dated = [];
      const undated = [];
      for (const r of rows) {
        const sp = ganttSpan(r, cfg);
        if (sp) dated.push({ r, sp }); else undated.push(r);
      }
      const { lo, hi } = ganttRange(dated, zoom, today);
      const W = (hi - lo + 1) * px;
      const X = (d) => (d - lo) * px;
      const titleProp = propById(s, "title");

      const colourOf = (r) => {
        if (!cfg.color) return "accent";
        const opt = optionOf(cfg.color, asOne(getValue(r, cfg.color)));
        return opt && COLORS.includes(opt.color) ? opt.color : "default";
      };

      /* Position a bar (or milestone) for a span. A bar too short for its
         title puts the title after it; a very short one keeps its stretch
         handles outside, so the middle still moves it. */
      function place(node, a, b) {
        if (node.classList.contains("db-gt-ms")) { node.style.left = `${X(a) + px / 2}px`; return; }
        const w = (b - a + 1) * px;
        node.style.left = `${X(a)}px`;
        node.style.width = `${w}px`;
        node.classList.toggle("db-gt-narrow", w < Number(node.dataset.fit || 0));
        node.classList.toggle("db-gt-short", w < 24);
      }
      const barFont = `500 12.5px ${getComputedStyle(document.body).fontFamily}`;

      function bar(r, sp) {
        const title = r.title || "Untitled";
        let node;
        if (sp.milestone) {
          node = el("div", {
            class: `db-gt-ms db-gt-c-${colourOf(r)}`, role: "button", tabindex: "0",
            title: `${title}\n${fmtDay(sp.s)}`, "aria-label": `${title}, ${fmtDay(sp.s)}`,
          }, el("span", { class: "db-gt-ms-mark" }), el("span", { class: "db-gt-label", text: title }));
        } else {
          node = el("div", {
            class: `db-gt-bar db-gt-c-${colourOf(r)}`, role: "button", tabindex: "0",
            title: `${title}\n${fmtSpan(sp.s, sp.e)}`, "aria-label": `${title}, ${fmtSpan(sp.s, sp.e)}`,
            // The width the title needs inside the bar, padding included.
            dataset: { fit: String(Math.ceil(textWidth(title.slice(0, 80), barFont) + 20)) },
          },
          ro ? null : el("span", { class: "db-gt-h db-gt-h-start", dataset: { edge: "start" } }),
          el("span", { class: "db-gt-label", text: title }),
          ro ? null : el("span", { class: "db-gt-h db-gt-h-end", dataset: { edge: "end" } }));
        }
        place(node, sp.s, sp.e);
        return node;
      }

      function rowNode(r, sp) {
        return el("div", { class: `db-gt-row${sp ? "" : " db-gt-undated"}`, dataset: { rowId: r.id } },
          el("div", { class: "db-gt-title", role: "link", tabindex: "0", title: r.title || "Untitled" },
            rowIcon(r, { fallback: true }),
            el("span", { class: `db-gt-title-text${r.title ? "" : " untitled"}`, dataset: { editTitle: "1" }, text: r.title || "Untitled" })),
          el("div", { class: "db-gt-lane", style: `width:${W}px` }, sp ? bar(r, sp) : null));
      }

      // The header: months (years at month zoom) over days, weeks or months.
      const top = el("div", { class: "db-gt-tops" });
      const units = el("div", { class: "db-gt-units" });
      const corner = el("div", { class: "db-gt-corner" }, el("span", { text: (titleProp && titleProp.name) || "Name" }));
      const head = el("div", { class: "db-gt-head" }, corner, el("div", { class: "db-gt-scale", style: `width:${W}px` }, top, units));
      // Behind the rows: grid lines, weekends and the today line.
      const cells = el("div", { class: "db-gt-cells" });
      const grid = el("div", { class: "db-gt-grid", style: `width:${W}px`, "aria-hidden": "true" }, cells,
        today >= lo && today <= hi ? el("div", { class: "db-gt-today", style: `left:${X(today) + px / 2}px` }) : null);
      const body = el("div", { class: "db-gt-body" }, grid);
      for (const { r, sp } of dated) body.append(rowNode(r, sp));
      if (undated.length) {
        body.append(el("div", { class: "db-gt-section" },
          el("div", { class: "db-gt-section-label" },
            el("span", { class: "db-count-label", text: "No dates" }),
            el("span", { class: "db-gt-section-n", text: String(undated.length) }),
            ro ? null : el("span", { class: "db-gt-section-hint", text: "Drag along a row to give it dates" }))));
        for (const r of undated) body.append(rowNode(r, null));
      }
      if (!rows.length) {
        const filtered = Array.isArray(view.filter) && view.filter.length && App.store.children(dbId).length;
        body.append(el("div", { class: "db-gt-empty" }, el("span", {
          text: filtered ? "No rows match these filters." : ro ? "No rows yet." : "No rows yet. Add one, then drag its bar to plan it.",
        })));
      }
      const canvas = el("div", { class: `db-gantt db-gantt-${zoom.id}`, style: `width:calc(var(--gt-title) + ${W}px)` }, head, body);
      const scroller = el("div", { class: "db-gantt-scroll" }, canvas);

      const g = {
        viewId: view.id, lo, hi, px, cleanup: [], painted: null, raf: 0, needsScroll: true,
        laneWidth: () => Math.max(0, scroller.clientWidth - corner.offsetWidth),
        centerDay: () => lo + (scroller.scrollLeft + g.laneWidth() / 2) / px,
        // A day a fifth of the way into the strip: today with a little past.
        // While a smooth scroll runs, the day kept for a rebuild is where it
        // is going (a sync landing mid-way must not stop it half-way).
        scrollToDay(d, smooth) {
          const laneW = g.laneWidth();
          const left = Math.max(0, X(d) - laneW * 0.2);
          if (!smooth) { scroller.scrollLeft = left; return; }
          ctx.ganttAnchors[view.id] = lo + (left + laneW / 2) / px;
          g.settleUntil = Date.now() + 1500;
          scroller.scrollTo({ left, behavior: "smooth" });
        },
        schedule() { if (!g.raf) g.raf = requestAnimationFrame(() => { g.raf = 0; paint(false); }); },
        mounted() {
          let tries = 0;
          const go = () => {
            if (ctx.gantt !== g) return;
            if (!scroller.isConnected && tries++ < 120) { requestAnimationFrame(go); return; }
            paint(true);
          };
          go();
        },
      };
      g.cleanup.push(() => { if (g.raf) cancelAnimationFrame(g.raf); });
      if (window.ResizeObserver) {
        const obs = new ResizeObserver(() => g.schedule());
        obs.observe(scroller);
        g.cleanup.push(() => obs.disconnect());
      }
      scroller.addEventListener("scroll", () => g.schedule(), { passive: true });
      ctx.gantt = g;

      /* Draw the header and grid for the stretch on screen, with a screen's
         worth either side, and only again once the view leaves that. The
         first paint with a width also sets the scroll position. */
      function paint(force) {
        if (ctx.gantt !== g || !scroller.isConnected || !scroller.clientWidth) return;
        const laneW = g.laneWidth();
        if (g.needsScroll) {
          g.needsScroll = false;
          const anchor = ctx.ganttAnchors[view.id];
          if (ctx.ganttScrollTo !== null) { g.scrollToDay(ctx.ganttScrollTo); ctx.ganttScrollTo = null; }
          else if (Number.isFinite(anchor)) scroller.scrollLeft = Math.max(0, (anchor - lo) * px - laneW / 2);
          else g.scrollToDay(today);
          if (ctx.ganttFocus) {
            const b = body.querySelector(`${sel("data-row-id", ctx.ganttFocus)} .db-gt-bar, ${sel("data-row-id", ctx.ganttFocus)} .db-gt-ms`);
            ctx.ganttFocus = null;
            if (b) b.focus({ preventScroll: true });
          }
          force = true;
        }
        const x0 = scroller.scrollLeft;
        if (!(g.settleUntil > Date.now())) ctx.ganttAnchors[view.id] = lo + (x0 + laneW / 2) / px;
        const d0 = lo + Math.floor(x0 / px);
        const d1 = Math.min(hi, lo + Math.ceil((x0 + laneW) / px));
        if (!force && g.painted && d0 >= g.painted.a && d1 <= g.painted.b) return;
        const extra = Math.max(14, d1 - d0);
        g.painted = { a: Math.max(lo, d0 - extra), b: Math.min(hi, d1 + extra) };
        drawScale(g.painted.a, g.painted.b);
      }

      function drawScale(a, b) {
        const tops = [];
        const unitEls = [];
        const lines = [];
        const seg = (cls, from, to, text) => el("div", { class: cls, style: `left:${X(from)}px;width:${(to - from + 1) * px}px` },
          el("span", { class: `${cls}-label`, text }));
        const byYear = zoom.id === "month";
        const step = byYear ? yearOf : monthOf;
        for (let m = step(a); m <= b; m = step(m, 1)) {
          const from = Math.max(m, lo);
          const to = Math.min(step(m, 1) - 1, hi);
          tops.push(seg("db-gt-top", from, to, byYear ? String(dayDate(m).getUTCFullYear())
            : utcFmt("g-month", { month: "long", year: "numeric" }).format(dayDate(m))));
          if (m > lo) lines.push(el("div", { class: "db-gt-line db-gt-line-major", style: `left:${X(m)}px` }));
        }
        const unit = (from, to, text, extraCls) => {
          const node = seg("db-gt-unit", from, to, text);
          if (extraCls) node.className += ` ${extraCls}`;
          unitEls.push(node);
        };
        if (zoom.id === "day") {
          for (let d = a; d <= b; d++) {
            const wd = weekdayOf(d);
            const weekend = wd === 0 || wd === 6;
            unit(d, d, String(dayDate(d).getUTCDate()), `${weekend ? "weekend" : ""}${d === today ? " today" : ""}`);
            if (weekend) lines.push(el("div", { class: "db-gt-weekend", style: `left:${X(d)}px;width:${px}px` }));
            if (dayDate(d).getUTCDate() !== 1) lines.push(el("div", { class: "db-gt-line", style: `left:${X(d)}px` }));
          }
        } else if (zoom.id === "week") {
          for (let w = mondayOf(a); w <= b; w += 7) {
            const from = Math.max(w, lo);
            unit(from, Math.min(w + 6, hi), `${dayDate(w).getUTCDate()} – ${dayDate(w + 6).getUTCDate()}`, today >= w && today < w + 7 ? "today" : "");
            if (w > lo) lines.push(el("div", { class: "db-gt-line", style: `left:${X(w)}px` }));
          }
        } else {
          for (let m = monthOf(a); m <= b; m = monthOf(m, 1)) {
            const next = monthOf(m, 1);
            unit(Math.max(m, lo), Math.min(next - 1, hi), utcFmt("g-mon", { month: "short" }).format(dayDate(m)), today >= m && today < next ? "today" : "");
            if (m > lo) lines.push(el("div", { class: "db-gt-line", style: `left:${X(m)}px` }));
          }
        }
        top.replaceChildren(...tops);
        units.replaceChildren(...unitEls);
        cells.replaceChildren(...lines);
      }

      // --- reading and clicking ---
      // A press that travels is a drag (or an attempt at one, read-only),
      // even when it ends on the element it started on: not a click.
      let pressAt = null;
      body.addEventListener("pointerdown", (e) => { pressAt = { x: e.clientX, y: e.clientY }; }, true);
      body.addEventListener("click", (e) => {
        if (ctx.ganttNoClick) return; // the click that ends a drag
        if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 6) return;
        const rowEl = e.target.closest(".db-gt-row");
        if (!rowEl || rowEl.classList.contains("editing")) return;
        if (e.target.closest(".db-gt-bar, .db-gt-ms, .db-gt-title")) openRow(rowEl.dataset.rowId);
      });
      body.addEventListener("contextmenu", (e) => {
        const rowEl = e.target.closest(".db-gt-row");
        if (!rowEl || ctx.readOnly() || !e.target.closest(".db-gt-bar, .db-gt-ms, .db-gt-title") || e.target.closest("input")) return;
        e.preventDefault();
        rowMenu(ctx, { x: e.clientX, y: e.clientY }, rowEl.dataset.rowId);
      });
      /* Enter opens a row; on a bar, the arrow keys move it a day (Shift:
         its end, Alt: its start). Handled keys stop here, before an editor
         around an inline database reads them as its own. */
      body.addEventListener("keydown", (e) => {
        const rowEl = e.target.closest(".db-gt-row");
        if (!rowEl || rowEl.classList.contains("editing") || e.target.closest("input")) return;
        const onBar = e.target.matches(".db-gt-bar, .db-gt-ms");
        if (e.key === "Enter" && (onBar || e.target.matches(".db-gt-title"))) {
          e.preventDefault();
          e.stopPropagation();
          openRow(rowEl.dataset.rowId);
          return;
        }
        if (!onBar || ctx.readOnly() || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        e.stopPropagation();
        const row = App.store.page(rowEl.dataset.rowId);
        const sp = row && ganttSpan(row, cfg);
        if (!sp) return;
        const d = e.key === "ArrowLeft" ? -1 : 1;
        let [a, b] = [sp.s, sp.e];
        if (e.shiftKey && !sp.milestone) b = Math.max(a, b + d);
        else if (e.altKey && !sp.milestone) a = Math.min(b, a + d);
        else { a += d; b += d; }
        ctx.ganttFocus = row.id;
        safely(() => App.store.updatePage(row.id, { props: ganttProps(row, cfg, a, b, sp.milestone) }));
      });

      if (ro) return [el("div", { class: "db-gantt-wrap" }, scroller, ganttCount(rows.length))];

      // --- dragging ---
      const tip = el("div", { class: "db-gt-tip", "aria-hidden": "true" });
      const ghost = el("div", { class: "db-gt-ghost", "aria-hidden": "true" });
      const dayAt = (lane, clientX) => Math.max(lo, Math.min(hi, lo + Math.floor((clientX - lane.getBoundingClientRect().left) / px)));
      const showTip = (lane, a, b, left) => {
        tip.textContent = a === b ? fmtDay(a) : fmtSpan(a, b);
        tip.style.left = `${left}px`;
        if (tip.parentNode !== lane) lane.append(tip);
      };
      /* Near either edge of the strip a drag scrolls it; true while it does. */
      function edgeScroll(clientX) {
        const r = scroller.getBoundingClientRect();
        const left = r.left + corner.offsetWidth;
        let v = 0;
        if (clientX < left + 40) v = -Math.ceil((left + 40 - clientX) / 4);
        else if (clientX > r.right - 40) v = Math.ceil((clientX - (r.right - 40)) / 4);
        if (!v) return false;
        const before = scroller.scrollLeft;
        scroller.scrollLeft = before + v;
        return scroller.scrollLeft !== before;
      }

      /* One pointer gesture: `frame(clientX)` runs at most once per frame
         (and keeps running while the strip scrolls under a still pointer),
         `done(cancelled)` once at the end. Escape cancels. */
      function gesture(e, capture, frame, done) {
        let lastX = e.clientX;
        let raf = 0;
        let over = false;
        const tick = () => { raf = 0; if (!over && frame(lastX) && !raf) raf = requestAnimationFrame(tick); };
        const move = (ev) => { lastX = ev.clientX; if (!raf) raf = requestAnimationFrame(tick); };
        const finish = (cancel) => {
          if (over) return;
          over = true;
          if (raf) cancelAnimationFrame(raf);
          // The browser clicks where a gesture ends; that click is not one.
          ctx.ganttNoClick = true;
          setTimeout(() => { ctx.ganttNoClick = false; }, 60);
          capture.removeEventListener("pointermove", move);
          capture.removeEventListener("pointerup", up);
          capture.removeEventListener("pointercancel", cancelled);
          document.removeEventListener("keydown", key, true);
          root.classList.remove("db-gt-dragging");
          done(cancel);
        };
        const up = (ev) => { lastX = ev.clientX; frame(lastX); finish(false); };
        const cancelled = () => finish(true);
        const key = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(true); } };
        try { capture.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic event: listen anyway */ }
        capture.addEventListener("pointermove", move);
        capture.addEventListener("pointerup", up);
        capture.addEventListener("pointercancel", cancelled);
        document.addEventListener("keydown", key, true);
        g.cleanup.push(() => finish(true));
      }

      /* Drag a bar to move it, or one of its ends to stretch it. The bar
         follows the pointer in whole days; the row is written once, on
         release, and only if a day changed. */
      function dragBar(e, node, rowEl, mode) {
        const rowId = rowEl.dataset.rowId;
        const row = App.store.page(rowId);
        const sp = row && ganttSpan(row, cfg);
        if (!sp) return;
        e.preventDefault();
        const lane = node.parentNode;
        const x0 = e.clientX;
        const scroll0 = scroller.scrollLeft;
        let moved = false;
        let a = sp.s;
        let b = sp.e;
        gesture(e, node, (clientX) => {
          const scrolling = edgeScroll(clientX);
          const dx = clientX - x0 + scroller.scrollLeft - scroll0;
          if (!moved && Math.abs(dx) < 4) return scrolling;
          if (!moved) {
            moved = true;
            node.classList.add("dragging");
            root.classList.add("db-gt-dragging");
            if (mode !== "move") root.classList.add("db-gt-resizing");
          }
          const d = Math.round(dx / px);
          if (mode === "start") { a = Math.min(sp.e, sp.s + d); b = sp.e; }
          else if (mode === "end") { a = sp.s; b = Math.max(sp.s, sp.e + d); }
          else { a = sp.s + d; b = sp.e + d; }
          place(node, a, b);
          showTip(lane, a, b, sp.milestone ? X(a) + px / 2 : X(a));
          return scrolling;
        }, (cancel) => {
          node.classList.remove("dragging");
          root.classList.remove("db-gt-resizing");
          tip.remove();
          if (!moved) { ctx.ganttNoClick = false; return; } // a click: it opens the row
          if (cancel || (a === sp.s && b === sp.e)) { place(node, sp.s, sp.e); return; }
          const fresh = App.store.page(rowId);
          if (fresh) safely(() => App.store.updatePage(rowId, { props: ganttProps(fresh, cfg, a, b, sp.milestone) }));
        });
      }

      /* Drag along the lane of a row without dates to give it some (a click
         gives it that one day). */
      function drawSpan(e, rowEl) {
        const rowId = rowEl.dataset.rowId;
        const lane = rowEl.querySelector(".db-gt-lane");
        const start = dayAt(lane, e.clientX);
        let a = start;
        let b = start;
        e.preventDefault();
        ghost.classList.add("active");
        lane.append(ghost);
        root.classList.add("db-gt-dragging");
        const show = () => {
          ghost.style.left = `${X(a)}px`;
          ghost.style.width = `${(b - a + 1) * px}px`;
          showTip(lane, a, b, X(a));
        };
        show();
        gesture(e, lane, (clientX) => {
          const scrolling = edgeScroll(clientX);
          const d = dayAt(lane, clientX);
          a = Math.min(start, d);
          b = Math.max(start, d);
          show();
          return scrolling;
        }, (cancel) => {
          ghost.classList.remove("active");
          ghost.remove();
          tip.remove();
          const row = App.store.page(rowId);
          if (cancel || !row) return;
          safely(() => App.store.updatePage(rowId, { props: ganttProps(row, cfg, a, b) }));
        });
      }

      body.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || ctx.readOnly()) return;
        const rowEl = e.target.closest(".db-gt-row");
        if (!rowEl || rowEl.classList.contains("editing")) return;
        const node = e.target.closest(".db-gt-bar, .db-gt-ms");
        if (node) {
          const edge = e.target.closest(".db-gt-h");
          dragBar(e, node, rowEl, edge ? edge.dataset.edge : "move");
        } else if (rowEl.classList.contains("db-gt-undated") && e.target.closest(".db-gt-lane")) {
          drawSpan(e, rowEl);
        }
      });
      // With a mouse, a row without dates shows where a click would put them.
      body.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse" || ghost.classList.contains("active")) return;
        const lane = e.target.closest(".db-gt-undated .db-gt-lane");
        if (!lane || e.target.closest(".db-gt-tip")) { ghost.remove(); return; }
        const d = dayAt(lane, e.clientX);
        ghost.style.left = `${X(d)}px`;
        ghost.style.width = `${px}px`;
        if (ghost.parentNode !== lane) lane.append(ghost);
      });
      body.addEventListener("pointerleave", () => { if (!ghost.classList.contains("active")) ghost.remove(); });

      return [el("div", { class: "db-gantt-wrap" }, scroller,
        el("button", { class: "db-new-row db-gt-new", type: "button", onclick: () => ctx.addGanttRow(view) },
          el("span", { html: icon("plus", 15) }), el("span", { text: "New" })),
        ganttCount(rows.length))];
    }

    const ganttCount = (n) => el("div", { class: "db-count" }, el("span", { class: "db-count-label", text: "Count" }), el("span", { class: "db-count-n", text: String(n) }));

    draw();
    return {
      el: root,
      destroy() {
        if (ctx.destroyed) return;
        if (ctx.editing) ctx.editing.finish(true);
        ctx.destroyed = true;
        dropGantt();
        off();
        target.replaceChildren();
      },
    };
  }

  /* The small values on a card or list line; null when there is nothing. */
  function compactProps(r, props, cls = "db-card-props") {
    const wrap = el("div", { class: cls });
    for (const p of props) {
      const v = getValue(r, p);
      // Empty values are left out, and an unchecked box counts as empty: a
      // "☐ Paid" on every card is noise, a "☑ Paid" is information.
      if (isEmpty(p, v)) continue;
      if (p.type === "checkbox") {
        wrap.append(el("span", { class: "db-cprop db-cprop-checkbox", title: p.name }, checkBox(true), el("span", { class: "db-cprop-label", text: p.name })));
        continue;
      }
      wrap.append(el("span", { class: `db-cprop db-cprop-${p.type}`, title: `${p.name}: ${p.type === "date" ? fmtDate(v) : COMPUTED.has(p.type) ? fmtInstant(v) : textOf(p, v)}` }, renderValue(p, v)));
    }
    return wrap.childNodes.length ? wrap : null;
  }

  /* Type a new card's title right where it is (board, list, gallery). */
  function cardTitleEditor(host, holder, rowId) {
    if (host.readOnly()) return;
    const row = App.store.page(rowId);
    if (!row) return;
    const container = holder.closest("[data-row-id]");
    const input = el("input", { class: "db-card-input", type: "text", placeholder: "Untitled", "aria-label": "Title" });
    input.value = row.title || "";
    const draggable = container.getAttribute("draggable");
    const session = { cell: holder, finish: null };
    let done = false;
    session.finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) safely(() => setValue(rowId, { id: "title", type: "title" }, input.value));
      container.classList.remove("editing");
      if (draggable) container.setAttribute("draggable", draggable);
      const fresh = App.store.page(rowId);
      holder.replaceChildren(fresh && fresh.title ? fresh.title : "Untitled");
      holder.classList.toggle("untitled", !(fresh && fresh.title));
      endEdit(host, session);
    };
    beginEdit(host, session);
    container.classList.add("editing");
    container.removeAttribute("draggable");
    holder.replaceChildren(input);
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); session.finish(true); }
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("blur", () => session.finish(true));
  }

  // --- the properties panel of a row page ------------------------------------------------------
  /* The parent database's properties for one row, as an editable key/value
     list. Keeps itself current, and lets go of the bus once it has been
     taken out of the document. */
  function propertiesPanel(rowId, { readOnly = false } = {}) {
    const node = el("div", { class: "db-props-panel" });
    let wasConnected = false;
    let off = null;
    const host = makeHost(null, readOnly, () => render());
    host.pendingPropMenu = null;

    function render() {
      if (host.destroyed) return;
      const row = App.store.page(rowId);
      const parent = row && row.parent_id ? App.store.page(row.parent_id) : null;
      if (!row || row.deleted || !parent || parent.kind !== "database") {
        node.replaceChildren();
        node.hidden = true;
        host.dbId = parent ? parent.id : null;
        return;
      }
      node.hidden = false;
      host.dbId = parent.id;
      const s = schemaOf(parent);
      const ro = host.readOnly();
      const rowsEl = [];
      for (const p of s.properties) {
        if (p.id === "title") continue;
        const key = el(ro ? "div" : "button", {
          class: "db-prop-key", type: ro ? null : "button", title: ro ? p.name : `${p.name} (click for options)`, dataset: { propId: p.id },
          onclick: ro ? null : (e) => propertyMenu(host, e.currentTarget, p.id, {}),
        }, el("span", { class: "db-prop-key-icon", html: icon(typeIcon(p.type), 15) }), el("span", { class: "db-prop-key-name", text: p.name || typeLabel(p.type) }));
        const val = el("div", {
          class: `db-prop-val db-td-${p.type}${ro || COMPUTED.has(p.type) ? " db-td-static" : ""}`,
          dataset: { rowId, propId: p.id, type: p.type, placeholder: ro || COMPUTED.has(p.type) ? "" : "Empty" },
        });
        fillCell(host, val, row, p);
        rowsEl.push(el("div", { class: "db-prop-row" }, key, val));
      }
      const extra = [];
      if (!ro) {
        extra.push(el("button", {
          class: "db-prop-add", type: "button",
          onclick: (e) => addPropertyMenu(host, e.currentTarget, (p) => { host.pendingPropMenu = p.id; requestRender(host); }),
        }, el("span", { html: icon("plus", 15) }), el("span", { text: "Add a property" })));
      }
      node.replaceChildren(...rowsEl, ...extra);
      if (host.pendingPropMenu) {
        const id = host.pendingPropMenu;
        host.pendingPropMenu = null;
        const key = node.querySelector(`.db-prop-key${sel("data-prop-id", id)}`);
        if (key) propertyMenu(host, key, id, { focusName: true });
      }
    }

    node.addEventListener("click", (e) => {
      const val = e.target.closest(".db-prop-val");
      if (!val || val.classList.contains("editing") || host.readOnly()) return;
      startEdit(host, val, rowId, val.dataset.propId);
    });
    for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "copy", "cut"]) {
      node.addEventListener(type, (e) => {
        const t = e.target;
        if (t && t.matches && t.matches("input, textarea, select")) e.stopPropagation();
      });
    }
    host.nextCell = (cell, back) => {
      const cells = [...node.querySelectorAll(".db-prop-val")].filter((c) => INPUT_TYPES.has(c.dataset.type) || c === cell);
      const i = cells.indexOf(cell);
      return i < 0 ? null : cells[i + (back ? -1 : 1)] || null;
    };

    function destroy() {
      if (host.destroyed) return;
      if (host.editing) host.editing.finish(true);
      host.destroyed = true;
      if (off) off();
      off = null;
    }

    off = App.bus.on("store:change", (ev) => {
      if (node.isConnected) wasConnected = true;
      else if (wasConnected) { destroy(); return; }
      const pages = ev.pages || new Set();
      let hit = pages.has(rowId) || (host.dbId && pages.has(host.dbId));
      if (!hit && ev.blocks && ev.blocks.size && host.dbId) {
        const parent = App.store.page(host.dbId);
        if (parent && schemaOf(parent).properties.some((p) => p.type === "last_edited_time")) {
          for (const bid of ev.blocks) { const b = App.store.block(bid); if (b && b.page_id === rowId) { hit = true; break; } }
        }
      }
      if (hit) requestRender(host);
    });

    render();
    node.destroy = destroy;
    return node;
  }

  return {
    defaultSchema,
    ganttSchema,
    mount,
    propertiesPanel,
    PROPERTY_TYPES,
    // Extras for other modules: the view types and helpers to read a schema.
    VIEW_TYPES,
    typeIcon,
    schemaOf,
  };
})();
