import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { createTray, setTrayStatus } from "./tray";
import { startBridgeServer, setAppVersion } from "./bridge-server";
import { startPolling } from "./polling";
import { loadConfig, saveConfig } from "./config";
import { deliverToPrinter } from "./deliver";
import { recordResult, getHealthSnapshot } from "./health";
import { listSystemPrinters } from "./system-printer";
import { buildLabelTest } from "./render/label-test";
import { setupAutoUpdater } from "./updater";
import { initStore, prune } from "./store/db";
import { getOfflineOverview } from "./store/repo";
import { startCloudSync } from "./cloud-sync";
import { initAttendanceStore, pruneOldPunches } from "./biometric/attendance-store";
import { startAttendanceSync } from "./biometric/attendance-sync";
import { startAllBiometricDevices, stopAllBiometricDevices, getDeviceStatuses } from "./biometric/zk-adapter";
import { getQueueDepth } from "./biometric/attendance-store";
import { getLastSyncAt } from "./biometric/attendance-sync";
import { connectZk, zkErrorMessage, resolveDeviceId, sanitizeSerial } from "./biometric/zk-connect";
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

ipcMain.handle("biometric:test-device", async (_, entry: { host: string; port: number; label?: string }) => {
  let zk: Awaited<ReturnType<typeof connectZk>> | undefined;
  try {
    zk = await connectZk(entry.host, entry.port);
    const [info, name] = await Promise.all([
      zk.getInfo(),
      zk.getDeviceName().catch(() => "K70"),
    ]);
    // Clean, stable device identity (falls back to host id if the terminal's
    // serial reply is unparseable garbage — see resolveDeviceId).
    const serial = await resolveDeviceId(zk, entry.host);
    await zk.disconnect().catch(() => {});

    // Register/refresh this device in Dine so it shows up under Settings →
    // HR → Attendance, and so device-staff/device-ingest can scope PINs to
    // exactly this physical machine. Registration failure (e.g. no key saved
    // yet) never fails the connection test itself.
    let registered = false;
    let registerError: string | undefined;
    if (serial) {
      const config = loadConfig();
      if (config.attendanceDeviceKey) {
        try {
          const resp = await fetch(`${config.serverUrl}/api/attendance/devices/register`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.attendanceDeviceKey}`,
            },
            body: JSON.stringify({ serialNumber: serial, label: entry.label || name, deviceType: "zkteco_k70" }),
            signal: AbortSignal.timeout(10_000),
          });
          registered = resp.ok;
          if (!resp.ok) registerError = `Server returned ${resp.status}`;
        } catch (e) {
          registerError = (e as Error).message;
        }
      } else {
        registerError = "No attendance device key saved yet — save one in Settings first, then test again.";
      }
    }

    return {
      ok: true,
      serial,
      name,
      userCounts: info.userCounts,
      logCounts: info.logCounts,
      registered,
      registerError,
    };
  } catch (e) {
    await zk?.disconnect().catch(() => {});
    const msg = zkErrorMessage(e);
    logger.warn(`[biometric] test-device ${entry.host}:${entry.port} failed:`, msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle("biometric:device-users", async (_, entry: { host: string; port: number }) => {
  let zk: Awaited<ReturnType<typeof connectZk>> | undefined;
  try {
    zk = await connectZk(entry.host, entry.port);
    const users = await zk.getUsers();
    await zk.disconnect().catch(() => {});
    return { ok: true, users: users.data ?? [] };
  } catch (e) {
    await zk?.disconnect().catch(() => {});
    const msg = zkErrorMessage(e);
    logger.warn(`[biometric] device-users ${entry.host}:${entry.port} failed:`, msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle("biometric:sync-staff", async (_, entry: { host: string; port: number; serial?: string }) => {
  const config = loadConfig();
  const { serverUrl, attendanceDeviceKey } = config;
  if (!attendanceDeviceKey) {
    return { ok: false, error: "Save the attendance device key first (Dine → Settings → HR → Attendance)." };
  }

  // A device must be registered (serial known) before we can scope its PIN
  // list — that happens automatically the first time "Test Connection"
  // succeeds. Sanitize any cached value first: an agent configured before the
  // serial-sanitizing fix may hold a garbage serial, which would never match
  // the freshly-registered clean id — force a re-resolve in that case.
  let serial = sanitizeSerial(entry.serial);

  if (serial.length < 4) {
    let probe: Awaited<ReturnType<typeof connectZk>> | undefined;
    try {
      probe = await connectZk(entry.host, entry.port);
      serial = await resolveDeviceId(probe, entry.host);
    } catch (e) {
      return { ok: false, error: `Couldn't read the device's serial number: ${zkErrorMessage(e)}` };
    } finally {
      await probe?.disconnect().catch(() => {});
    }
  }
  if (!serial) {
    return { ok: false, error: "Device serial number unavailable — test the connection first." };
  }

  // 1. Fetch the staff+PIN list scoped to THIS device (auto-assigns fresh
  //    PINs server-side for anyone who doesn't have one on this device yet).
  let staff: Array<{ staffId: string; name: string; pin: string; uid: number }> = [];
  try {
    const resp = await fetch(
      `${serverUrl}/api/attendance/device-staff?deviceSerial=${encodeURIComponent(serial)}`,
      { headers: { Authorization: `Bearer ${attendanceDeviceKey}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!resp.ok) return { ok: false, error: `Server returned ${resp.status}: ${await resp.text().catch(() => "")}` };
    const data = (await resp.json()) as { staff: typeof staff };
    staff = data.staff ?? [];
  } catch (e) {
    return { ok: false, error: `Dine fetch failed: ${(e as Error).message}` };
  }
  if (staff.length === 0) {
    return { ok: false, error: "No active staff found for this branch." };
  }

  // 2. Push each staff member to the ZK device, then reconcile: remove any
  //    device-enrolled PIN that's no longer an active staff member (e.g. an
  //    ex-employee) so their fingerprint can never punch again and a future
  //    hire can never inherit their still-enrolled template.
  let zk: Awaited<ReturnType<typeof connectZk>> | undefined;
  const results: Array<{ name: string; pin: string; ok: boolean; error?: string }> = [];
  const removed: Array<{ pin: string; ok: boolean; error?: string }> = [];
  try {
    zk = await connectZk(entry.host, entry.port);

    const expectedUids = new Set(staff.map((s) => s.uid));
    for (const s of staff) {
      try {
        await zk.setUser(s.uid, s.pin, s.name, "", 0, 0);
        results.push({ name: s.name, pin: s.pin, ok: true });
      } catch (e) {
        results.push({ name: s.name, pin: s.pin, ok: false, error: zkErrorMessage(e) });
      }
    }

    try {
      const enrolled = await zk.getUsers();
      for (const u of enrolled.data ?? []) {
        if (!expectedUids.has(u.uid)) {
          try {
            await zk.deleteUser(u.uid);
            removed.push({ pin: String(u.uid), ok: true });
          } catch (e) {
            removed.push({ pin: String(u.uid), ok: false, error: zkErrorMessage(e) });
          }
        }
      }
    } catch (e) {
      logger.warn("[biometric] reconciliation read-back failed:", zkErrorMessage(e));
    }

    await zk.disconnect().catch(() => {});
  } catch (e) {
    await zk?.disconnect().catch(() => {});
    const msg = zkErrorMessage(e);
    logger.warn(`[biometric] sync-staff device connection failed:`, msg);
    return { ok: false, error: `Device connection failed: ${msg}`, results };
  }
  return {
    ok: true,
    pushed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    removed: removed.filter((r) => r.ok).length,
    removedFailed: removed.filter((r) => !r.ok).length,
    results,
  };
});

ipcMain.handle("printer:test", async (_, idx: number) => {
  const config  = loadConfig();
  const printer = config.printers[idx];
  if (!printer) return { ok: false, error: "Printer not found at index " + idx };

  const target =
    printer.connection === "system"
      ? (printer.systemPrinterName || "(no printer selected)")
      : `${printer.host}:${printer.port || 9100}`;

  // Label printers don't understand ESC/POS — they speak TSPL / ZPL / EPL —
  // so branch on the configured printerMode. Sending ESC/POS to a label
  // printer produces nothing (or a garbled feed), which is the whole reason
  // the user's own label software prints fine but this test used to fail.
  let bytes: Buffer;
  if (printer.printerMode === "label") {
    bytes = buildLabelTest(printer, target);
  } else {
    const ESC = 0x1b, GS = 0x1d;
    bytes = Buffer.from([
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
  }

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
