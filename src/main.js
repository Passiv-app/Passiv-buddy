// The Passiv desktop buddy.
//
// Passiv itself stays in the browser. This small app adds:
//  - the buddy: a see-through layer over every screen, always on top (full-screen apps too), that clicks go
//    straight through. A small icon you can drag anywhere sits on the main screen, and what Passiv has to say lands
//    beside it as stacked sticky notes (some tidy themselves away). The coach's to-dos sit on the front too.
//  - hold Control + Option (Mac) or Ctrl + Alt (Windows) in any app to talk; let go to send. Add S to hide or show it, and Q to quit.
//  - a small Passiv window (ai.passiv.app/buddy) to sign in, set up, and talk or type when there's more to say.
//
// Almost everything comes from Passiv (Base44): the layer and the typing box (served by its public buddyFiles function,
// because the app is private and Base44 won't hand out files from public/ before someone signs in), the buddy window
// (/buddy) and the brain behind it. Publishing in Base44 updates every installed buddy the next time it starts. Only this
// shell needs a new download, and base44/shared/buddyVersion.ts in Base44 tells every buddy when one is out.

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const { execFile, spawn } = require("child_process");
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: 120000 }, (e, out) => (e ? rej(e) : res(String(out)))));
const path = require("path");
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, globalShortcut, systemPreferences, nativeImage, shell, session, Notification, net, protocol } = require("electron");

// Only ever talks to Passiv over https. The address can be changed for testing only when started with PASSIV_DEV=1.
const DEV = process.env.PASSIV_DEV === "1";
const APP_URL = ((DEV && process.env.PASSIV_URL) || "https://ai.passiv.app").replace(/\/+$/, "");
if (!DEV && !APP_URL.startsWith("https://")) { console.error("[passiv] refusing to start without https"); process.exit(1); }
const APP_ORIGIN = new URL(APP_URL).origin;
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
if (IS_WIN) app.setAppUserModelId("app.passiv.desktop"); // lets Windows show our notifications under the Passiv name
const KEYS = IS_MAC ? "⌃⌥" : "Ctrl+Alt";
// Sign-in can pass through these on its way back to Passiv.
const AUTH_HOSTS = [/(^|\.)passiv\.app$/, /(^|\.)base44\.(app|com)$/, /^accounts\.google\.com$/, /^login\.microsoftonline\.com$/, /^appleid\.apple\.com$/, ...(DEV ? [/^localhost$/, /^127\.0\.0\.1$/] : [])];
const okHost = (u) => { try { const x = new URL(u); return (x.protocol === "https:" || (DEV && x.protocol === "http:")) && AUTH_HOSTS.some((r) => r.test(x.hostname)); } catch { return false; } };
// The only things we ever hand to the operating system to open: web pages and mail links. Never files, never other programs.
const openSafe = (u) => { try { const x = new URL(String(u)); if (x.protocol === "https:" || x.protocol === "mailto:") { shell.openExternal(x.toString()); return true; } } catch { /* not a link */ } return false; };
// Messages only count when they come from Passiv's own page, in its main frame, not from anything else that got loaded.
// A page's origin, as an address. (A made-up scheme like passiv-ui:// has an "opaque" origin that reads as "null", so build it by hand.)
const originOf = (u) => { const x = new URL(u); return x.protocol === `${UI_SCHEME}:` ? `${UI_SCHEME}://${x.host}` : x.origin; };
const trusted = (e, origin = APP_ORIGIN) => { try { const f = e.senderFrame; return !!f && f === e.sender.mainFrame && originOf(f.url) === origin; } catch { return false; } };
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
app.enableSandbox();
const SIGN_IN = /^\/(login|register|mfa|forgot-password|reset-password|alpha|setup|legal)/;
const WEB_ARGS = (origin = APP_ORIGIN) => [`--passiv-origin=${origin}`];

// ---------- the buddy's own pages (the layer over the screen, the typing box) ----------
// Passiv is private, so its files can't be loaded in a window before anyone has signed in. This app fetches them itself from
// the public buddyFiles function and hands them to its own windows under a scheme only this app understands, with its own
// security rules. A copy is kept on this computer so the buddy still starts offline.
const UI_SCHEME = "passiv-ui";
const UI_ORIGIN = `${UI_SCHEME}://buddy`;
const UI_TYPES = { "layer.html": "text/html; charset=utf-8", "layer.css": "text/css; charset=utf-8", "layer.js": "text/javascript; charset=utf-8", "ask.html": "text/html; charset=utf-8", "ask.css": "text/css; charset=utf-8", "ask.js": "text/javascript; charset=utf-8" };
const UI_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
protocol.registerSchemesAsPrivileged([{ scheme: UI_SCHEME, privileges: { standard: true, secure: true } }]);
const uiDir = () => path.join(app.getPath("userData"), "ui");
const uiMemory = new Map(); // name -> { text, at }
async function uiFile(name) {
  const hit = uiMemory.get(name);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.text;
  try {
    const res = await net.fetch(`${APP_URL}/functions/buddyFiles?f=${encodeURIComponent(name)}&v=${encodeURIComponent(app.getVersion())}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    const text = res.ok ? await res.text() : "";
    // A real page is never empty or huge. Anything else (an error message, a sign-in page) is not used.
    if (!text || text.length > 200000 || /^\s*\{\s*"error_type"/.test(text)) throw new Error("not a page");
    uiMemory.set(name, { text, at: Date.now() });
    try { fs.mkdirSync(uiDir(), { recursive: true }); fs.writeFileSync(path.join(uiDir(), name), text); } catch { /* a copy is a bonus */ }
    return text;
  } catch {
    if (hit) return hit.text;
    try { return fs.readFileSync(path.join(uiDir(), name), "utf8"); } catch { return null; }
  }
}
function serveUi() {
  protocol.handle(UI_SCHEME, async (req) => {
    let u; try { u = new URL(req.url); } catch { return new Response("Bad request", { status: 400 }); }
    const name = u.pathname.replace(/^\//, "");
    if (u.host !== "buddy" || !Object.prototype.hasOwnProperty.call(UI_TYPES, name)) return new Response("Not found", { status: 404 });
    const text = await uiFile(name);
    if (text === null) return new Response("The buddy could not load. Check your internet connection.", { status: 503 });
    return new Response(text, { headers: { "content-type": UI_TYPES[name], "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": UI_CSP } });
  });
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------- what this computer remembers ----------
const STATE_FILE = () => path.join(app.getPath("userData"), "buddy-state.json");
let state = { onboarded: false, buddyOn: true, size: "small" };
function loadState() { try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) }; } catch { /* first run */ } }
function saveState() { try { fs.writeFileSync(STATE_FILE(), JSON.stringify(state)); } catch { /* fine */ } }

let panel = null;
let tray = null;
let quitting = false;
let autoShown = false; // the window came up by itself to sign in or set up, so it can tuck away again after
const overlays = new Map(); // display id -> BrowserWindow
let cache = { state: null, todos: [] };
// Nothing works until someone is signed in to a Passiv account: no buddy, no notes, no shortcuts.
let authed = false;
let askWin = null;
let update = null; // { latest, url, notes, required }

const buddyPayload = () => ({ on: state.buddyOn && authed, size: state.size });
function setAuthed(on) {
  if (authed === on) return;
  authed = on;
  if (!on) {
    // Signed out: take everything private off the screen and out of memory.
    cache = { state: null, todos: [] };
    talking = false;
    toOverlays("overlay:notes", { op: "clear" });
    toOverlays("overlay:todos", []);
    if (askWin && !askWin.isDestroyed()) askWin.hide();
  }
  toOverlays("overlay:buddy", buddyPayload());
  buildTrayMenu();
}

// ---------- the buddy's window ----------
function createPanel() {
  panel = new BrowserWindow({
    width: 420, height: 700, minWidth: 360, minHeight: 520,
    title: "Passiv",
    backgroundColor: "#faf7f2",
    show: false,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload-app.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      additionalArguments: WEB_ARGS(),
      // Keeps listening, reminders and replies working while the window is hidden.
      backgroundThrottling: false,
    },
  });
  panel.loadURL(`${APP_URL}/buddy`);
  panel.once("ready-to-show", () => { if (!state.onboarded) { autoShown = true; showPanel(); } });

  // Passiv pages open in the coach's browser; sign-in pop-ups stay in the app.
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (okHost(url) && !url.startsWith(APP_ORIGIN)) return { action: "allow" };
    openSafe(url);
    return { action: "deny" };
  });
  panel.webContents.on("will-navigate", (e, url) => {
    if (!okHost(url)) { e.preventDefault(); openSafe(url); }
  });
  // Signed out (or not set up): bring the window up so they can sign in.
  const watch = (_e, url) => {
    try {
      const u = new URL(url);
      // On a sign-in page means nobody is signed in (first run, signed out, or the session ran out): lock everything.
      if (u.origin === APP_ORIGIN && SIGN_IN.test(u.pathname)) { setAuthed(false); if (!panel.isVisible()) { autoShown = true; showPanel(); } }
    } catch { /* fine */ }
  };
  panel.webContents.on("did-navigate", watch);
  panel.webContents.on("did-navigate-in-page", watch);
  // No connection yet: try again shortly.
  panel.webContents.on("did-fail-load", (_e, code, _d, url, isMain) => { if (isMain && code !== -3) setTimeout(() => panel && !panel.isDestroyed() && panel.loadURL(`${APP_URL}/buddy`), 15000); });

  panel.on("close", (e) => { if (quitting) return; e.preventDefault(); panel.hide(); });
  // Whether the chat is in view decides if the buddy also says answers in its bubble.
  const relay = () => { if (cache.state) toOverlays("overlay:state", withOpen(cache.state)); };
  panel.on("show", relay); panel.on("hide", relay); panel.on("focus", relay); panel.on("blur", relay);
}

function showPanel(tab) {
  if (!panel || panel.isDestroyed()) createPanel();
  if (panel.isMinimized()) panel.restore();
  if (!panel.isVisible()) {
    // A menu bar app on a Mac (top right); on Windows the tray is at the bottom right, so it opens up from there.
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w, h] = panel.getSize();
    panel.setPosition(Math.round(wa.x + wa.width - w - 16), Math.round(IS_WIN ? wa.y + wa.height - h - 12 : wa.y + 12));
  }
  panel.show();
  if (IS_MAC) app.focus({ steal: true });
  panel.focus();
  if (tab) toPanel({ type: "open", tab });
}
const toPanel = (cmd) => { if (panel && !panel.isDestroyed()) panel.webContents.send("desktop:command", cmd); };
const withOpen = (s) => ({ ...s, open: !!(panel && panel.isVisible() && panel.isFocused()) });

// ---------- the layer over every screen ----------
function createOverlay(display) {
  const { x, y, width, height } = display.bounds;
  const primary = display.id === screen.getPrimaryDisplay().id;
  const win = new BrowserWindow({
    // One pixel short on Windows: a transparent window exactly the size of the screen gets treated as full screen,
    // which can hide the taskbar or flicker. Nobody can see the difference.
    x, y, width, height: IS_WIN ? height - 1 : height,
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload-overlay.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      additionalArguments: WEB_ARGS(UI_ORIGIN),
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  // The layer comes from Passiv (through the buddyFiles function), so it changes when Passiv is published.
  const load = () => win.loadURL(`${UI_ORIGIN}/layer.html?primary=${primary ? 1 : 0}&v=${app.getVersion()}`);
  load();
  win.webContents.on("did-fail-load", (_e, code, _d, _u, isMain) => { if (isMain && code !== -3) setTimeout(() => !win.isDestroyed() && load(), 20000); });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("did-finish-load", () => {
    if (authed && cache.state) win.webContents.send("overlay:state", withOpen(cache.state));
    win.webContents.send("overlay:buddy", buddyPayload());
    if (update) win.webContents.send("overlay:update", updatePayload());
    if (authed) win.webContents.send("overlay:todos", cache.todos);
    win.showInactive();
  });
  overlays.set(display.id, win);
}

function rebuildOverlays() {
  for (const w of overlays.values()) if (!w.isDestroyed()) w.destroy();
  overlays.clear();
  for (const d of screen.getAllDisplays()) createOverlay(d);
}
const updatePayload = () => (update ? { latest: update.latest, notes: update.notes } : null);
const toOverlays = (channel, data) => { for (const w of overlays.values()) if (!w.isDestroyed()) w.webContents.send(channel, data); };

// Windows lets other always-on-top windows (and the taskbar) sneak in front now and then, so the layer re-asserts itself.
function keepOnTop() {
  if (!IS_WIN) return;
  setInterval(() => { for (const w of overlays.values()) if (!w.isDestroyed() && w.isVisible()) w.moveTop(); }, 4000);
}

// ---------- hold to talk, from any app ----------
let talking = false;
let hooked = false;
const setTalking = (on, phase) => {
  if (!authed) { talking = false; if (on) showPanel(); return; } // no account, no listening
  talking = on; toPanel({ type: "talk", phase });
};
const toggleTalk = () => setTalking(!talking, talking ? "stop" : "start");

// ---------- the quick typing box: a small bar in the middle of the screen ----------
function createAsk() {
  askWin = new BrowserWindow({
    width: 700, height: 130, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload-ask.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false,
      additionalArguments: WEB_ARGS(UI_ORIGIN),
    },
  });
  askWin.setAlwaysOnTop(true, "screen-saver");
  if (IS_MAC) askWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  askWin.loadURL(`${UI_ORIGIN}/ask.html?v=${app.getVersion()}`);
  askWin.webContents.on("will-navigate", (e) => e.preventDefault());
  askWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  askWin.on("blur", () => { if (askWin && !askWin.isDestroyed()) askWin.hide(); });
  askWin.on("closed", () => { askWin = null; });
}
function openAsk() {
  if (!authed) { showPanel(); return; }
  if (!askWin || askWin.isDestroyed()) createAsk();
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w, h] = askWin.getSize();
  askWin.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + (wa.height - h) / 2));
  askWin.show();
  if (IS_MAC) app.focus({ steal: true });
  askWin.focus();
  askWin.webContents.send("ask:open");
}

function setBuddyOn(on) {
  state.buddyOn = on; saveState();
  if (!on && !state.hideTold && Notification.isSupported()) {
    state.hideTold = true; saveState();
    new Notification({ title: "Buddy hidden", body: `Bring it back from the ${IS_MAC ? "menu bar" : "system tray"} icon, or press ${KEYS}+S.`, silent: true }).show();
  }
  toOverlays("overlay:buddy", buddyPayload());
  toPanel({ type: "buddy", patch: { on } });
  buildTrayMenu();
}

function hookKeys() {
  if (hooked) return true;
  // Mac needs Accessibility switched on once to hear keys in other apps. The welcome screen walks them through it.
  if (IS_MAC && !systemPreferences.isTrustedAccessibilityClient(false)) return false;
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    const CTRL = new Set([UiohookKey.Ctrl, UiohookKey.CtrlRight]);
    // On Windows, AltGr is Ctrl + right Alt at once (it types characters like @ and é on many keyboards), so only the left Alt counts there.
    const ALT = new Set(IS_WIN ? [UiohookKey.Alt] : [UiohookKey.Alt, UiohookKey.AltRight]);
    const down = new Set();
    let timer = null;
    const held = () => ({ ctrl: [...down].some((k) => CTRL.has(k)), alt: [...down].some((k) => ALT.has(k)), other: [...down].some((k) => !CTRL.has(k) && !ALT.has(k)) });
    uIOhook.on("keydown", (e) => {
      down.add(e.keycode);
      const h = held();
      if (h.ctrl && h.alt && e.keycode === UiohookKey.S) {
        clearTimeout(timer); timer = null;
        if (talking) setTalking(false, "cancel");
        setBuddyOn(!state.buddyOn);
        return;
      }
      if (h.ctrl && h.alt && !h.other) {
        if (!timer && !talking) timer = setTimeout(() => { timer = null; setTalking(true, "start"); }, 260);
        return;
      }
      // Another key with them: a shortcut, not a hold.
      if (timer) { clearTimeout(timer); timer = null; }
      if (talking && h.other) setTalking(false, "cancel");
    });
    uIOhook.on("keyup", (e) => {
      down.delete(e.keycode);
      if (CTRL.has(e.keycode) || ALT.has(e.keycode)) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (talking) setTalking(false, "stop");
      }
    });
    uIOhook.start();
    hooked = true;
    globalShortcut.unregister("Control+Alt+S");
  } catch (err) {
    console.error("[passiv] key listener unavailable, using the fallback shortcuts", err);
  }
  return hooked;
}

function startKeys() {
  hookKeys();
  // Mac: the moment Accessibility is switched on, start hearing the held keys (no restart needed).
  const retry = setInterval(() => { if (hooked) clearInterval(retry); else hookKeys(); }, 3000);
  // Always there, and they work before Mac's Accessibility switch too:
  //   Control+Alt+Space  the typing box, in the middle of the screen
  //   Control+Alt+T      tap once to talk, tap again to send (holding Control+Alt works too)
  globalShortcut.register("Control+Alt+Space", () => openAsk());
  globalShortcut.register("Control+Alt+T", () => toggleTalk());
  globalShortcut.register("Control+Alt+P", () => showPanel());
  // A way out that never depends on finding an icon: Ctrl+Alt+Q quits the buddy completely.
  globalShortcut.register("Control+Alt+Q", () => { quitting = true; app.quit(); });
  if (!hooked) globalShortcut.register("Control+Alt+S", () => setBuddyOn(!state.buddyOn));
}

// ---------- new versions of this app, announced from Passiv ----------
const older = (a = "0", b = "0") => {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};
const myKey = IS_MAC ? (process.arch === "arm64" ? "mac_arm64" : "mac_x64") : "windows";
const myDownload = (d = {}) => (typeof d[myKey] === "string" ? d[myKey] : "");
const mySum = (d = {}) => (typeof d[myKey] === "string" && /^[a-f0-9]{64}$/i.test(d[myKey]) ? d[myKey].toLowerCase() : "");
// Installers only ever come from the project's GitHub releases (or Passiv itself), over https, and have to match the checksum Passiv published.
const DOWNLOAD_HOSTS = [/^github\.com$/, /^objects\.githubusercontent\.com$/, /^release-assets\.githubusercontent\.com$/, /(^|\.)passiv\.app$/];
const okDownload = (u) => { try { const x = new URL(u); return x.protocol === "https:" && DOWNLOAD_HOSTS.some((r) => r.test(x.hostname)); } catch { return false; } };

async function checkForUpdate() {
  try {
    const res = await net.fetch(`${APP_URL}/functions/buddyFiles?f=version.json&t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!res.ok) return;
    const v = await res.json();
    const mine = app.getVersion();
    if (!v?.latest || !older(mine, v.latest)) { update = null; buildTrayMenu(); toOverlays("overlay:update", null); return; }
    const fresh = !update || update.latest !== v.latest;
    update = { latest: clip(String(v.latest), 20), url: myDownload(v.downloads), sha256: mySum(v.sha256), notes: clip(String(v.notes || ""), 200), required: !!v.minimum && older(mine, v.minimum) };
    buildTrayMenu();
    toPanel({ type: "update", latest: update.latest, url: update.url, notes: update.notes, required: update.required });
    toOverlays("overlay:update", updatePayload());
    if (fresh && Notification.isSupported()) {
      const n = new Notification({ title: "A new Passiv buddy is ready", body: update.notes || `Version ${update.latest}. Click to install it.`, silent: true });
      n.on("click", installUpdate);
      n.show();
    }
    if (update.required) showPanel();
  } catch { /* offline: try later */ }
}

// A Mac update, done for them: open the verified download, copy the new Passiv out of it, quit, swap it in for the running
// one and start it again. The files come from our own checksum-verified download, so macOS has nothing to warn about.
// Returns false (and touches nothing) if Passiv isn't somewhere it is allowed to replace itself; the caller then opens the download as before.
async function replaceMacApp(dmg, dir) {
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (!bundle.endsWith(".app")) return false;
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); } catch { return false; }
  const mount = path.join(dir, "mnt"), fresh = path.join(dir, "new");
  fs.mkdirSync(mount); fs.mkdirSync(fresh);
  let mounted = false;
  try {
    await run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-noverify", "-readonly", "-noautoopen", "-mountpoint", mount, dmg]);
    mounted = true;
    const apps = fs.readdirSync(mount).filter((n) => n.endsWith(".app"));
    if (apps.length !== 1) throw new Error("unexpected installer contents");
    await run("/usr/bin/ditto", [path.join(mount, apps[0]), path.join(fresh, "Passiv.app")]);
  } catch (e) {
    console.error("[passiv] in-place update not possible:", e && e.message);
    return false;
  } finally {
    if (mounted) await run("/usr/bin/hdiutil", ["detach", "-force", mount]).catch(() => {});
  }
  // The swap has to happen after this app has quit, so a small helper waits for it, swaps, and relaunches. If anything fails it puts the old one back.
  const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; rm -rf "$2.old"; mv "$2" "$2.old" || exit 1; if mv "$3" "$2"; then /usr/bin/xattr -dr com.apple.quarantine "$2" 2>/dev/null; rm -rf "$2.old"; else mv "$2.old" "$2"; fi; /usr/bin/open "$2"; rm -rf "$4"';
  spawn("/bin/sh", ["-c", script, "sh", String(process.pid), bundle, path.join(fresh, "Passiv.app"), dir], { detached: true, stdio: "ignore" }).unref();
  return true;
}

// One click: download the new installer, check it, and install it. On a Mac it replaces the app and restarts on its own
// (if that isn't possible the download opens and they drag Passiv into Applications). Windows installs and restarts on its own.
let installing = false;
async function installUpdate() {
  if (installing) return;
  // Anything we can't prove is the real installer is left to the person to download from the Passiv page themselves.
  if (!update?.url || !okDownload(update.url) || !update.sha256) { openSafe(`${APP_URL}/download`); return; }
  installing = true;
  let dir = "";
  try {
    const res = await net.fetch(update.url, { redirect: "follow" });
    if (!res.ok || !okDownload(res.url || update.url)) throw new Error(`download ${res.status}`);
    const size = Number(res.headers.get("content-length") || 0);
    if (size > 400 * 1024 * 1024) throw new Error("too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 400 * 1024 * 1024) throw new Error("too large");
    const sum = crypto.createHash("sha256").update(buf).digest("hex");
    if (sum !== update.sha256) throw new Error("checksum mismatch");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "passiv-"));
    const file = path.join(dir, IS_MAC ? `Passiv-${update.latest.replace(/[^\w.]/g, "")}.dmg` : `Passiv-Setup-${update.latest.replace(/[^\w.]/g, "")}.exe`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    if (IS_MAC && await replaceMacApp(file, dir)) {
      dir = ""; // the helper cleans it up once the swap is done
      if (Notification.isSupported()) new Notification({ title: "Updating Passiv", body: "Passiv restarts in a few seconds.", silent: true }).show();
      setTimeout(() => { quitting = true; app.quit(); }, 600);
      return;
    }
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    if (IS_MAC && Notification.isSupported()) new Notification({ title: "Almost done", body: "Drag Passiv into Applications and choose Replace. Passiv closes now so it can be replaced." }).show();
    setTimeout(() => { quitting = true; app.quit(); }, IS_MAC ? 2500 : 800);
  } catch (e) {
    console.error("[passiv] update not installed:", e && e.message);
    if (Notification.isSupported()) new Notification({ title: "Update not installed", body: "It didn't pass Passiv's safety check. Get it from the Passiv download page instead.", silent: true }).show();
    openSafe(`${APP_URL}/download`);
  } finally {
    installing = false;
  }
}

// ---------- menu bar / tray ----------
function buildTrayMenu() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(update ? [{ label: `Update the buddy (${update.latest})`, click: installUpdate }, { type: "separator" }] : []),
    ...(authed ? [] : [{ label: "Sign in to Passiv to use the buddy", click: () => showPanel() }, { type: "separator" }]),
    { label: "Type to Passiv", accelerator: "Control+Alt+Space", enabled: authed, click: () => openAsk() },
    { label: `Talk: hold ${KEYS}, or tap ${IS_MAC ? "⌃⌥T" : "Ctrl+Alt+T"}`, enabled: false },
    { label: "Open chat", accelerator: "Control+Alt+P", click: () => showPanel() },
    { label: "Your to-dos", click: () => showPanel("todos") },
    { label: "Open Passiv in your browser", click: () => openSafe(APP_URL) },
    { type: "separator" },
    { label: "Clear all notes", click: () => toOverlays("overlay:notes", { op: "clear" }) },
    { label: "Put the icon back at the side", click: () => toOverlays("overlay:reset", true) },
    { label: "Show the buddy", type: "checkbox", checked: state.buddyOn, accelerator: "Control+Alt+S", click: () => setBuddyOn(!state.buddyOn) },
    { label: "Buddy size", submenu: [["cursor", "Tiny"], ["small", "Small"], ["default", "Large"]].map(([s, name]) => ({ label: name, type: "radio", checked: state.size === s, click: () => { state.size = s; saveState(); toOverlays("overlay:buddy", buddyPayload()); toPanel({ type: "buddy", patch: { size: s } }); buildTrayMenu(); } })) },
    { label: "Start when my computer starts", type: "checkbox", checked: login, click: () => { setLogin(!login); buildTrayMenu(); } },
    { label: "Sign out and clear this computer", enabled: authed, click: signOut },
    { label: "Run the welcome again", click: () => { state.onboarded = false; saveState(); autoShown = true; panel?.loadURL(`${APP_URL}/buddy`); showPanel(); } },
    { type: "separator" },
    { label: `About Passiv buddy ${app.getVersion()}`, enabled: false },
    { label: "Quit Passiv", accelerator: IS_MAC ? "Command+Q" : undefined, click: () => { quitting = true; app.quit(); } },
  ]));
}

// Signs out of Passiv here and wipes what this app stored: the sign-in itself, caches, everything.
async function signOut() {
  setAuthed(false);
  try { await session.defaultSession.clearStorageData(); await session.defaultSession.clearCache(); } catch { /* best effort */ }
  state.onboarded = false; saveState();
  if (panel && !panel.isDestroyed()) { panel.loadURL(`${APP_URL}/buddy`); autoShown = true; showPanel(); }
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "assets", IS_MAC ? "trayTemplate.png" : "tray.png"));
  if (IS_MAC) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip(`Passiv · type ${KEYS}${IS_MAC ? "Space" : "+Space"} · hold ${KEYS} to talk · quit ${KEYS}${IS_MAC ? "Q" : "+Q"}`);
  if (!IS_MAC) tray.on("click", () => showPanel());
  buildTrayMenu();
}

function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ["--hidden"] });
}

// ---------- messages from Passiv (the buddy window) ----------
const fromPanel = (e) => !!panel && e.sender === panel.webContents && trusted(e);
ipcMain.on("app:state", (e, s) => {
  if (!fromPanel(e) || !authed || !s || typeof s !== "object") return;
  const a = s.assist && typeof s.assist === "object" ? s.assist : {};
  const h = s.hold && typeof s.hold === "object" ? s.hold : null;
  cache.state = {
    assist: { state: ["idle", "thinking", "speaking"].includes(a.state) ? a.state : "idle", step: clip(a.step, 120), line: clip(a.line, 300), at: Number(a.at) || 0 },
    hold: h && h.state === "listening" ? { state: "listening", interim: clip(h.interim, 300) } : null,
    open: !!s.open,
  };
  toOverlays("overlay:state", withOpen(cache.state));
});
ipcMain.on("app:buddy", (e, b) => {
  if (!fromPanel(e) || !b) return;
  state.buddyOn = b.on !== false;
  if (["small", "default", "cursor"].includes(b.size)) state.size = b.size;
  saveState();
  toOverlays("overlay:buddy", buddyPayload());
  buildTrayMenu();
});
ipcMain.on("app:todos", (e, list) => {
  if (!fromPanel(e) || !authed || !Array.isArray(list)) return;
  cache.todos = list.slice(0, 20).map((t) => ({ id: clip(t && t.id, 60), text: clip(t && t.text, 300), due_at: clip(t && t.due_at, 40), person_name: clip(t && t.person_name, 80), relationship_id: /^[\w-]{1,60}$/.test((t && t.relationship_id) || "") ? t.relationship_id : "", due: !!(t && t.due) })).filter((t) => t.id && t.text);
  toOverlays("overlay:todos", cache.todos);
});
// Sticky notes from Passiv. Notes marked quiet are skipped while the chat window is open and in front, since it shows the same thing.
ipcMain.on("app:notes", (e, m) => {
  if (!fromPanel(e) || !authed || !m || typeof m !== "object") return;
  if (m.op === "add") {
    const n = m.note;
    if (!n || typeof n.id !== "string" || !/^[\w-]{1,60}$/.test(n.id) || JSON.stringify(n).length > 8000) return;
    if (n.quiet && panel && panel.isVisible() && panel.isFocused()) return;
    if (!state.buddyOn && n.kind !== "nudge") return;
    toOverlays("overlay:notes", m);
  } else if (m.op === "remove" || m.op === "clear") toOverlays("overlay:notes", m);
});
ipcMain.on("app:show", (e) => { if (fromPanel(e)) showPanel(); });
ipcMain.on("app:hide", (e) => { if (fromPanel(e)) panel.hide(); });
ipcMain.on("app:ready", (e) => {
  if (!fromPanel(e)) return;
  setAuthed(true); // the page only says this once someone is signed in to a Passiv account
  // Signed in and set up: if the window only came up for that, tuck it away and let the buddy take over.
  if (state.onboarded && autoShown) { autoShown = false; panel.hide(); hello(); }
  if (update) toPanel({ type: "update", latest: update.latest, url: update.url, notes: update.notes, required: update.required });
});
ipcMain.on("app:onboarded", (e) => {
  if (!fromPanel(e) || !authed) return;
  state.onboarded = true; saveState();
  autoShown = false;
  hookKeys();
  panel.hide();
  hello();
});
function hello() {
  if (Notification.isSupported()) new Notification({ title: "Your Passiv buddy is on", body: `Hold ${KEYS} in any app to talk. ${KEYS}${IS_MAC ? "Q" : "+Q"} quits it. It's in your ${IS_MAC ? "menu bar" : "system tray"} too.`, silent: true }).show();
}

ipcMain.handle("desktop:invoke", async (e, name, arg) => {
  if (!fromPanel(e)) return null;
  switch (name) {
    case "info": return { version: app.getVersion(), platform: process.platform, arch: process.arch, firstRun: !state.onboarded };
    case "permissions": return {
      microphone: (IS_MAC || process.platform === "win32") ? systemPreferences.getMediaAccessStatus("microphone") : "granted",
      accessibility: IS_MAC ? systemPreferences.isTrustedAccessibilityClient(false) : true,
    };
    case "openPermission":
      if (arg === "microphone") {
        if (IS_MAC && systemPreferences.getMediaAccessStatus("microphone") === "not-determined") return systemPreferences.askForMediaAccess("microphone");
        shell.openExternal(IS_MAC ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" : "ms-settings:privacy-microphone");
        return true;
      }
      if (arg === "accessibility" && IS_MAC) {
        systemPreferences.isTrustedAccessibilityClient(true);
        shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        return true;
      }
      return false;
    case "openExternal":
      return typeof arg === "string" && openSafe(arg) && /^https:/.test(arg);
    case "setLogin": setLogin(!!arg); buildTrayMenu(); return true;
    case "retryKeys": return hookKeys();
    case "installUpdate": installUpdate(); return true;
    // Mac only notices a new Accessibility permission after a restart.
    case "relaunch": quitting = true; app.relaunch(); app.exit(0); return true;
    case "authed": return authed;
    default: return null;
  }
});

// ---------- messages from the layer ----------
const fromLayer = (e) => { const w = BrowserWindow.fromWebContents(e.sender); return w && authed && trusted(e, UI_ORIGIN) && [...overlays.values()].includes(w) ? w : null; };
const fromAsk = (e) => !!askWin && !askWin.isDestroyed() && e.sender === askWin.webContents && authed && trusted(e, UI_ORIGIN);
// The typing box sends back what was typed, or asks to close.
ipcMain.on("ask:submit", (e, text) => {
  if (!fromAsk(e) || typeof text !== "string") return;
  const t = text.trim().slice(0, 2000);
  askWin.hide();
  if (t) toPanel({ type: "ask", text: t });
});
ipcMain.on("ask:close", (e) => { if (fromAsk(e)) askWin.hide(); });
// Clicks land on the layer only where there's something to click (a to-do card); everywhere else they go through.
ipcMain.on("overlay:interactive", (e, on) => { const w = fromLayer(e); if (w) w.setIgnoreMouseEvents(!on, { forward: true }); });
ipcMain.on("overlay:command", (e, cmd) => {
  if (!fromLayer(e) || !cmd || typeof cmd !== "object") return;
  if (cmd.type === "todo" && typeof cmd.id === "string" && ["done", "dismiss", "undo-done", "undo-dismiss"].includes(cmd.action)) toPanel({ type: "todo", id: cmd.id, action: cmd.action });
  else if (cmd.type === "open") showPanel(cmd.tab === "todos" ? "todos" : undefined);
  else if (cmd.type === "talk") toggleTalk();
  else if (cmd.type === "ask") openAsk();
  else if (cmd.type === "installUpdate") installUpdate();
  else if (cmd.type === "hide") setBuddyOn(false);
  else if (cmd.type === "note" && typeof cmd.id === "string" && /^[\w-]{1,60}$/.test(cmd.id) && typeof cmd.action === "string" && /^[\w-]{1,40}$/.test(cmd.action)) toPanel({ type: "note", id: cmd.id, action: cmd.action });
  else if (cmd.type === "person" && typeof cmd.id === "string" && /^[\w-]{1,60}$/.test(cmd.id)) openSafe(`${APP_URL}/r/${cmd.id}`);
});

// ---------- start ----------
// Whatever window the app ever makes: no embedded web views, no developer tools in a release build, no navigating away from Passiv.
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-attach-webview", (ev) => ev.preventDefault());
  if (!DEV) wc.on("devtools-opened", () => wc.closeDevTools());
  wc.on("will-redirect", (ev, url) => { if (!okHost(url)) ev.preventDefault(); });
});

app.on("second-instance", () => showPanel());
app.on("activate", () => showPanel());
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  try { require("uiohook-napi").uIOhook.stop(); } catch { /* not running */ }
});
app.on("window-all-closed", () => { /* stays running in the menu bar / tray; Quit is in its menu */ });

app.whenReady().then(() => {
  serveUi();
  loadState();
  // On a Mac, stay in the Dock while running so there is always a visible way to see it and quit it (right-click the Dock icon
  // → Quit). The menu bar icon can hide behind the notch or under other menu bar items.
  if (IS_MAC && app.dock) app.dock.setMenu(Menu.buildFromTemplate([
    { label: "Open Passiv", click: () => showPanel() },
    { label: "Type to Passiv", click: () => openAsk() },
  ]));
  // The microphone, for Passiv's own pages only.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    const origin = (() => { try { return new URL(details.requestingUrl || wc.getURL()).origin; } catch { return ""; } })();
    done((permission === "media" || permission === "speaker-selection") && origin === APP_ORIGIN);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => (permission === "media" ? origin === APP_ORIGIN : false));
  // No USB, serial, Bluetooth or HID devices for any page.
  session.defaultSession.setDevicePermissionHandler(() => false);
  // First run: start with the computer unless they turn it off in the welcome.
  if (!state.onboarded && !state.loginSet) { setLogin(true); state.loginSet = true; saveState(); }

  createPanel();
  rebuildOverlays();
  keepOnTop();
  createTray();
  startKeys();
  // Screens plugged in, unplugged or rearranged: redo the layer once things settle.
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(rebuildOverlays, 500); };
  screen.on("display-added", later);
  screen.on("display-removed", later);
  screen.on("display-metrics-changed", later);
  // Is there a newer buddy? Shortly after starting, then every few hours.
  setTimeout(checkForUpdate, 8000);
  setInterval(checkForUpdate, 4 * 3600e3);
});
