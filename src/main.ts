import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { createTray, setTrayStatus } from "./tray";
import { startBridgeServer, setAppVersion } from "./bridge-server";
import { startPolling } from "./polling";
import { loadConfig, saveConfig } from "./config";
import { deliverToPrinter } from "./deliver";
import { recordResult, getHealthSnapshot } from "./health";
import { listSystemPrinters } from "./system-printer";
import { setupAutoUpdater } from "./updater";
import { initStore, prune } from "./store/db";
import { getOfflineOverview } from "./store/repo";
import { startCloudSync } from "./cloud-sync";
import { initAttendanceStore, pruneOldPunches } from "./biometric/attendance-store";
import { startAttendanceSync } from "./biometric/attendance-sync";
import { startAllBiometricDevices, stopAllBiometricDevices, getDeviceStatuses } from "./biometric/zk-adapter";
import { getQueueDepth } from "./biometric/attendance-store";
import { getLastSyncAt } from "./biometric/attendance-sync";
import { logger } from "./logger";

let settingsWin: BrowserWindow | null = null;

// Only one instance allowed. A SECOND launch (e.g. autostart + manual open, or a
// lingering instance) must surface the running one — never fall through to bind
// the bridge port again, which crashed with "EADDRINUSE 127.0.0.1:6310".
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0); // hard stop so this duplicate never reaches whenReady/listen
}

app.on("second-instance", () => {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
  } else {
    openSettings();
  }
});

// A stray async error must never kill a tray printing agent with a fatal dialog.
// Log it and keep printing.
process.on("uncaughtException", (err) => {
  logger.error("[main] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  logger.error("[main] unhandledRejection:", reason);
});

// Keep process alive when all windows close (tray app)
app.on("window-all-closed", () => { /* intentional no-op — tray app stays alive */ });

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width:     540,
    height:    640,
    resizable: false,
    title:     "Kliovo Print Agent — Settings",
    webPreferences: {
      preload:          path.join(__dirname, "windows", "settings", "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  const htmlPath = path.join(app.getAppPath(), "src", "windows", "settings", "index.html");
  settingsWin.loadFile(htmlPath);
  settingsWin.on("closed", () => { settingsWin = null; });
}

// IPC handlers
ipcMain.handle("config:load",  ()        => loadConfig());
ipcMain.handle("config:save",  (_, cfg)  => { saveConfig(cfg); setTrayStatus("green", openSettings); });
ipcMain.handle("app:version",  ()        => app.getVersion());
ipcMain.handle("printers:list", ()        => listSystemPrinters());
ipcMain.handle("health:snapshot", ()      => getHealthSnapshot());
ipcMain.handle("offline:overview", () => {
  // Store may be uninitialised (init failed) — never throw into the UI.
  try {
    return { ok: true, data: getOfflineOverview() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle("biometric:status", () => {
  try {
    return {
      ok: true,
      queueDepth: getQueueDepth(),
      lastSync: getLastSyncAt(),
      devices: getDeviceStatuses(),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle("printer:test", async (_, idx: number) => {
  const config  = loadConfig();
  const printer = config.printers[idx];
  if (!printer) return { ok: false, error: "Printer not found at index " + idx };

  const target =
    printer.connection === "system"
      ? (printer.systemPrinterName || "(no printer selected)")
      : `${printer.host}:${printer.port || 9100}`;

  // Minimal ESC/POS test page — hardcoded bytes, no user data involved
  const ESC = 0x1b, GS = 0x1d;
  const bytes = Buffer.from([
    ESC, 0x40,                               // Initialize printer
    ESC, 0x61, 0x01,                         // Center align
    ESC, 0x21, 0x30,                         // Double height + width
    ...Buffer.from("Kliovo\n"),
    ESC, 0x21, 0x00,                         // Normal size
    ...Buffer.from("Test Print\n"),
    ...Buffer.from(`${target}\n`),
    ...Buffer.from(`${new Date().toLocaleString()}\n`),
    GS,  0x56, 0x42, 0x00,                  // Partial cut
  ]);

  try {
    await deliverToPrinter(printer, bytes);
    recordResult({ printerId: printer.printerId, printerName: printer.name, kind: "test", ok: true });
    return { ok: true };
  } catch (e) {
    recordResult({ printerId: printer.printerId, printerName: printer.name, kind: "test", ok: false, error: (e as Error).message });
    return { ok: false, error: (e as Error).message };
  }
});

app.whenReady().then(() => {
  setAppVersion(app.getVersion());
  logger.info(`[main] Kliovo Print Agent v${app.getVersion()} starting`);

  createTray(openSettings);
  setTrayStatus("green", openSettings);

  startBridgeServer();
  startPolling();

  // Offline encrypted store (used only by offline-entitled tenants). Must never
  // block printing — if it fails to initialise, the agent keeps printing fine.
  try {
    initStore();
    prune(); // sweep on boot
    setInterval(() => {
      try {
        prune();
      } catch (e) {
        logger.error("[store] prune failed:", e);
      }
    }, 60 * 60 * 1000); // hourly

    // Agent-pull offline sync — warms the store directly from the server using
    // the branch's Offline device key. No key configured → no-op.
    startCloudSync();
  } catch (e) {
    logger.error("[store] init failed — offline features disabled this session:", e);
  }

  // Biometric attendance — optional, no-op when no devices configured
  try {
    initAttendanceStore();
    startAttendanceSync();
    startAllBiometricDevices();
    setInterval(() => {
      try {
        pruneOldPunches();
      } catch (e) {
        logger.error("[biometric] prune failed:", e);
      }
    }, 60 * 60 * 1000); // hourly
  } catch (e) {
    logger.error("[biometric] init failed:", e);
  }

  // Register auto-start on login (Windows + macOS)
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

  if (app.isPackaged) setupAutoUpdater();

  // Open settings on first run when no printers are configured
  const config = loadConfig();
  if (config.printers.length === 0) openSettings();

  logger.info(`[main] ready — printers: ${config.printers.length}`);
});
