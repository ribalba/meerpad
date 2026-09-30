# meerpad desktop

A thin Electron wrapper that opens meerpad in a native window. It is a shell
around a **running server**, the hosted [meerpad.com](https://meerpad.com) by
default or your own, and bundles no backend.

The same shape as meerato's shell, because the two are hosted the same way:
a persistent login of its own (separate from your browser), outbound links in
the system browser, and sign-in by `meerpad://` deep link. The window chrome,
menu and retry screen match meerpic's, meercal's and meerail's, which live on
the same desktop.

## Run in development

```bash
cd electron
npm install
npm start                                     # loads https://meerpad.com/app
MEERPAD_URL=http://localhost:8050 npm start   # a local server (`make up` in the repo)
```

`make desktop` in the repo root does the second line for you.

## Build and install

```bash
npm run dist        # -> dist/  (Linux .AppImage/.deb, macOS .dmg/.zip, Windows .exe)
make distinstall    # build, then register with the desktop (KDE / GNOME / macOS)
make distuninstall  # remove it again
```

On Linux `make distinstall` copies the AppImage to `~/.local/share/meerpad/`,
links it as `~/.local/bin/meerpad`, writes `meerpad.desktop` with the icon, and
makes it the handler for `meerpad://` links (`xdg-mime`), which is what
desktop sign-in needs. `make distinstall MEERPAD_URL=http://localhost:8050`
bakes another server into the desktop entry.

## How sign-in works

meerpad signs you in with an emailed link and a code (meerato's flow). In a
desktop window the normal `https://.../api/auth/callback` link would open your
**system browser**, and the session cookie would land there instead of here.
So:

1. The page sees `window.meerpadDesktop` (from `preload.js`) and asks for its
   sign-in email with `client: "desktop"`.
2. The server mails a `meerpad://login?token=...` link instead of the web one
   (`app/routers/auth.py`).
3. Clicking it starts or focuses this app, which loads the real callback URL
   **inside its window**, so the cookie is stored here.

The code in the same email always works too: type it into the window. That is
the way in when the mail is read on another device, where a `meerpad://` link
has no app to go to.

Only `meerpad://login?token=...` is acted on, and only to drive that callback.
A link that arrives while the app is closed is kept and used once the window
exists (on Linux and Windows it comes in on the command line, on macOS as an
`open-url` event).

## Offline

The shell adds nothing here, on purpose: the web app's service worker serves
the app and its IndexedDB mirror holds your pages, and both live in the
shell's persistent partition (`persist:meerpad`). Once it has loaded one time,
the window opens without a network, shows your pages and queues edits until
the server is back. The retry screen is for a first start with no network.

## What else the shell adds over a browser tab

- **A window of its own**, with the app's icon in the dock and the task bar.
- **Back and Forward** (Alt+Left/Right, Cmd+[ and Cmd+] on macOS), since
  there is no browser toolbar and page links make a history.
- **Spelling suggestions and Cut/Copy/Paste on right-click**, which Electron
  does not show by default.
- **Outbound links**, published websites included, open in the system browser;
  files from the server (a PDF, an image at full size) open in a window here,
  where the session cookie is.
- **Permissions** (clipboard, notifications) only for the server's own pages.

The app icon is `build/icon.png` (1024x1024), made from the meerpad logo.
