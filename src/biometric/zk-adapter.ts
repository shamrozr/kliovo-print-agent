import ZKLib from "zkteco-js";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { logger } from "../logger";
import { queuePunch } from "./attendance-store";
import type { BiometricDeviceEntry, DevicePunch } from "./types";

const STATE_PATH = path.join(app.getPath("userData"), "zk-state.json");

interface ZkState {
  [deviceId: string]: { lastCount: number };
}

function loadState(): ZkState {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    }
  } catch {
    // corrupt state — start fresh
  }
  return {};
}

function saveState(state: ZkState): void {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    logger.warn("[zk] failed to save state:", e);
  }
}

interface ZkPoller {
  stop: () => void;
}

const activePollers = new Map<string, ZkPoller>();

export async function startZkPolling(
  device: BiometricDeviceEntry,
  onPunch: (punch: DevicePunch) => void
): Promise<ZkPoller> {
  const host = device.host ?? "192.168.1.201";
  const port = device.port ?? 4370;
  const interval = device.pollIntervalMs ?? 15_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = interval;
  const MAX_BACKOFF = 5 * 60_000; // 5 minutes

  async function poll(): Promise<void> {
    if (stopped) return;

    let zk: ZKLib | null = null;
    try {
      zk = new ZKLib(host, port, 5_000, 4_000);
      await zk.createSocket();

      const attendances = await zk.getAttendances();
      const logs = Array.isArray(attendances?.data) ? attendances.data : [];

      const state = loadState();
      const lastCount = state[device.id]?.lastCount ?? 0;

      if (logs.length > lastCount) {
        const newLogs = logs.slice(lastCount);
        for (const entry of newLogs) {
          const punch: DevicePunch = {
            deviceUserId: String(entry.deviceUserId ?? entry.id ?? "unknown"),
            timestamp: entry.timestamp ?? new Date().toISOString(),
          };
          onPunch(punch);
        }
        state[device.id] = { lastCount: logs.length };
        saveState(state);
        logger.info(`[zk] ${device.name}: ${newLogs.length} new punches (total: ${logs.length})`);
      }

      // Reset backoff on success
      backoffMs = interval;
    } catch (e) {
      logger.warn(`[zk] ${device.name} poll failed:`, (e as Error).message);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    } finally {
      if (zk) {
        try {
          await zk.disconnect();
        } catch {
          // ignore disconnect errors
        }
      }
    }

    if (!stopped) {
      timer = setTimeout(() => void poll(), backoffMs);
    }
  }

  // Start first poll
  void poll();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function startAllBiometricDevices(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadConfig } = require("../config") as { loadConfig: () => import("../config").AgentConfig };
  const config = loadConfig();
  const devices = config.biometricDevices ?? [];
  const zkDevices = devices.filter((d) => d.type === "zk-tcp" && d.enabled);

  if (zkDevices.length === 0) return;

  logger.info(`[zk] starting polling for ${zkDevices.length} ZK device(s)`);

  for (const device of zkDevices) {
    void startZkPolling(device, (punch) => {
      queuePunch({
        deviceUserId: punch.deviceUserId,
        timestamp: punch.timestamp,
        direction: punch.direction,
        deviceId: device.id,
      });
    }).then((poller) => {
      activePollers.set(device.id, poller);
    });
  }
}

export function stopAllBiometricDevices(): void {
  for (const [id, poller] of activePollers) {
    poller.stop();
    logger.info(`[zk] stopped polling for device ${id}`);
  }
  activePollers.clear();
}

export function getDeviceStatuses(): Array<{ id: string; name: string; connected: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadConfig } = require("../config") as { loadConfig: () => import("../config").AgentConfig };
  const config = loadConfig();
  const devices = config.biometricDevices ?? [];
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    connected: d.enabled && activePollers.has(d.id),
  }));
}
