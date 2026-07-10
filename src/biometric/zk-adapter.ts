import fs from "fs";
import path from "path";
import { app } from "electron";
import { logger } from "../logger";
import { queuePunch } from "./attendance-store";
import { connectZk, zkErrorMessage, resolveDeviceId, sanitizeSerial, type ZkClient } from "./zk-connect";
import type { BiometricDeviceEntry, DevicePunch } from "./types";

const STATE_PATH = path.join(app.getPath("userData"), "zk-state.json");

/**
 * Per-device sync cursor. A TIMESTAMP high-water mark, NOT a record count.
 * ──────────────────────────────────────────────────────────────────────────
 * A count cursor (`lastCount` + `logs.slice(lastCount)`) silently stops
 * pushing forever the moment the device's stored count stops strictly
 * exceeding the last-seen count — which happens on every agent restart (count
 * unchanged), whenever the terminal's log is cleared/rotates (count drops),
 * or if a firmware returns logs in a different order. We instead remember the
 * newest timestamp we've already pushed, plus the identities of the punches AT
 * that exact second (so two people punching in the same second are never
 * conflated), and push anything at/after it that we haven't sent. The Dine
 * ingest endpoint dedups by (device serial, timestamp) against its own
 * watermark, so even a full resend is idempotent — this cursor only exists to
 * keep the wire small, never as the correctness boundary.
 */
interface DeviceCursor {
  lastTs: string | null;
  idsAtLastTs: string[];
  // legacy field tolerated on read; no longer written
  lastCount?: number;
}

interface ZkState {
  [deviceId: string]: DeviceCursor;
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

interface RawLog {
  deviceUserId?: string | number;
  id?: string | number;
  timestamp?: string;
}

/**
 * Given the full punch log read off a device and the persisted cursor for it,
 * return only the punches we haven't pushed yet and the cursor to persist
 * afterwards. Punches with an unparseable timestamp are dropped here (the
 * server would reject them as invalid anyway) so they can't wedge the cursor.
 */
function selectNewPunches(
  cursor: DeviceCursor | undefined,
  logs: RawLog[]
): { punches: DevicePunch[]; nextCursor: DeviceCursor } {
  const lastTsMs = cursor?.lastTs ? new Date(cursor.lastTs).getTime() : null;
  const seenAtLastTs = new Set(cursor?.idsAtLastTs ?? []);

  const parsed = logs
    .map((entry) => {
      const deviceUserId = String(entry.deviceUserId ?? entry.id ?? "unknown");
      const tsRaw = entry.timestamp ?? "";
      const ms = new Date(tsRaw).getTime();
      if (Number.isNaN(ms)) return null;
      return { deviceUserId, timestamp: tsRaw, ms, identity: `${deviceUserId}@${ms}` };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const fresh = parsed.filter((p) => {
    if (lastTsMs === null) return true; // first sync — take everything (server dedups)
    if (p.ms > lastTsMs) return true;
    if (p.ms === lastTsMs) return !seenAtLastTs.has(p.identity); // same-second, not yet sent
    return false;
  });

  // Next cursor = newest timestamp present on the device + the identities of
  // every punch at that exact second. Recomputed from the full log each time
  // so same-second punches accumulate correctly.
  let nextCursor: DeviceCursor = cursor ?? { lastTs: null, idsAtLastTs: [] };
  if (parsed.length > 0) {
    const maxMs = Math.max(...parsed.map((p) => p.ms));
    const idsAtMax = parsed.filter((p) => p.ms === maxMs).map((p) => p.identity);
    nextCursor = { lastTs: new Date(maxMs).toISOString(), idsAtLastTs: idsAtMax };
  }

  return {
    punches: fresh.map((p) => ({ deviceUserId: p.deviceUserId, timestamp: p.timestamp })),
    nextCursor,
  };
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
      lastScanAt = new Date().toISOString(); // heartbeat: we reached the device

      const state = loadState();
      const { punches, nextCursor } = selectNewPunches(state[device.id], logs);
      const effectiveSerial = serial ?? device.id;

      if (punches.length > 0) {
        for (const punch of punches) onPunch(punch, effectiveSerial);
        logger.info(`[zk] ${device.name}: ${punches.length} new punch(es) queued (device log: ${logs.length})`);
      }
      // Persist the advanced cursor even when nothing was new, so a legacy
      // count-based state is migrated to the timestamp cursor on first poll.
      state[device.id] = nextCursor;
      saveState(state);

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
 * button in Settings. Reuses the SAME `zk-state.json` lastCount cursor as the
 * background poller, so a manual pull never double-queues punches the loop has
 * already sent. Returns a detailed, human-readable result so the operator can
 * see exactly what happened (connected? how many logs on device? how many new?)
 * instead of waiting on the silent 15s loop.
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

    const state = loadState();
    const { punches, nextCursor } = selectNewPunches(state[device.id], logs);
    for (const punch of punches) {
      queuePunch({ deviceUserId: punch.deviceUserId, timestamp: punch.timestamp, deviceId: effectiveSerial });
    }
    state[device.id] = nextCursor;
    saveState(state);
    logger.info(`[zk] ${device.name}: manual pull queued ${punches.length} new punch(es) (device log: ${logs.length})`);

    return { ok: true, deviceSerial: effectiveSerial, totalLogs: logs.length, newPunches: punches.length };
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
