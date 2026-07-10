import { logger } from "../logger";
import { getUnsyncedPunches, markSynced, getQueueDepth } from "./attendance-store";
import type { PunchQueueItem } from "./types";

const SYNC_INTERVAL_MS = 5_000;
let lastSyncAt: string | null = null;

export function getLastSyncAt(): string | null {
  return lastSyncAt;
}

async function pushBatch(
  serverUrl: string,
  key: string,
  deviceSerial: string,
  punches: PunchQueueItem[]
): Promise<boolean> {
  const resp = await fetch(`${serverUrl}/api/attendance/device-ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      deviceSerial,
      punches: punches.map((p) => ({
        deviceUserId: p.deviceUserId,
        timestamp: p.timestamp,
        direction: p.direction,
      })),
    }),
  });

  if (resp.ok) {
    markSynced(punches.map((p) => p.id));
    logger.info(`[biometric-sync] synced ${punches.length} punches for device ${deviceSerial}`);
    return true;
  }
  logger.warn(
    `[biometric-sync] server returned ${resp.status} for device ${deviceSerial}: ${await resp
      .text()
      .catch(() => "(no body)")}`
  );
  return false;
}

async function syncCycle(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadConfig } = require("../config") as { loadConfig: () => import("../config").AgentConfig };
  const config = loadConfig();

  const serverUrl = config.serverUrl;
  const key = config.attendanceDeviceKey;

  if (!serverUrl || !key) return;

  const punches = getUnsyncedPunches(200);
  if (punches.length === 0) return;

  // The ingest endpoint scopes PIN resolution + the replay watermark to one
  // device per request, so a mixed batch (multiple terminals queued punches
  // since the last sync) must be split and pushed one request per device.
  const byDevice = new Map<string, PunchQueueItem[]>();
  for (const p of punches) {
    const list = byDevice.get(p.deviceId) ?? [];
    list.push(p);
    byDevice.set(p.deviceId, list);
  }

  let anyOk = false;
  try {
    for (const [deviceSerial, group] of byDevice) {
      const ok = await pushBatch(serverUrl, key, deviceSerial, group.slice(0, 50));
      if (ok) anyOk = true;
    }
  } catch (e) {
    logger.warn(`[biometric-sync] push failed: ${(e as Error).message}`);
  }
  if (anyOk) lastSyncAt = new Date().toISOString();
}

export function startAttendanceSync(): NodeJS.Timeout {
  logger.info("[biometric-sync] starting attendance sync (every 5s)");
  return setInterval(() => void syncCycle(), SYNC_INTERVAL_MS);
}

/**
 * Push whatever is queued to the server immediately, out of band with the 5s
 * loop — used by the "Pull Attendance Now" button so a manual pull lands in
 * Dine in one shot. Returns how many punches were still queued before pushing
 * so the UI can report it.
 */
export async function flushNow(): Promise<{ pending: number }> {
  const pending = getQueueDepth();
  await syncCycle();
  return { pending };
}
