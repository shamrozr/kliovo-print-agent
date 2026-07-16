/**
 * Auto-update.
 *
 * The previous version downloaded updates and then waited forever: it set
 * `autoInstallOnAppQuit` and never called `quitAndInstall()`, so an update only
 * landed if someone gracefully quit the app. Tills get power-cycled or
 * task-killed, not quit — which is how a branch sat on v1.7.1 for weeks while
 * happily re-downloading v2.4.2 over and over.
 *
 * So we install proactively, but only inside a safe window: restarting the agent
 * mid-service means a kitchen ticket doesn't print, which is exactly the class of
 * problem this release exists to end.
 */
import { autoUpdater } from "electron-updater";
import { Notification } from "electron";
import { logger } from "./logger";
import { msSinceLastPrint } from "./polling";
import { pendingAcks } from "./store/print-ledger";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly — the old code only checked at boot
const INSTALL_WINDOW    = { startHour: 4, endHour: 5 }; // 04:00–05:00 local
const QUIET_PERIOD_MS   = 10 * 60 * 1000; // no printing for 10 min

let pendingVersion: string | null = null;

/**
 * Safe to restart? Inside the window, nothing printed recently, and no ACK still
 * owed to the server (an owed ACK means the server may yet redeliver that job).
 */
function isSafeToInstall(now: Date = new Date()): { ok: boolean; why: string } {
  const hour = now.getHours();
  if (hour < INSTALL_WINDOW.startHour || hour >= INSTALL_WINDOW.endHour) {
    return { ok: false, why: `outside install window (${INSTALL_WINDOW.startHour}:00–${INSTALL_WINDOW.endHour}:00)` };
  }
  if (msSinceLastPrint() < QUIET_PERIOD_MS) {
    return { ok: false, why: "printed within the last 10 min — service may be live" };
  }
  const owed = pendingAcks(1).length;
  if (owed > 0) {
    return { ok: false, why: "ACKs still owed to the server" };
  }
  return { ok: true, why: "" };
}

function tryInstall(): void {
  if (!pendingVersion) return;
  const { ok, why } = isSafeToInstall();
  if (!ok) {
    logger.info(`[updater] v${pendingVersion} ready, holding — ${why}`);
    return;
  }
  logger.info(`[updater] installing v${pendingVersion} now (safe window, idle)`);
  // isSilent = true, isForceRunAfter = true → reinstall and come straight back up.
  autoUpdater.quitAndInstall(true, true);
}

export function setupAutoUpdater(): void {
  autoUpdater.logger               = logger;
  autoUpdater.autoDownload         = true;
  // Belt and braces: if the machine is rebooted before our window comes round,
  // a graceful quit still applies the update.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    logger.info(`[updater] update available: v${info.version}`);
    new Notification({
      title: "Kliovo Print Agent",
      body:  `Update v${info.version} is downloading in the background.`,
    }).show();
  });

  autoUpdater.on("update-downloaded", (info) => {
    pendingVersion = info.version;
    logger.info(`[updater] downloaded: v${info.version} — will install in the next quiet window`);
    new Notification({
      title: "Kliovo Print Agent",
      body:  `v${info.version} ready — installs automatically overnight.`,
    }).show();
    tryInstall(); // in case we're already idle inside the window
  });

  autoUpdater.on("error", (e) => {
    logger.warn(`[updater] ${e.message}`);
  });

  autoUpdater.checkForUpdates().catch((e) => {
    logger.warn(`[updater] initial check failed: ${(e as Error).message}`);
  });

  // The old code checked once at boot, so an agent that never restarted never
  // learned about a release. Check hourly, and retry the install each time.
  setInterval(() => {
    if (pendingVersion) {
      tryInstall();
      return;
    }
    autoUpdater.checkForUpdates().catch((e) => {
      logger.warn(`[updater] check failed: ${(e as Error).message}`);
    });
  }, CHECK_INTERVAL_MS);
}
