import { logger } from "../logger";
import { queuePunch } from "./attendance-store";
import { connectZk, zkErrorMessage, resolveDeviceId, sanitizeSerial, type ZkClient } from "./zk-connect";
import type { BiometricDeviceEntry, DevicePunch } from "./types";

interface RawLog {
  // zkteco-js decodes attendance records as { sn, user_id, record_time, ... }.
  // These are the REAL fields; the others are defensive aliases only.
  user_id?: string | number;
  record_time?: string | Date;
  deviceUserId?: string | number;
  id?: string | number;
  timestamp?: string;
}

/**
 * Normalize a device's raw attendance log into wire-ready punches with a
 * canonical ISO timestamp.
 * ──────────────────────────────────────────────────────────────────────────
 * NO cursor, NO high-water mark, NO filtering: EVERY record the device returns
 * is emitted on EVERY poll. Deduplication happens twice downstream and both
 * layers are content-addressed, not position/time based:
 *   1. the local store's UNIQUE (deviceUserId, timestamp, deviceId) index
 *      (INSERT OR IGNORE) — a punch already queued is silently skipped;
 *   2. the Dine ingest watermark + clock-engine conflict check.
 * This deliberately replaces the old timestamp cursor, which a single
 * future-dated record (a K70 clock glitch) could pin ahead of every real punch
 * — wedging sync so new punches read as "already seen" forever. Re-sending the
 * whole log every 15s is a few KB; correctness no longer depends on any local
 * state that can drift or get poisoned. Unparseable timestamps are forwarded
 * as-is (the server decides), never dropped.
 */
function normalizePunchLogs(logs: RawLog[]): DevicePunch[] {
  const out: DevicePunch[] = [];
  for (const entry of logs) {
    // Read the device's REAL field names first (user_id / record_time), with
    // the old aliases as fallbacks. Reading the wrong names made every punch
    // "unknown"/undefined — mapping to no staff member and being dropped
    // server-side, so nothing ever landed in Dine.
    const rawUser = entry.user_id ?? entry.deviceUserId ?? entry.id;
    const rawTime = entry.record_time ?? entry.timestamp;
    if (rawTime == null || rawUser == null || String(rawUser).trim() === "") continue;
    const d = new Date(rawTime);
    const timestamp = Number.isNaN(d.getTime()) ? String(rawTime) : d.toISOString();
    out.push({ deviceUserId: String(rawUser).trim(), timestamp });
  }
  return out;
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

// Timestamp of the last time ANY device's punch log was successfully read.
// This is the "auto-fetch is alive" heartbeat — distinct from last-push
// (getLastSyncAt), which only advances when there were new punches to send.
// Without it a healthy poller with nothing new to push reads "never".
let lastScanAt: string | null = null;
export function getLastScanAt(): string | null {
  return lastScanAt;
}

export async function startZkPolling(
  device: BiometricDeviceEntry,
  // Returns true when the punch was newly stored (false = already had it), so
  // the poller can count genuinely-fresh punches for its log line.
  onPunch: (punch: DevicePunch, deviceSerial: string) => boolean
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
      lastScanAt = new Date().toISOString(); // heartbeat: we reached the device

      const effectiveSerial = serial ?? device.id;
      let queued = 0;
      for (const punch of normalizePunchLogs(logs)) {
        if (onPunch(punch, effectiveSerial)) queued++; // true = newly stored (not a dupe)
      }
      if (queued > 0) {
        logger.info(`[zk] ${device.name}: ${queued} new punch(es) queued (device log: ${logs.length})`);
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

/**
 * One-shot, on-demand poll of a single device — backs the "Pull Attendance Now"
 * button in Settings. Queues the device's whole log; the store's identity index
 * drops anything already captured, so `newPunches` is the count of genuinely
 * fresh records. Returns a human-readable result so the operator sees exactly
 * what happened (connected? how many logs on device? how many new?) instead of
 * waiting on the silent 15s loop.
 */
export async function pollDeviceOnce(device: BiometricDeviceEntry): Promise<{
  ok: boolean;
  deviceSerial?: string;
  totalLogs?: number;
  newPunches?: number;
  error?: string;
}> {
  const host = device.host ?? "192.168.1.201";
  const port = device.port ?? 4370;
  let zk: ZkClient | null = null;
  try {
    zk = await connectZk(host, port);

    let serial = resolvedSerials.get(device.id);
    if (!serial) {
      try {
        serial = await resolveDeviceId(zk, device.id);
        if (serial) {
          resolvedSerials.set(device.id, serial);
          cacheDeviceSerial(device.id, serial);
        }
      } catch {
        // fall back to config id below
      }
    }
    const effectiveSerial = serial ?? device.id;

    const attendances = await zk.getAttendances();
    const logs = Array.isArray(attendances?.data) ? attendances.data : [];
    lastScanAt = new Date().toISOString(); // heartbeat: we reached the device

    let queued = 0;
    for (const punch of normalizePunchLogs(logs)) {
      if (queuePunch({ deviceUserId: punch.deviceUserId, timestamp: punch.timestamp, deviceId: effectiveSerial })) queued++;
    }
    logger.info(`[zk] ${device.name}: manual pull queued ${queued} new punch(es) (device log: ${logs.length})`);

    return { ok: true, deviceSerial: effectiveSerial, totalLogs: logs.length, newPunches: queued };
  } catch (e) {
    const msg = zkErrorMessage(e);
    logger.warn(`[zk] ${device.name}: manual pull failed:`, msg);
    return { ok: false, error: msg };
  } finally {
    if (zk) await zk.disconnect().catch(() => {});
  }
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
      return queuePunch({
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
