import { autoUpdater } from "electron-updater";
import { Notification } from "electron";
import { logger } from "./logger";

export function setupAutoUpdater(): void {
  autoUpdater.logger               = logger;
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    logger.info(`[updater] update available: v${info.version}`);
    new Notification({
      title: "Kliovo Print Agent",
      body:  `Update v${info.version} is downloading in the background.`,
    }).show();
  });

  autoUpdater.on("update-downloaded", (info) => {
    logger.info(`[updater] downloaded: v${info.version}`);
    new Notification({
      title: "Kliovo Print Agent",
      body:  `v${info.version} ready — restart the app to apply.`,
    }).show();
  });

  autoUpdater.on("error", (e) => {
    logger.warn(`[updater] ${e.message}`);
  });

  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}
