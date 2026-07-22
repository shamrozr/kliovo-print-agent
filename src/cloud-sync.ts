import { loadConfig } from "./config";
import {
  applyMirror,
  setState,
  getOfflineOrdersForPush,
  markOrdersPushed,
  markSynced,
} from "./store/repo";
import { getContinuedOrderOpsForPush, getContinuedOpIds } from "./store/continued-repo";
import { logger } from "./logger";

const SYNC_INTERVAL_MS = 60_000;

let wasOnline = false;

// ── Sync log (ring buffer of last N results shown in the UI) ────────────────
export interface SyncLogEntry {
  ts: number;
  ok: boolean;
  message: string;
}

const MAX_LOG = 10;
const syncLog: SyncLogEntry[] = [];

function logSync(ok: boolean, message: string): void {
  syncLog.unshift({ ts: Date.now(), ok, message });
  if (syncLog.length > MAX_LOG) syncLog.length = MAX_LOG;
}

export function getSyncLog(): SyncLogEntry[] {
  return syncLog;
}

// ── Verify key (lightweight — no full snapshot) ─────────────────────────────
export async function verifyDeviceKey(key: string): Promise<{
  valid: boolean;
  entitled?: boolean;
  branchName?: string;
  branchAddress?: string;
  branchPhone?: string;
  error?: string;
}> {
  const cfg = loadConfig();
  if (!cfg.serverUrl) return { valid: false, error: "No server URL configured" };
  const trimmed = key.trim();
  if (!trimmed || !trimmed.startsWith("dok_")) return { valid: false, error: "Key must start with dok_" };

  // Try the verify endpoint first; fall back to snapshot if 404.
  try {
    const res = await fetch(`${cfg.serverUrl}/api/offline/verify-key`, {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      // Server doesn't have verify-key yet — fall back to snapshot
      return verifyViaSnapshot(trimmed, cfg.serverUrl);
    }
    if (res.status === 401) return { valid: false, error: "Key rejected (revoked or wrong branch)" };
    if (!res.ok) return { valid: false, error: `Server error (HTTP ${res.status})` };
    const body = (await res.json().catch(() => null)) as {
      entitled?: boolean;
      branchName?: string;
      branchAddress?: string;
      branchPhone?: string;
    } | null;
    if (!body) return { valid: false, error: "Invalid server response" };
    if (body.entitled === false) return { valid: true, entitled: false, error: "Offline POS not enabled for this branch" };
    return {
      valid: true,
      entitled: true,
      branchName: body.branchName,
      branchAddress: body.branchAddress,
      branchPhone: body.branchPhone,
    };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

async function verifyViaSnapshot(key: string, serverUrl: string): Promise<{
  valid: boolean;
  entitled?: boolean;
  branchName?: string;
  branchAddress?: string;
  branchPhone?: string;
  error?: string;
}> {
  try {
    const res = await fetch(`${serverUrl}/api/offline/snapshot`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) return { valid: false, error: "Key rejected (revoked or wrong branch)" };
    if (!res.ok) return { valid: false, error: `Server error (HTTP ${res.status})` };
    const body = (await res.json().catch(() => null)) as {
      enabled?: boolean;
      batches?: { table: string; rows: Record<string, unknown>[] }[];
    } | null;
    if (!body) return { valid: false, error: "Invalid server response" };
    if (body.enabled === false) return { valid: true, entitled: false, error: "Offline POS not enabled for this branch" };
    // Extract branch info from branding batch
    let branchName: string | undefined;
    let branchAddress: string | undefined;
    let branchPhone: string | undefined;
    for (const b of body.batches ?? []) {
      if (b.table === "branding" && b.rows.length > 0) {
        branchName = b.rows[0].name as string;
        branchAddress = b.rows[0].address as string;
        branchPhone = b.rows[0].phone as string;
      }
    }
    // Since we already have the snapshot, apply it
    setState("entitled", "true");
    const upserted = applyMirror(Array.isArray(body.batches) ? body.batches : []);
    logSync(true, `Snapshot applied — ${upserted} rows`);
    wasOnline = true;
    return { valid: true, entitled: true, branchName, branchAddress, branchPhone };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

// ── Agent-pull sync ─────────────────────────────────────────────────────────
async function syncOnce(): Promise<void> {
  const cfg = loadConfig();
  const key = (cfg.offlineDeviceKey ?? "").trim();
  if (!key || !cfg.serverUrl) return;

  let res: Response;
  try {
    res = await fetch(`${cfg.serverUrl}/api/offline/snapshot`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn(`[cloud-sync] snapshot fetch failed: ${msg}`);
    logSync(false, msg);
    wasOnline = false;
    return;
  }

  if (res.status === 401) {
    logger.warn("[cloud-sync] device key rejected (revoked or wrong branch)");
    setState("entitled", "false");
    logSync(false, "Key rejected (401)");
    wasOnline = false;
    return;
  }
  if (!res.ok) {
    logger.warn(`[cloud-sync] snapshot HTTP ${res.status}`);
    logSync(false, `Server error (HTTP ${res.status})`);
    wasOnline = false;
    return;
  }

  const body = (await res.json().catch(() => null)) as
    | { enabled?: boolean; batches?: { table: string; rows: Record<string, unknown>[] }[] }
    | null;
  if (!body || body.enabled === false) {
    setState("entitled", "false");
    logSync(false, "Offline POS disabled on server");
    wasOnline = false;
    return;
  }

  try {
    setState("entitled", "true");
    const upserted = applyMirror(Array.isArray(body.batches) ? body.batches : []);
    logger.info(`[cloud-sync] snapshot applied — ${upserted} rows`);
    logSync(true, `Snapshot applied — ${upserted} rows`);
    if (!wasOnline) {
      wasOnline = true;
      logger.info("[cloud-sync] internet restored — draining outbox immediately");
      void pushOnce().catch((e) => logger.warn(`[cloud-sync] instant drain failed: ${(e as Error).message}`));
    }
  } catch (e) {
    logger.error(`[cloud-sync] applyMirror failed: ${(e as Error).message}`);
    logSync(false, `Apply failed: ${(e as Error).message}`);
  }
}

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
  try {
    const marked = markOrdersPushed(toPush.map((t) => t.orderId));
    logger.info(`[cloud-sync] pushed ${toPush.length} offline orders (accepted ${body.accepted ?? 0}, marked ${marked.marked})`);
  } catch (e) {
    logger.warn(`[cloud-sync] markOrdersPushed failed: ${(e as Error).message}`);
  }
}

async function pushContinuedOnce(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.pushContinuedOps) return;
  const key = (cfg.offlineDeviceKey ?? "").trim();
  if (!key || !cfg.serverUrl) return;
  let ops: ReturnType<typeof getContinuedOrderOpsForPush>;
  let ids: string[];
  try {
    ops = getContinuedOrderOpsForPush();
    ids = getContinuedOpIds();
  } catch (e) {
    logger.warn(`[cloud-sync] read continued ops failed: ${(e as Error).message}`);
    return;
  }
  if (ops.length === 0) return;
  let res: Response;
  try {
    res = await fetch(`${cfg.serverUrl}/api/offline/orders/ops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ops }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    logger.warn(`[cloud-sync] continued ops push failed: ${(e as Error).message}`);
    return;
  }
  if (!res.ok) {
    logger.warn(`[cloud-sync] continued ops push HTTP ${res.status}`);
    return;
  }
  try {
    markSynced(ids);
    logger.info(`[cloud-sync] pushed ${ops.length} continued-order ops`);
  } catch (e) {
    logger.warn(`[cloud-sync] markSynced (continued) failed: ${(e as Error).message}`);
  }
}

async function cycle(): Promise<void> {
  await syncOnce();
  await pushOnce();
  await pushContinuedOnce();
}

/** Trigger a sync cycle manually (called from the UI "Sync Now" button). */
export async function syncNow(): Promise<{ ok: boolean; message: string }> {
  try {
    await cycle();
    const last = syncLog[0];
    return last ? { ok: last.ok, message: last.message } : { ok: true, message: "Sync complete" };
  } catch (e) {
    const msg = (e as Error).message;
    logSync(false, msg);
    return { ok: false, message: msg };
  }
}

export function startCloudSync(): NodeJS.Timeout {
  setTimeout(() => void cycle(), 4_000);
  return setInterval(() => void cycle(), SYNC_INTERVAL_MS);
}
