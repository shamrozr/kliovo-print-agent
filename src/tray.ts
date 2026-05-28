import { Tray, Menu, app, shell, nativeImage } from "electron";
import path from "path";
import { loadConfig } from "./config";

let tray: Tray | null = null;
export type TrayStatus = "green" | "yellow" | "red";

function iconPath(status: TrayStatus): string {
  return path.join(app.getAppPath(), "assets", `tray-${status}.png`);
}

export function createTray(openSettings: () => void): Tray {
  tray = new Tray(nativeImage.createFromPath(iconPath("green")));
  tray.setToolTip("Kliovo Print Agent");
  rebuildMenu(openSettings);
  return tray;
}

export function setTrayStatus(status: TrayStatus, openSettings: () => void): void {
  if (!tray || tray.isDestroyed()) return;
  try { tray.setImage(nativeImage.createFromPath(iconPath(status))); } catch {}
  rebuildMenu(openSettings);
}

function rebuildMenu(openSettings: () => void): void {
  if (!tray || tray.isDestroyed()) return;
  const config = loadConfig();

  const printerItems: Electron.MenuItemConstructorOptions[] =
    config.printers.length > 0
      ? config.printers.map((p) => ({
          label:   `${p.name || p.host}  (${p.host}:${p.port || 9100})`,
          enabled: false,
        }))
      : [{ label: "No printers configured", enabled: false }];

  const menu = Menu.buildFromTemplate([
    { label: `Kliovo Print Agent v${app.getVersion()}`, enabled: false },
    { type: "separator" },
    ...printerItems,
    { type: "separator" },
    { label: "Open Settings", click: openSettings },
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
