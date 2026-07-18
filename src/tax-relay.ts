import { app } from "electron";
import { loadConfig } from "./config";
import { logger } from "./logger";

/**
 * Tax-relay loop. The foreign-hosted Dine server is geo-blocked by PRA/FBR, so
 * it queues the exact fiscal HTTP call and this agent — on the restaurant's
 * Pakistani IP — executes it and posts the response back.
 *
 * Mirrors polling.ts (the print loop): poll → do work → ack. A leased task that
 * we already handled is skipped via the in-memory dedup set, so a redelivery
 * never double-submits a fiscal invoice.
 */

const POLL_INTERVAL_MS = 4_000;
const IDLE_INTERVAL_MS = 15_000;
const RELAY_TIMEOUT_MS = 30_000;

// Dedup ledger — task ids we've already relayed this run. Belt-and-braces on top
// of the server's unique(authority,invoiceId) + already-submitted guards.
const handled = new Set<string>();

interface RelayTask {
  taskId: string;
  authority: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

async function pollOnce(serverUrl: string, key: string): Promise<boolean> {
  const res = await fetch(`${serverUrl}/api/tax-relay/pending`, {
    headers: { Authorization: `Bearer ${key}`, "X-Agent-Version": app.getVersion() },
    signal: AbortSignal.timeout(8_000),
  });

  if (res.status === 204) return false; // idle
  if (!res.ok) {
    logger.warn(`[tax-relay] poll HTTP ${res.status}`);
    return false;
  }

  const task = (await res.json()) as RelayTask;
  if (handled.has(task.taskId)) {
    logger.info(`[tax-relay] ${task.taskId} already relayed — skipping`);
    return true;
  }
  handled.add(task.taskId);
  logger.info(`[tax-relay] ${task.taskId} → ${task.authority} ${task.method} ${task.url}`);

  let httpStatus = 0;
  let body = "";
  try {
    const relayRes = await fetch(task.url, {
      method: task.method || "POST",
      headers: task.headers,
      body: JSON.stringify(task.body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    httpStatus = relayRes.status;
    body = await relayRes.text();
    logger.info(`[tax-relay] ${task.authority} → HTTP ${httpStatus}`);
  } catch (e) {
    httpStatus = 0;
    body = JSON.stringify({ error: (e as Error).message });
    logger.warn(`[tax-relay] call failed: ${(e as Error).message}`);
  }

  try {
    const ack = await fetch(`${serverUrl}/api/tax-relay/${task.taskId}/result`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ httpStatus, body }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!ack.ok) {
      // Server didn't record it — drop from dedup so the lease reclaim re-offers it.
      handled.delete(task.taskId);
      logger.warn(`[tax-relay] ack ${task.taskId} HTTP ${ack.status}`);
    }
  } catch (e) {
    handled.delete(task.taskId);
    logger.warn(`[tax-relay] ack ${task.taskId} failed: ${(e as Error).message}`);
  }
  return true;
}

let timer: NodeJS.Timeout | null = null;

/** Start the relay loop. No-op (and self-idles) until a tax relay key is set. */
export function startTaxRelay(): void {
  if (timer) return;
  const run = async () => {
    let busy = false;
    try {
      const cfg = loadConfig();
      if (cfg.taxRelayKey && cfg.taxRelayKey.startsWith("trk_")) {
        busy = await pollOnce(cfg.serverUrl, cfg.taxRelayKey);
      }
    } catch (e) {
      logger.warn(`[tax-relay] loop error: ${(e as Error).message}`);
    } finally {
      timer = setTimeout(run, busy ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS);
    }
  };
  run();
}
