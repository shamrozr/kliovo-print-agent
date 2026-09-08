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
  /**
   * Command language a label printer speaks. ESC/POS won't produce output on a
   * label printer, so the test-print handler picks bytes based on this.
   *   "tspl" — TSC / Xprinter / Rongta / most cheap USB label printers (default)
   *   "zpl"  — Zebra
   *   "epl"  — older Zebra (EPL2)
   * Ignored when printerMode !== "label".
   */
  labelLanguage?: "tspl" | "zpl" | "epl";

  // ── Cash drawer ──────────────────────────────────────────────────────
  // A drawer is a box on THIS printer's DK port, so its wiring is a local,
  // physical, operator-verified fact — the same category as host/port above,
  // and held here for the same reason (see print/router.ts on why the
  // web-mirrored copy is not trusted). Dine holds a REPORTED copy for support
  // visibility only; it is never authoritative.
  /** Is a drawer actually plugged into this printer? Off = never kicked. */
  hasCashDrawer?: boolean;
  /** Connector pin the drawer is wired to. ~1 in 5 drawers is pin 5, and a
   *  pin-5 drawer never opens on pin 2 however correct everything else is —
   *  which is why the settings window offers a test for each. */
  drawerPin?: 2 | 5;
  /** Solenoid ON time. A stiff 24V drawer often needs 200-300ms; at 100ms it
   *  clicks without throwing the latch. This is the "sometimes it opens"
   *  complaint, and it is the first thing to raise. */
  drawerPulseOnMs?: number;
  /** Wait after the pulse before the printer accepts more data. */
  drawerPulseOffMs?: number;
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

  /**
   * Per-branch "Tax relay key" (trk_…), pasted by an admin from Dine → Settings
   * → Tax. Lets this agent relay fiscal API calls (PRA/FBR) from the restaurant's
   * Pakistani IP because the foreign-hosted server is geo-blocked. The server
   * resolves the tenant FROM this key (like the offline/attendance keys) and the
   * PRA/FBR token travels inside each task — the agent never stores it.
   */
  taxRelayKey?: string;

  /** Biometric attendance devices (ZKTeco TCP, ADMS HTTP, etc.). */
  biometricDevices: BiometricDeviceEntry[];
  /**
   * Per-branch "Attendance device key" (atk_…), pasted by an admin from Dine →
   * Settings → HR → Attendance. The ONLY credential that lets this agent push
   * biometric punches / pull device-scoped staff PINs for the branch. The
   * server resolves the tenant FROM this key (like offlineDeviceKey above) —
   * no separate tenant slug is needed, and one leaked key only ever exposes
   * one branch instead of every tenant on the platform.
   */
  attendanceDeviceKey?: string;

  /**
   * Let POS clients on the branch LAN reach this agent — call-centre desks and
   * second tills that sit on the same network and share the branch's printers.
   *
   * OFF by default, and deliberately opt-in per branch: the agent owns the
   * encrypted store, so widening its listener is a decision an operator makes
   * once, not a default every install inherits. When on, the bridge binds
   * 0.0.0.0 and non-loopback callers are held to private address ranges, an
   * allow-list of POS routes, and a valid /local/auth session token — the
   * pairing secret and the device routes never leave the machine.
   */
  lanAccess?: boolean;

  /** Push continued-order op-deltas to the server merge endpoint. OFF until the
   *  server route is deployed (emitting ops a server can't merge would 4xx). */
  pushContinuedOps?: boolean;
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
