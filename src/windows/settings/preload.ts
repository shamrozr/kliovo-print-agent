import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agent", {
  loadConfig:  ()              => ipcRenderer.invoke("config:load"),
  saveConfig:  (cfg: unknown)  => ipcRenderer.invoke("config:save", cfg),
  testPrinter: (idx: number)   => ipcRenderer.invoke("printer:test", idx),
  getVersion:  ()              => ipcRenderer.invoke("app:version"),
  listPrinters:()              => ipcRenderer.invoke("printers:list"),
});
