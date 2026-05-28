import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { createTray, setTrayStatus } from "./tray";
import { startBridgeServer, setAppVersion } from "./bridge-server";
import { startPolling } from "./polling";
import { loadConfig, saveConfig } from "./config";
import { sendRawToPrinter } from "./tcp-sender";
import { setupAutoUpdater } from "./updater";
import { logger } from "./logger";

// Only one instance allowed
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Keep process alive when all windows close (tray app)
app.on("window-all-closed", () => { /* intentional no-op — tray app stays alive */ });

let settingsWin: BrowserWindow | null = null;

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

  const htmlPath = app.isPackaged
    ? path.join(process.resourcesPath, "src", "windows", "settings", "index.html")
    : path.join(__dirname, "..", "src", "windows", "settings", "index.html");

  settingsWin.loadFile(htmlPath);
  settingsWin.on("closed", () => { settingsWin = null; });
}

// IPC handlers
ipcMain.handle("config:load",  ()        => loadConfig());
ipcMain.handle("config:save",  (_, cfg)  => { saveConfig(cfg); setTrayStatus("green", openSettings); });
ipcMain.handle("app:version",  ()        => app.getVersion());

ipcMain.handle("printer:test", async (_, idx: number) => {
  const config  = loadConfig();
  const printer = config.printers[idx];
  if (!printer) return { ok: false, error: "Printer not found at index " + idx };

  // Minimal ESC/POS test page — hardcoded bytes, no user data involved
  const ESC = 0x1b, GS = 0x1d;
  const bytes = Buffer.from([
    ESC, 0x40,                               // Initialize printer
    ESC, 0x61, 0x01,                         // Center align
    ESC, 0x21, 0x30,                         // Double height + width
    ...Buffer.from("Kliovo\n"),
    ESC, 0x21, 0x00,                         // Normal size
    ...Buffer.from("Test Print\n"),
    ...Buffer.from(`${printer.host}:${printer.port || 9100}\n`),
    ...Buffer.from(`${new Date().toLocaleString()}\n`),
    GS,  0x56, 0x42, 0x00,                  // Partial cut
  ]);

  try {
    await sendRawToPrinter(printer.host, printer.port || 9100, bytes);
    return { ok: true };
  } catch (e) {
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

  // Register auto-start on login (Windows + macOS)
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

  if (app.isPackaged) setupAutoUpdater();

  // Open settings on first run when no printers are configured
  const config = loadConfig();
  if (config.printers.length === 0) openSettings();

  logger.info(`[main] ready — printers: ${config.printers.length}`);
});
