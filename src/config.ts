import { app } from "electron";
import fs from "fs";
import path from "path";
import type { BiometricDeviceEntry } from "./biometric/types";

export interface PrinterEntry {
  printerId:  string;
  agentKey:   string;
  /**
   * How the agent reaches this printer:
   *   "network" — TCP socket to host:port (Ethernet/Wi-Fi printers, port 9100)
   *   "system"  — RAW write to an OS print queue (USB printers via the
   *               installed driver: Windows spooler / macOS+Linux CUPS)
   * Defaults to "network" when omitted (back-compat with existing configs).
   */
  connection?: "network" | "system";
  /** Network printers only. */
  host:       string;
  port:       number;
  /** System printers only — the exact OS print-queue name (e.g. "XP-58"). */
  systemPrinterName?: string;
  name:       string;
  paperWidth: 80 | 58;
  /** "receipt" (default) or "label" — cosmetic; Dine renders the bytes, but
   *  the agent shows the mode in the UI and can skip cutter-init for labels. */
  printerMode?: "receipt" | "label";
  /** Label roll width in mm (e.g. 40, 50, 60, 80). Display only. */
  labelWidthMm?: number;
  /** Label height in mm. Null = continuous roll. Display only. */
  labelHeightMm?: number;
  /** Gap detection type: "die_cut" | "black_mark" | "continuous". Display only. */
  gapType?: "die_cut" | "black_mark" | "continuous";
}

export interface AgentConfig {
  serverUrl: string;
  printers:  PrinterEntry[];
  /**
   * Per-branch "Offline device key" (dok_…), pasted by an admin from Dine →
   * Settings → Offline POS. The ONLY credential that lets this agent pull the
   * branch's offline snapshot from the server. Empty = the agent pulls nothing.
   */
  offlineDeviceKey?: string;

  /** Biometric attendance devices (ZKTeco TCP, ADMS HTTP, etc.). */
  biometricDevices: BiometricDeviceEntry[];
  /** Shared secret for authenticating punch pushes to the Dine server. */
  attendanceDeviceSecret?: string;
  /** Tenant slug used when pushing punches (identifies the restaurant). */
  attendanceTenantSlug?: string;
}

const CONFIG_DIR  = app.getPath("userData");
const CONFIG_PATH = path.join(CONFIG_DIR, "agent-config.json");

const DEFAULT_CONFIG: AgentConfig = {
  serverUrl: "https://dine.kliovo.com",
  printers:  [],
  biometricDevices: [],
};

export function loadConfig(): AgentConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AgentConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
