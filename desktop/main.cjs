const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  clipboard,
  shell,
  ipcMain,
  nativeTheme,
} = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} = require("node:fs");
const path = require("node:path");
const net = require("node:net");
app.setName("FreeOCRapi");
if (process.env.FREEOCRAPI_TEST_DATA) {
  mkdirSync(process.env.FREEOCRAPI_TEST_DATA, { recursive: true });
  app.setPath("userData", process.env.FREEOCRAPI_TEST_DATA);
}
const smoke = process.env.FREEOCRAPI_SMOKE_TEST === "1";
const updateUrl = process.env.FREEOCRAPI_UPDATE_URL;
let updater;
if (updateUrl) {
  if (!updateUrl.startsWith("https://"))
    throw new Error("Desktop update URL must use HTTPS");
  updater = require("electron-updater").autoUpdater;
  updater.setFeedURL({ provider: "generic", url: updateUrl });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.on("error", (error) =>
    require("electron").dialog.showErrorBox(
      "Update unavailable",
      error.message,
    ),
  );
  updater.on("update-available", async () => {
    const choice = await require("electron").dialog.showMessageBox({
      type: "question",
      message: "A FreeOCRapi update is available.",
      buttons: ["Download update", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) await updater.downloadUpdate();
  });
  updater.on("update-downloaded", async () => {
    const choice = await require("electron").dialog.showMessageBox({
      type: "question",
      message: "Restart FreeOCRapi to install the downloaded update?",
      buttons: ["Restart and install", "Later"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice.response === 0) {
      quitting = true;
      updater.quitAndInstall();
    }
  });
}
let backend,
  window,
  popover,
  tray,
  base,
  session,
  quitting = false;
const secret = randomBytes(32).toString("hex");
const root = path.resolve(__dirname, "..");
const data = path.join(app.getPath("userData"), "gateway");
async function freePort(start = 31416) {
  for (let port = start; port < start + 100; port++) {
    if (
      await new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
      })
    )
      return port;
  }
  throw new Error("No free desktop gateway port.");
}
function trusted(event) {
  return (
    event.sender === window?.webContents ||
    event.sender === popover?.webContents
  );
}
ipcMain.handle("freeocrapi:session", async (event) => {
  if (!trusted(event) || !event.senderFrame?.url.startsWith(base + "/"))
    throw new Error("Untrusted desktop context");
  const response = await fetch(base + "/api/auth/desktop", {
    method: "POST",
    headers: { "X-FreeOCRapi-Desktop": secret },
  });
  if (!response.ok) throw new Error("Desktop authentication failed");
  session = (await response.json()).token;
  return session;
});
ipcMain.handle("freeocrapi:dashboard", (event) => {
  if (trusted(event)) openDashboard();
});
ipcMain.handle("freeocrapi:copy-key", async (event) => {
  if (!trusted(event)) return;
  const response = await fetch(base + "/api/settings/api-key", {
    headers: { Authorization: "Bearer " + session },
  });
  if (!response.ok) return;
  clipboard.writeText((await response.json()).apiKey);
});
function secureWindow(options) {
  const win = new BrowserWindow({
    icon: path.join(__dirname, "icon.png"),
    ...options,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(base + "/")) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  return win;
}
function openDashboard() {
  if (!window || window.isDestroyed()) {
    window = secureWindow({
      width: 1240,
      height: 860,
      minWidth: 700,
      minHeight: 560,
      title: "FreeOCRapi",
      show: false,
    });
    window.loadURL(base + "/");
    window.once("ready-to-show", () => {
      if (!smoke) window.show();
    });
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
  } else {
    window.show();
    window.focus();
  }
}
function showPopover() {
  if (popover?.isVisible()) {
    popover.hide();
    return;
  }
  if (!popover || popover.isDestroyed()) {
    popover = secureWindow({
      width: 380,
      height: 350,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
    });
    popover.loadURL(base + "/desktop-tray");
    popover.on("blur", () => popover.hide());
    popover.once("ready-to-show", placePopover);
  } else placePopover();
}
function placePopover() {
  const bounds = tray.getBounds();
  const { screen } = require("electron");
  const area = screen.getDisplayNearestPoint({
    x: bounds.x,
    y: bounds.y,
  }).workArea;
  popover.setPosition(
    Math.max(area.x, Math.min(bounds.x - 170, area.x + area.width - 380)),
    Math.max(area.y, Math.min(bounds.y - 355, area.y + area.height - 350)),
  );
  popover.show();
}
function buildTray() {
  tray = new Tray(
    nativeImage
      .createFromPath(path.join(__dirname, "icon.png"))
      .resize({ width: 32, height: 32 }),
  );
  tray.setToolTip("FreeOCRapi — local OCR gateway");
  tray.on("click", showPopover);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open dashboard", click: openDashboard },
      { label: "Copy gateway URL", click: () => clipboard.writeText(base) },
      {
        label: "Copy API key",
        click: async () => {
          const response = await fetch(base + "/api/settings/api-key", {
            headers: { Authorization: "Bearer " + session },
          });
          if (response.ok) clipboard.writeText((await response.json()).apiKey);
        },
      },
      {
        label: "Start at login",
        type: "checkbox",
        checked:
          process.platform === "linux"
            ? false
            : app.getLoginItemSettings().openAtLogin,
        enabled: process.platform !== "linux",
        click: (item) =>
          app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { label: "Open data folder", click: () => shell.openPath(data) },
      {
        label: updateUrl
          ? "Check for updates"
          : "Updates: no channel configured",
        enabled: Boolean(updater),
        click: () => void updater?.checkForUpdates(),
      },
      { type: "separator" },
      { label: "Quit FreeOCRapi", click: () => app.quit() },
    ]),
  );
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (base) openDashboard();
  });
  app
    .whenReady()
    .then(async () => {
      mkdirSync(data, { recursive: true });
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      let executable =
        process.env.FREEOCRAPI_NODE_PATH ||
        (app.isPackaged
          ? path.join(
              process.resourcesPath,
              "runtime",
              process.platform === "win32" ? "node.exe" : "node",
            )
          : path.join(
              __dirname,
              "runtime",
              process.platform === "win32" ? "node.exe" : "node",
            ));
      if (!existsSync(executable))
        throw new Error(
          "Desktop Node runtime is missing. Run the desktop preparation script.",
        );
      backend = spawn(executable, [path.join(root, "server/dist/index.js")], {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          DATA_DIR: data,
          HOST: "127.0.0.1",
          PORT: String(port),
          FREEOCRAPI_DESKTOP_TOKEN: secret,
          NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const log = (chunk) => {
        const target = path.join(data, "desktop.log");
        const text = chunk.toString().replaceAll(secret, "[redacted]");
        require("node:fs").appendFileSync(target, text);
      };
      backend.stdout.on("data", log);
      backend.stderr.on("data", log);
      backend.on("exit", (code) => {
        if (!quitting) {
          require("electron").dialog.showErrorBox(
            "FreeOCRapi stopped",
            `The OCR gateway stopped (${code}). Logs are in ${data}.`,
          );
          app.quit();
        }
      });
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          if ((await fetch(base + "/health")).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error("The desktop OCR gateway did not start.");
      const login = await fetch(base + "/api/auth/desktop", {
        method: "POST",
        headers: {
          "X-FreeOCRapi-Desktop": secret,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!login.ok) throw new Error("Desktop sign-in failed.");
      session = (await login.json()).token;
      buildTray();
      openDashboard();
      if (smoke) {
        console.log("FREEOCRAPI_DESKTOP_READY " + base);
        setTimeout(() => app.quit(), 5000);
      }
    })
    .catch((error) => {
      require("electron").dialog.showErrorBox(
        "Cannot start FreeOCRapi",
        error.message,
      );
      app.quit();
    });
  app.on("before-quit", () => {
    quitting = true;
    backend?.kill("SIGTERM");
    tray?.destroy();
  });
  app.on("window-all-closed", (event) => {});
}
