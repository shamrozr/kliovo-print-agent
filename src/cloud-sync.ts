import { loadConfig } from "./config";
import {
  applyMirror,
  setState,
  getOfflineOrdersForPush,
  markOrdersPushed,
} from "./store/repo";
import { logger } from "./logger";

// How often the agent pulls the offline snapshot from the server. Offline data
// (menu, staff, recent orders) changes slowly, so a relaxed cadence is fine.
const SYNC_INTERVAL_MS = 60_000;

/**
 * Agent-pull offline sync. Using the branch's Offline device key (NOT a printer
 * key, NOT a DB/admin token), the agent fetches its branch snapshot from the
 * server and writes it into the encrypted local store. Browser-independent —
 * works as long as the agent has internet, regardless of where Dine is open.
 *
 * No key configured → no request is ever made → the agent links to nothing.
 */
async function syncOnce(): Promise<void> {
  const cfg = loadConfig();
  const key = (cfg.offlineDeviceKey ?? "").trim();
  if (!key || !cfg.serverUrl) return; // not provisioned for offline — do nothing

  let res: Response;
  try {
    res = await fetch(`${cfg.serverUrl}/api/offline/snapshot`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    logger.warn(`[cloud-sync] snapshot fetch failed: ${(e as Error).message}`);
    return;
  }

  if (res.status === 401) {
    logger.warn("[cloud-sync] device key rejected (revoked or wrong branch)");
    setState("entitled", "false");
    return;
  }
  if (!res.ok) {
    logger.warn(`[cloud-sync] snapshot HTTP ${res.status}`);
    return;
  }

  const body = (await res.json().catch(() => null)) as
    | { enabled?: boolean; batches?: { table: string; rows: Record<string, unknown>[] }[] }
    | null;
  if (!body || body.enabled === false) {
    setState("entitled", "false");
    return;
  }

  try {
    setState("entitled", "true");
    const upserted = applyMirror(Array.isArray(body.batches) ? body.batches : []);
    logger.info(`[cloud-sync] snapshot applied — ${upserted} rows`);
  } catch (e) {
    logger.error(`[cloud-sync] applyMirror failed: ${(e as Error).message}`);
  }
}

/**
 * Push offline-created orders up to the cloud staging queue (device-key auth).
 * Non-destructive on the server — they wait there for a human to reconcile on
 * the web "Offline Sync" screen. Once accepted we mark them locally so they're
 * not re-pushed; re-pushing is harmless anyway (server upsert is idempotent).
 */
async function pushOnce(): Promise<void> {
  const cfg = loadConfig();
  const key = (cfg.offlineDeviceKey ?? "").trim();
  if (!key || !cfg.serverUrl) return;

  let toPush: ReturnType<typeof getOfflineOrdersForPush>;
  try {
    toPush = getOfflineOrdersForPush();
  } catch (e) {
    logger.warn(`[cloud-sync] read offline orders failed: ${(e as Error).message}`);
    return;
  }
  if (toPush.length === 0) return;

  let res: Response;
  try {
    res = await fetch(`${cfg.serverUrl}/api/offline/orders/push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ orders: toPush.map((t) => t.payload) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    logger.warn(`[cloud-sync] order push failed: ${(e as Error).message}`);
    return;
  }
  if (res.status === 401) {
    logger.warn("[cloud-sync] order push: device key rejected");
    return;
  }
  if (!res.ok) {
    logger.warn(`[cloud-sync] order push HTTP ${res.status}`);
    return;
  }

  const body = (await res.json().catch(() => null)) as
    | { accepted?: number; enabled?: boolean }
    | null;
  if (!body || body.enabled === false) return;
  // The server accepted (or already had) every order we sent; mark them handed off.
  try {
    const marked = markOrdersPushed(toPush.map((t) => t.orderId));
    logger.info(`[cloud-sync] pushed ${toPush.length} offline orders (accepted ${body.accepted ?? 0}, marked ${marked.marked})`);
  } catch (e) {
    logger.warn(`[cloud-sync] markOrdersPushed failed: ${(e as Error).message}`);
  }
}

async function cycle(): Promise<void> {
  await syncOnce();
  await pushOnce();
}

export function startCloudSync(): NodeJS.Timeout {
  // Kick off shortly after boot, then on a timer.
  setTimeout(() => void cycle(), 4_000);
  return setInterval(() => void cycle(), SYNC_INTERVAL_MS);
}
