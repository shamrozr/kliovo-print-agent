import { logger } from "../logger";
import { getUnsyncedPunches, markSynced } from "./attendance-store";

const SYNC_INTERVAL_MS = 5_000;
let lastSyncAt: string | null = null;

export function getLastSyncAt(): string | null {
  return lastSyncAt;
}

async function syncCycle(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadConfig } = require("../config") as { loadConfig: () => import("../config").AgentConfig };
  const config = loadConfig();

  const serverUrl = config.serverUrl;
  const secret = config.attendanceDeviceSecret;
  const slug = config.attendanceTenantSlug;

  if (!serverUrl || !secret || !slug) return;

  const punches = getUnsyncedPunches(50);
  if (punches.length === 0) return;

  try {
    const resp = await fetch(`${serverUrl}/api/attendance/device-ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-secret": secret,
      },
      body: JSON.stringify({
        tenantSlug: slug,
        punches: punches.map((p) => ({
          deviceUserId: p.deviceUserId,
          timestamp: p.timestamp,
          direction: p.direction,
        })),
      }),
    });

    if (resp.ok) {
      markSynced(punches.map((p) => p.id));
      lastSyncAt = new Date().toISOString();
      logger.info(`[biometric-sync] synced ${punches.length} punches`);
    } else {
      logger.warn(
        `[biometric-sync] server returned ${resp.status}: ${await resp.text().catch(() => "(no body)")}`
      );
    }
  } catch (e) {
    logger.warn(`[biometric-sync] push failed: ${(e as Error).message}`);
  }
}

export function startAttendanceSync(): NodeJS.Timeout {
  logger.info("[biometric-sync] starting attendance sync (every 5s)");
  return setInterval(() => void syncCycle(), SYNC_INTERVAL_MS);
}
