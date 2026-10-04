/* Computer Lab Report — Electron desktop wrapper (Windows EXE).
   Loads the local report app (index.html). Staff view opens in the same
   window via the logo link. External links (footer etc.) open in the
   OS default browser — never inside the app window. No Node APIs are
   exposed to the web pages. */
const { app, BrowserWindow, Menu, shell, ipcMain } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");

// No File / View / Window menus — kiosk-style clean app window.
Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Computer Lab Report",
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "electron-preload.js"),
    },
  });

  // External links (target="_blank" / window.open) -> OS default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });

  // Guard: never let the app window itself navigate away to the web
  // (a misclicked external link would otherwise leave a blank app).
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));
  return win;
}

/* ---- Auto-update (GitHub Releases, NSIS only) ----
   Checks on launch (silent when offline). Downloads in background,
   notifies the app window, installs on restart. Portable builds
   cannot self-update (running file is locked) — they skip this. */
function setupAutoUpdate(mainWindow) {
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
  if (!app.isPackaged || isPortable) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    mainWindow.webContents.send("lab:update-available", { version: info?.version || "" });
  });
  autoUpdater.on("update-downloaded", (info) => {
    mainWindow.webContents.send("lab:update-downloaded", { version: info?.version || "" });
  });
  autoUpdater.on("error", (err) => {
    mainWindow.webContents.send("lab:update-error", String((err && err.message) || err || "error"));
  });

  ipcMain.handle("lab:restart-and-install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Slight delay so first paint isn't blocked; fails silently offline.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 8000);
}

app.whenReady().then(() => {
  const win = createWindow();
  if (win) setupAutoUpdate(win);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      if (w) setupAutoUpdate(w);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
