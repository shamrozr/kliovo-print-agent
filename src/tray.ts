import { Tray, Menu, app, shell, nativeImage } from "electron";
import path from "path";
import { loadConfig } from "./config";

let tray: Tray | null = null;
export type TrayStatus = "green" | "yellow" | "red";

// Remembered so health updates can rebuild the menu without the caller
// having to thread `openSettings` through every call.
let openSettingsRef: () => void = () => {};
let currentStatus: TrayStatus = "green";
let activityLines: string[] = [];

function iconPath(status: TrayStatus): string {
  return path.join(app.getAppPath(), "assets", `tray-${status}.png`);
}

export function createTray(openSettings: () => void): Tray {
  openSettingsRef = openSettings;
  tray = new Tray(nativeImage.createFromPath(iconPath("green")));
  tray.setToolTip("Kliovo Print Agent");
  rebuildMenu();
  return tray;
}

export function setTrayStatus(status: TrayStatus, openSettings?: () => void): void {
  if (openSettings) openSettingsRef = openSettings;
  currentStatus = status;
  if (!tray || tray.isDestroyed()) return;
  try { tray.setImage(nativeImage.createFromPath(iconPath(status))); } catch {}
  rebuildMenu();
}

/** Set the hover tooltip (used by the health layer to surface last status). */
export function setTrayTooltip(text: string): void {
  if (!tray || tray.isDestroyed()) return;
  try { tray.setToolTip(text); } catch {}
}

/** Replace the recent-activity lines shown in the tray menu. */
export function setTrayActivity(lines: string[]): void {
  activityLines = lines.slice(0, 5);
  rebuildMenu();
}

function rebuildMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  const config = loadConfig();

  const printerItems: Electron.MenuItemConstructorOptions[] =
    config.printers.length > 0
      ? config.printers.map((p) => {
          const where = p.connection === "system"
            ? (p.systemPrinterName || "USB — not selected")
            : `${p.host}:${p.port || 9100}`;
          return { label: `${p.name || where}  (${where})`, enabled: false };
        })
      : [{ label: "No printers configured", enabled: false }];

  const activityItems: Electron.MenuItemConstructorOptions[] =
    activityLines.length > 0
      ? [
          { type: "separator" },
          { label: "Recent activity", enabled: false },
          ...activityLines.map((l) => ({ label: `  ${l}`, enabled: false })),
        ]
      : [];

  const statusLabel =
    currentStatus === "green" ? "Status: printing OK"
    : currentStatus === "yellow" ? "Status: recent print issues"
    : "Status: print FAILING";

  const menu = Menu.buildFromTemplate([
    { label: `Kliovo Print Agent v${app.getVersion()}`, enabled: false },
    { label: statusLabel, enabled: false },
    { type: "separator" },
    ...printerItems,
    ...activityItems,
    { type: "separator" },
    { label: "Open Settings", click: () => openSettingsRef() },
    {
      label: "View Logs",
      click: () => {
        shell.openPath(path.join(app.getPath("userData"), "logs")).catch(() => {});
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
}
