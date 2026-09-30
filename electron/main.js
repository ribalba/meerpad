/* meerpad desktop shell.
 *
 * A thin Electron wrapper around a meerpad server, in meerato's shape rather
 * than meerpic's: the server is a hosted one (https://meerpad.com unless told
 * otherwise), so the shell keeps its login in a persistent session of its own,
 * finishes the emailed sign-in inside the window through a `meerpad://` deep
 * link (see handleDeepLink), and opens every other site in the system browser.
 *
 * Offline is the web app's own business, not the shell's: its service worker
 * serves the app and its IndexedDB mirror holds your pages, both kept in the
 * persistent partition below, so a window opened on a train shows your notes
 * and queues your edits until the network is back. The retry screen here is
 * for the one case that cannot work: a first start with no network, before
 * anything was cached.
 *
 * Point it at another server with MEERPAD_URL:
 *   MEERPAD_URL=http://localhost:8050 npm start
 */
const { app, BrowserWindow, Menu, nativeTheme, session, shell } = require("electron");
const path = require("path");

const APP_URL = (process.env.MEERPAD_URL || "https://meerpad.com").replace(/\/+$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;
// /app, not /: "/" is the landing page for a signed-out visitor, and /app is
// always the app shell, which works offline and sends a signed-out window to
// /login itself (app/main.py).
const START_URL = `${APP_URL}/app`;
const PROTOCOL = "meerpad";
// Named, so cookies, the service worker and the offline copy of your pages
// survive a restart. Separate from your browser's: signing in here does not
// sign the browser in, and the other way round.
const PARTITION = "persist:meerpad";
const ICON = path.join(__dirname, "build", "icon.png");

// Linux shells match a window to its installed icon by name: X11 by WM_CLASS
// (from the app name), Wayland by app_id (the executable, or --class in the
// start script) against StartupWMClass in meerpad.desktop. Same as meerato.
app.setName("meerpad");

let mainWindow = null;
// A sign-in link that arrived before there was a window to put it in: the
// first launch on Windows and Linux carries it in argv, and macOS can deliver
// open-url before the app is ready. meerato's shell drops the first case.
let pendingLink = findLink(process.argv);

function findLink(argv) {
  return (argv || []).find((a) => typeof a === "string" && a.startsWith(`${PROTOCOL}://`)) || null;
}

// Absolute URLs only, no base to resolve against: with one, "" and the
// "null" origin of a sandboxed frame or a data: page would both resolve to
// this server and pass.
function isInternal(targetUrl) {
  try {
    return new URL(targetUrl).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

// Only schemes a page link may carry (docs/DESIGN.md: http, https, mailto).
// shell.openExternal hands the string to the OS, and the OS will happily run
// whatever a file:// or custom-scheme URL names.
function openExternal(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return;
  }
  if (["http:", "https:", "mailto:"].includes(parsed.protocol)) shell.openExternal(parsed.toString());
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 480,
    // The page paints its own theme; this only decides the colour of the
    // frame before it does, so a dark desktop does not flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff",
    title: "meerpad",
    icon: ICON,
    webPreferences: {
      // Loading a remote origin: keep the page away from Node entirely.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      partition: PARTITION,
      spellcheck: true,
      // Read back by preload.js, which in a sandbox cannot open package.json.
      additionalArguments: [`--meerpad-shell-version=${app.getVersion()}`],
    },
  });

  if (pendingLink) {
    const link = pendingLink;
    pendingLink = null;
    handleDeepLink(link);
  } else {
    mainWindow.loadURL(START_URL);
  }

  // Unreachable server and nothing cached: a retry screen instead of a blank
  // window. -3 is the aborted load every redirect produces; a failing iframe
  // (an embedded video while offline) is the page's problem, not a reason to
  // replace the whole app.
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !isInternal(validatedURL || APP_URL)) return;
    mainWindow.loadURL(errorPage());
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

/* Navigation rules for every web contents, the main window's and any child
 * window's alike (Electron's security checklist: a rule set on one window
 * only is a rule a child window does not have). */
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // A file opened in a new tab (a PDF, an image at full size) lives on this
    // server and needs this session's cookie: a window of its own, in here.
    // Anything else, a published website included, goes to the browser.
    if (isInternal(url)) {
      return { action: "allow", overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true } };
    }
    openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (e, url) => {
    if (url.startsWith(`${PROTOCOL}://`)) {
      e.preventDefault();
      handleDeepLink(url);
    } else if (!isInternal(url)) {
      e.preventDefault();
      openExternal(url);
    }
  });

  contents.on("context-menu", (_e, params) => showContextMenu(contents, params));
});

/* Electron shows no context menu at all by default, which in an editor means
 * no spelling suggestions and no Paste on right-click. This is the browser's
 * menu, reduced to what a notes app needs. A page that draws its own (a block
 * menu) cancels the event, and then this never runs. */
function showContextMenu(contents, params) {
  const groups = [];
  if (params.misspelledWord) {
    groups.push([
      ...params.dictionarySuggestions.slice(0, 5).map((word) => ({
        label: word,
        click: () => contents.replaceMisspelling(word),
      })),
      {
        label: "Add to dictionary",
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
    ]);
  }
  if (params.linkURL && !isInternal(params.linkURL)) {
    groups.push([{ label: "Open link in browser", click: () => openExternal(params.linkURL) }]);
  }
  if (params.isEditable) {
    groups.push([{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }]);
  } else if (params.selectionText) {
    groups.push([{ role: "copy" }]);
  }
  if (!groups.length) return;
  const template = groups.flatMap((group, i) => (i ? [{ type: "separator" }, ...group] : group));
  Menu.buildFromTemplate(template).popup();
}

/* Permissions a page asks for (the clipboard, for pasting an image into a
 * page; notifications): granted to this server's pages, refused to anything
 * else that ends up in a frame here, except fullscreen, which an embedded
 * video player asks for and nobody minds. */
function setPermissions() {
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === "fullscreen" || isInternal(details.requestingUrl || contents.getURL()));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permission === "fullscreen" || isInternal(requestingOrigin));
}

// --- Sign-in by deep link ------------------------------------------------------
// The login email, when requested from this shell (the page sends
// client: "desktop", see app/routers/auth.py), links to
//   meerpad://login?token=<token>
// The OS routes that here, and sign-in finishes by loading the ordinary
// callback URL inside this window, so the session cookie lands in this app's
// partition rather than in the browser the mail client would have opened.
function handleDeepLink(link) {
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    return;
  }
  // Only ever the login action, and only to drive the callback: a link is
  // something anybody can put in a mail.
  if (parsed.protocol !== `${PROTOCOL}:` || parsed.hostname !== "login") return;
  const token = parsed.searchParams.get("token");
  if (!token) return;
  if (!mainWindow) {
    pendingLink = link;
    return;
  }
  mainWindow.loadURL(`${APP_URL}/api/auth/callback?token=${encodeURIComponent(token)}`);
  showWindow();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function errorPage() {
  const retry = JSON.stringify(START_URL);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <style>
      body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",sans-serif;background:#f6f8fa;color:#1f2328}
      .card{text-align:center;max-width:460px;padding:2rem}
      h1{font-size:1.3rem;margin:0 0 .5rem}p{color:#57606a;line-height:1.5}
      button{font:inherit;font-weight:600;cursor:pointer;border:none;border-radius:8px;
        padding:.7rem 1.3rem;background:#1d6ff2;color:#fff;margin-top:1rem}
      code{background:#e6e8eb;padding:.15rem .4rem;border-radius:5px}
      @media (prefers-color-scheme: dark){body{background:#191919;color:#e6e6e6}
        p{color:#a0a4a8}code{background:#2b2b2b}}
    </style></head><body><div class="card">
      <h1>Can't reach meerpad</h1>
      <p>Couldn't connect to <code>${escapeHtml(APP_ORIGIN)}</code>. Once the app
      has loaded here one time, your pages open without a network too; this
      looks like the first start, or the server is down.</p>
      <button onclick="location.href=${escapeHtml(retry)}">Retry</button>
    </div>
    <script>addEventListener("online", () => { location.href = ${retry}; });</script>
    </body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function goBack() {
  const history = mainWindow && mainWindow.webContents.navigationHistory;
  if (history && history.canGoBack()) history.goBack();
}

function goForward() {
  const history = mainWindow && mainWindow.webContents.navigationHistory;
  if (history && history.canGoForward()) history.goForward();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // No accelerator on Home, unlike meerato's and meerpic's
        // Ctrl+Shift+H: in Notion that key re-applies the last highlight
        // colour, and a menu accelerator would take it from the editor.
        { label: "Home", click: () => mainWindow && mainWindow.loadURL(START_URL) },
        // There is no browser toolbar, and page links make a history worth
        // walking back through. The keys are the browsers' own.
        { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: goBack },
        { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: goForward },
        { type: "separator" },
        { role: "reload" }, { role: "forceReload" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" }, { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ]));
}

function registerProtocol() {
  if (process.defaultApp && process.argv.length >= 2) {
    // `electron .` during development: point the scheme at this checkout.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

// Single instance: a second launch (a deep link opened on Windows or Linux)
// hands its argv to the running app instead of starting another.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = findLink(argv);
    if (link) handleDeepLink(link);
    showWindow();
  });

  // macOS delivers deep links here, possibly before the window exists.
  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (mainWindow) handleDeepLink(url);
    else pendingLink = url;
  });

  app.whenReady().then(() => {
    registerProtocol();
    setPermissions();
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
