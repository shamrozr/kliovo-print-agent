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
import { loadConfig } from "./config";

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

/**
 * Point the updater at Dine instead of GitHub, and authenticate the request.
 *
 * WHY: this agent used to auto-update straight from the public GitHub repo
 * (`publish: provider: github` in electron-builder.yml, baked into
 * app-update.yml at build time). That repo is going PRIVATE, and
 * electron-updater sends no credentials of its own — so the baked-in feed
 * starts returning 404 to every installed agent, permanently, and each till
 * would need a manual reinstall to ever update again.
 *
 * `setFeedURL` overrides app-update.yml at runtime, so the build and publish
 * pipeline is untouched (GitHub Releases stays the source Dine pulls from,
 * latest.yml is still generated the same way). Only where the INSTALLED agent
 * looks changes.
 *
 * Auth: electron-updater forwards `requestHeaders` on both the feed request
 * and the download, so we present the printer key this agent already holds.
 * That keeps the update channel as closed as the repo it came from, instead of
 * trading a private repo for an anonymous public download URL.
 *
 * Read fresh on every check, never cached: a brand-new install has no key
 * until it is paired with a branch, and it must start updating on its own once
 * that happens rather than staying stranded until the next restart.
 *
 * Returns false when the agent is not paired yet — nothing to authenticate
 * with, so there is no point issuing the check.
 */
function applyFeedConfig(): boolean {
  let serverUrl: string;
  let agentKey: string | undefined;
  try {
    const config = loadConfig();
    serverUrl = (config.serverUrl || "").replace(/\/+$/, "");
    // Any configured printer's key identifies this agent; they all belong to
    // the same branch and the update is the same binary for all of them.
    agentKey = config.printers.find((p) => p.agentKey)?.agentKey;
  } catch (e) {
    logger.warn(`[updater] cannot read config: ${(e as Error).message}`);
    return false;
  }

  if (!serverUrl || !agentKey) {
    logger.info("[updater] no server/printer key configured yet — skipping update check");
    return false;
  }

  autoUpdater.setFeedURL({ provider: "generic", url: `${serverUrl}/api/print-agent/update` });
  autoUpdater.requestHeaders = { Authorization: `Bearer ${agentKey}` };
  return true;
}

/** Run a check, but only once the feed is actually configured. */
function checkNow(reason: string): void {
  if (!applyFeedConfig()) return;
  autoUpdater.checkForUpdates().catch((e) => {
    logger.warn(`[updater] ${reason} failed: ${(e as Error).message}`);
  });
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

  checkNow("initial check");

  // Keep pulling new releases so they're downloaded and ready — but only offer,
  // never auto-install.
  setInterval(() => {
    if (pendingVersion) return; // already have one waiting on the user
    checkNow("check");
  }, CHECK_INTERVAL_MS);
}
