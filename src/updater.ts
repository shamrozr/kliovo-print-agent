/**
 * Auto-update — download automatically, install ONLY with the user's consent.
 *
 * History: the very first version downloaded but never installed (waited for a
 * graceful quit that never came); the next version auto-installed inside an
 * overnight window. Per operator request we now do neither automatically —
 * updates DOWNLOAD in the background so they're ready instantly, but the agent
 * NEVER restarts to install without an explicit user action (a dialog choice or
 * the tray "Install update" item). A till is never interrupted unexpectedly.
 */
import { autoUpdater } from "electron-updater";
import { Notification, dialog } from "electron";
import { logger } from "./logger";
import { setPendingUpdate } from "./tray";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly check for a new download

let pendingVersion: string | null = null;

/** Is an update downloaded and waiting for the user to install it? */
export function getPendingUpdateVersion(): string | null {
  return pendingVersion;
}

/** Install the downloaded update now. Only ever called from a user action. */
export function installPendingUpdate(): void {
  if (!pendingVersion) return;
  logger.info(`[updater] user approved install of v${pendingVersion} — restarting`);
  // isSilent=false → the user sees the installer; isForceRunAfter=true → relaunch.
  autoUpdater.quitAndInstall(false, true);
}

/** Ask the user whether to install now. Non-blocking; "Later" leaves it in the tray. */
function promptInstall(version: string): void {
  dialog
    .showMessageBox({
      type: "info",
      title: "Kliovo Agent update",
      message: `Update v${version} is downloaded and ready.`,
      detail:
        "Installing restarts the agent. You can install now, or later from the tray menu (Install update). Nothing installs until you choose.",
      buttons: ["Install now", "Later"],
      defaultId: 1,
      cancelId: 1,
    })
    .then((res) => {
      if (res.response === 0) installPendingUpdate();
    })
    .catch(() => {});
}

export function setupAutoUpdater(): void {
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = true;
  // Never install silently on quit — installation requires explicit user consent.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info) => {
    logger.info(`[updater] update available: v${info.version} — downloading`);
    new Notification({
      title: "Kliovo Agent",
      body: `Update v${info.version} is downloading in the background.`,
    }).show();
  });

  autoUpdater.on("update-downloaded", (info) => {
    pendingVersion = info.version;
    logger.info(`[updater] downloaded v${info.version} — awaiting user consent to install`);
    // Surface it in the tray so the user can install whenever they choose.
    setPendingUpdate(info.version, installPendingUpdate);
    new Notification({
      title: "Kliovo Agent",
      body: `v${info.version} downloaded — install it when ready from the tray menu.`,
    }).show();
    promptInstall(info.version);
  });

  autoUpdater.on("error", (e) => {
    logger.warn(`[updater] ${e.message}`);
  });

  autoUpdater.checkForUpdates().catch((e) => {
    logger.warn(`[updater] initial check failed: ${(e as Error).message}`);
  });

  // Keep pulling new releases so they're downloaded and ready — but only offer,
  // never auto-install.
  setInterval(() => {
    if (pendingVersion) return; // already have one waiting on the user
    autoUpdater.checkForUpdates().catch((e) => {
      logger.warn(`[updater] check failed: ${(e as Error).message}`);
    });
  }, CHECK_INTERVAL_MS);
}
