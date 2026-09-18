/*
 * The one bridge between the pages and the app. Connect uses `connect`; your
 * Kru Bot's pages use `changeServer` (the sign-in page shows the link only
 * when it finds this). Nothing else of Electron or Node reaches a page.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kruDesktop", {
  connect: (address) => ipcRenderer.invoke("kru:connect", String(address)),
  changeServer: () => ipcRenderer.invoke("kru:change-server"),
});
