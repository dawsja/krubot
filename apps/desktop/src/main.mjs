import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, session, shell } from "electron";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sameOrigin, serverCandidates } from "./server-url.mjs";

/*
 * Kru Bot for the desktop. The app is the web app itself: the window loads
 * your Kru Bot's own pages, so everything after sign-in looks and behaves
 * as it does in a browser. The only page shipped here is Connect, which
 * asks for the address the first time (and whenever you change server).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECT_PAGE = path.join(HERE, "connect.html");
const CONNECT_URL = pathToFileURL(CONNECT_PAGE).href;
const ICON = path.join(HERE, "logo.png");
const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");
/** How long a server gets to answer the health check on Connect. */
const PROBE_TIMEOUT_MS = 8_000;
/**
 * Where MCP sign-ins that only allow local tools come back (Robinhood's
 * Trading MCP): http://localhost:LOOPBACK_PORT/callback. Kept in step with
 * MCP_LOOPBACK_PORT in packages/shared.
 */
const LOOPBACK_PORT = 47651;
/** Web permissions a Kru Bot page may have; everything else is refused. */
const ALLOWED_PERMISSIONS = new Set(["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);

/** { server?: string, bounds?: { x, y, width, height }, maximized?: boolean } */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** The server the window is pointed at, once Connect has found one. */
let server = readConfig().server ?? null;
/** @type {BrowserWindow | null} */
let win = null;

function showConnect(params = {}) {
  if (!win) return;
  const query = {};
  if (params.server) query.server = params.server;
  if (params.error) query.error = params.error;
  void win.loadFile(CONNECT_PAGE, { query });
}

function showServer(pathname) {
  if (!win || !server) return;
  void win.loadURL(new URL(pathname, server).href);
}

/** Asks `origin` for Kru Bot's health check; true only for a Kru Bot that answers. */
async function isKruBot(origin) {
  try {
    const res = await net.fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "follow", cache: "no-store" });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

async function connect(input) {
  let origins;
  try {
    origins = serverCandidates(input);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  for (const origin of origins) {
    if (await isKruBot(origin)) {
      server = origin;
      writeConfig({ server });
      showServer("/login");
      return { ok: true };
    }
  }
  return { ok: false, error: "No Kru Bot answered at that address. Check it, and that Kru Bot is running." };
}

function fromConnectPage(event) {
  return event.senderFrame?.url.split("?")[0] === CONNECT_URL;
}

ipcMain.handle("kru:connect", (event, input) => (fromConnectPage(event) ? connect(input) : { ok: false, error: "Not allowed here." }));
ipcMain.handle("kru:change-server", () => showConnect({ server }));

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [{ label: "Change server…", click: () => showConnect({ server }) }, { type: "separator" }, { role: "quit", label: "Exit" }],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: "Alt+Left", click: () => win?.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "Alt+Right", click: () => win?.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        {
          label: "About Kru Bot",
          click: () =>
            void dialog.showMessageBox(win ?? undefined, {
              type: "info",
              title: "About Kru Bot",
              message: `Kru Bot ${app.getVersion()}`,
              detail: server ? `Connected to ${server}` : "Not connected to a server yet.",
              icon: ICON,
            }),
        },
      ],
    },
  ]);
}

/** Links to anywhere but your Kru Bot open in the default browser, never in the app. */
function openOutside(url) {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
}

/** Keeps a window on Connect and your Kru Bot; everything else goes to the browser. */
function guard(contents) {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event, url) => {
    if (url.split("?")[0] === CONNECT_URL || (server && sameOrigin(url, server))) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    // Your Kru Bot's own pages (a file, an attachment) get a window of their own.
    if (server && sameOrigin(url, server)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON } };
    openOutside(url);
    return { action: "deny" };
  });
}

function createWindow() {
  const { bounds, maximized } = readConfig();
  win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 480,
    minHeight: 560,
    title: "Kru Bot",
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    // The pages' own background, so there is no white flash in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0c0e" : "#f5f3ee",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());

  const contents = win.webContents;
  // The server is down or gone: back to Connect, with the address filled in.
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !server || !sameOrigin(url, server)) return;
    showConnect({ server, error: `Couldn't reach ${server} (${description}).` });
  });

  win.on("close", () => {
    if (!win) return;
    writeConfig({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  });
  win.on("closed", () => {
    win = null;
  });

  if (server) showServer("/app");
  else showConnect();
}

/**
 * The localhost end of a sign-in: the browser lands here with the code, and
 * the window, which holds your Kru Bot session, finishes it on the server's
 * own callback and shows the conversation it started from. The code only
 * works with the verifier the server kept, so a stray request does nothing.
 */
function startLoopback() {
  const page = (title, text) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#2a2a2e;background:#f5f3ee}@media(prefers-color-scheme:dark){body{color:#ececec;background:#0c0c0e}}main{max-width:26rem;text-align:center}h1{font-size:18px}</style><main><h1>${title}</h1><p>${text}</p></main>`;
  const handler = (request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${LOOPBACK_PORT}`);
    if (request.method !== "GET" || url.pathname !== "/callback" || !url.searchParams.get("state")) {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    if (!server || !win) {
      response.writeHead(409, { "Content-Type": "text/html; charset=utf-8" }).end(page("Open Kru Bot first", "Kru Bot isn't connected to a server. Open it, then start the sign-in again."));
      return;
    }
    const finish = new URL("/api/mcp-servers/oauth/callback", server);
    finish.search = url.search;
    void win.loadURL(finish.href);
    if (win.isMinimized()) win.restore();
    win.focus();
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page("Back to Kru Bot", "The sign-in went to Kru Bot. You can close this tab."));
  };
  // localhost may resolve to either; listen on both, and carry on if one is taken.
  for (const host of ["127.0.0.1", "::1"]) {
    const listener = createServer(handler);
    listener.on("error", (error) => console.warn(`[kru] localhost sign-in on ${host}:${LOOPBACK_PORT} unavailable: ${error.message}`));
    listener.listen(LOOPBACK_PORT, host);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.setAppUserModelId("app.krubot.desktop");

  app.on("web-contents-created", (_event, contents) => guard(contents));

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(Boolean(server && sameOrigin(contents.getURL(), server) && ALLOWED_PERMISSIONS.has(permission)));
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => Boolean(server && origin && sameOrigin(origin, server) && ALLOWED_PERMISSIONS.has(permission)));
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    startLoopback();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => app.quit());
}
