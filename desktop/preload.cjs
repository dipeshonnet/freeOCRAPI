const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("freeocrapi", {
  session: () => ipcRenderer.invoke("freeocrapi:session"),
  openDashboard: () => ipcRenderer.invoke("freeocrapi:dashboard"),
  copyKey: () => ipcRenderer.invoke("freeocrapi:copy-key"),
});
