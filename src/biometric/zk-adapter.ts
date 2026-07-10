import fs from "fs";
import path from "path";
import { app } from "electron";
import { logger } from "../logger";
import { queuePunch } from "./attendance-store";
import { connectZk, zkErrorMessage, resolveDeviceId, sanitizeSerial, type ZkClient } from "./zk-connect";
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

/** Persist the resolved hardware serial onto this device's config entry, once. */
function cacheDeviceSerial(configDeviceId: string, serial: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadConfig, saveConfig } = require("../config") as typeof import("../config");
  const cfg = loadConfig();
  const entry = (cfg.biometricDevices ?? []).find((d) => d.id === configDeviceId);
  if (entry && entry.serial !== serial) {
    entry.serial = serial;
    saveConfig(cfg);
  }
}

interface ZkPoller {
  stop: () => void;
}

const activePollers = new Map<string, ZkPoller>();
const resolvedSerials = new Map<string, string>(); // config device id -> hardware serial

export async function startZkPolling(
  device: BiometricDeviceEntry,
  onPunch: (punch: DevicePunch, deviceSerial: string) => void
): Promise<ZkPoller> {
  const host = device.host ?? "192.168.1.201";
  const port = device.port ?? 4370;
  const interval = device.pollIntervalMs ?? 15_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = interval;
  const MAX_BACKOFF = 5 * 60_000; // 5 minutes

  // Only trust a cached serial that's already clean; a stale garbage value
  // (from before the sanitizing fix) must be re-resolved so it matches the
  // clean id the device was re-registered under.
  const cachedClean = sanitizeSerial(device.serial);
  if (cachedClean.length >= 4) resolvedSerials.set(device.id, cachedClean);

  async function poll(): Promise<void> {
    if (stopped) return;

    let zk: ZkClient | null = null;
    try {
      zk = await connectZk(host, port);

      // Resolve + cache a clean, stable device id once. This — not the agent's
      // local config id — is what identifies the terminal to Dine, since two
      // K70s on the same branch must never be confused with each other. Falls
      // back to a host-derived id when the serial reply is garbage.
      let serial = resolvedSerials.get(device.id);
      if (!serial) {
        try {
          serial = await resolveDeviceId(zk, device.id);
          if (serial) {
            resolvedSerials.set(device.id, serial);
            cacheDeviceSerial(device.id, serial);
          }
        } catch (e) {
          logger.warn(`[zk] ${device.name}: couldn't resolve device id:`, zkErrorMessage(e));
        }
      }

      // Keep the terminal's onboard clock aligned with this PC's system time —
      // the K70 has no NTP client, so drift here directly skews punch
      // timestamps (and therefore lateness/hours calculations in Dine).
      try {
        await zk.setTime(new Date());
      } catch (e) {
        logger.warn(`[zk] ${device.name}: clock sync failed:`, zkErrorMessage(e));
      }

      const attendances = await zk.getAttendances();
      const logs = Array.isArray(attendances?.data) ? attendances.data : [];

      const state = loadState();
      const lastCount = state[device.id]?.lastCount ?? 0;

      if (logs.length > lastCount) {
        const newLogs = logs.slice(lastCount);
        const effectiveSerial = serial ?? device.id;
        for (const entry of newLogs) {
          const punch: DevicePunch = {
            deviceUserId: String(entry.deviceUserId ?? entry.id ?? "unknown"),
            timestamp: entry.timestamp ?? new Date().toISOString(),
          };
          onPunch(punch, effectiveSerial);
        }
        state[device.id] = { lastCount: logs.length };
        saveState(state);
        logger.info(`[zk] ${device.name}: ${newLogs.length} new punches (total: ${logs.length})`);
      }

      // Reset backoff on success
      backoffMs = interval;
    } catch (e) {
      logger.warn(`[zk] ${device.name} poll failed:`, zkErrorMessage(e));
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
    void startZkPolling(device, (punch, deviceSerial) => {
      queuePunch({
        deviceUserId: punch.deviceUserId,
        timestamp: punch.timestamp,
        direction: punch.direction,
        deviceId: deviceSerial,
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

export function getDeviceStatuses(): Array<{ id: string; name: string; connected: boolean; serial?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadConfig } = require("../config") as { loadConfig: () => import("../config").AgentConfig };
  const config = loadConfig();
  const devices = config.biometricDevices ?? [];
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    connected: d.enabled && activePollers.has(d.id),
    serial: resolvedSerials.get(d.id) ?? d.serial,
  }));
}
