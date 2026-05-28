import { app } from "electron";
import fs from "fs";
import path from "path";

export interface PrinterEntry {
  printerId:  string;
  agentKey:   string;
  host:       string;
  port:       number;
  name:       string;
  paperWidth: 80 | 58;
}

export interface AgentConfig {
  serverUrl: string;
  printers:  PrinterEntry[];
}

const CONFIG_DIR  = app.getPath("userData");
const CONFIG_PATH = path.join(CONFIG_DIR, "agent-config.json");

const DEFAULT_CONFIG: AgentConfig = {
  serverUrl: "https://dine.kliovo.com",
  printers:  [],
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
