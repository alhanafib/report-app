/* Computer Lab Report — preload bridge (context-safe).
   Exposes ONLY auto-update events + restart to the web pages.
   No Node.js APIs leak into the renderer. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("labReportUpdater", {
  onUpdateAvailable: (cb) => ipcRenderer.on("lab:update-available", (_e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on("lab:update-downloaded", (_e, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on("lab:update-error", (_e, msg) => cb(msg)),
  restartAndInstall: () => ipcRenderer.invoke("lab:restart-and-install"),
});
