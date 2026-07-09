import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agent", {
  loadConfig:  ()              => ipcRenderer.invoke("config:load"),
  saveConfig:  (cfg: unknown)  => ipcRenderer.invoke("config:save", cfg),
  testPrinter: (idx: number)   => ipcRenderer.invoke("printer:test", idx),
  getVersion:  ()              => ipcRenderer.invoke("app:version"),
  listPrinters:()              => ipcRenderer.invoke("printers:list"),
  getStatus:   ()              => ipcRenderer.invoke("health:snapshot"),
  getOfflineOverview: ()       => ipcRenderer.invoke("offline:overview"),
  biometricStatus:     ()            => ipcRenderer.invoke("biometric:status"),
  biometricTestDevice: (e: unknown)  => ipcRenderer.invoke("biometric:test-device", e),
  biometricDeviceUsers:(e: unknown)  => ipcRenderer.invoke("biometric:device-users", e),
  biometricSyncStaff:  (e: unknown)  => ipcRenderer.invoke("biometric:sync-staff", e),
});
