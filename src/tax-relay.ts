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

// Dedup ledger — keyed by task id AND attempt number. Belt-and-braces on top of
// the server's unique(authority,invoiceId) + already-submitted guards.
//
// It must NOT be keyed on taskId alone. The task row is upserted per invoice, so
// its id survives a re-queue: an operator pressing Retry hands us the same id,
// we skipped it as "already relayed", never acked, and the server re-offered it
// every lease expiry — for ever. The attempt number is what distinguishes a
// genuine redelivery of a call we already made from a fresh go at the same one.
const handled = new Set<string>();
const HANDLED_MAX = 500;

function rememberHandled(key: string): void {
  handled.add(key);
  // Set iterates in insertion order, so this evicts oldest-first. Unbounded, a
  // long-running till would grow this set for the life of the process.
  while (handled.size > HANDLED_MAX) {
    const oldest = handled.values().next().value as string | undefined;
    if (oldest === undefined) break;
    handled.delete(oldest);
  }
}

interface RelayTask {
  taskId: string;
  /** Server-side lease counter. Absent on servers older than this field. */
  attempts?: number;
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
  const dedupKey = `${task.taskId}:${task.attempts ?? 0}`;
  if (handled.has(dedupKey)) {
    logger.info(`[tax-relay] ${dedupKey} already relayed — skipping`);
    // Report idle, not busy. A skip is not work: treating it as work drops the
    // loop to the 4s poll interval and hammers the server for as long as the
    // task keeps being re-offered.
    return false;
  }
  rememberHandled(dedupKey);
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
      handled.delete(dedupKey);
      logger.warn(`[tax-relay] ack ${task.taskId} HTTP ${ack.status}`);
    }
  } catch (e) {
    handled.delete(dedupKey);
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
