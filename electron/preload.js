/* The bridge between the page and the desktop shell, and it is almost empty on
 * purpose: the page is a remote origin and gets no Node, no IPC and no file
 * access from here.
 *
 * What it is for: the page detects the shell by the presence of
 * `window.meerpadDesktop`, and when it is there it asks for its sign-in email
 * with `client: "desktop"` (POST /api/auth/login). The server then mails a
 * `meerpad://login?token=...` link, which main.js turns into a sign-in inside
 * this window instead of in whatever browser the mail client would open.
 */
const { contextBridge } = require("electron");

// main.js passes its own version as an argument; a sandboxed preload cannot
// read package.json, but it does see its process's argv.
const PREFIX = "--meerpad-shell-version=";
const versionArg = process.argv.find((arg) => arg.startsWith(PREFIX));

contextBridge.exposeInMainWorld("meerpadDesktop", {
  // The shape of this bridge, for the page to check against if it ever grows.
  version: 1,
  // The shell's release, from electron/package.json.
  shellVersion: versionArg ? versionArg.slice(PREFIX.length) : null,
  platform: process.platform,
});
