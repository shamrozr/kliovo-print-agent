import { app } from "electron";
import { loadConfig, PrinterEntry } from "./config";
import { deliverToPrinter } from "./deliver";
import { recordResult } from "./health";
import { logger } from "./logger";
import {
  hasPrinted,
  isLedgerReady,
  markAcked,
  markPrinted,
  pendingAcks,
} from "./store/print-ledger";

const POLL_INTERVAL_MS    = 2_000;
const BACKOFF_INTERVAL_MS = 10_000;

/**
 * When we last put bytes on a printer. The updater reads this so it never
 * restarts the agent in the middle of service.
 */
let lastPrintAt = 0;
export function msSinceLastPrint(): number {
  return lastPrintAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - lastPrintAt;
}

/**
 * Sent on every poll so the server knows this agent keeps a dedup ledger and can
 * therefore safely redeliver a job it never heard an ACK for.
 *
 * This is a capability claim, not a version claim, and the distinction matters:
 * the offline store is allowed to fail without blocking printing, so an agent on
 * the right version can still be running without a usable ledger. Reporting the
 * live state on every poll means the server only ever redelivers to an agent
 * that can actually refuse a duplicate.
 */
function dedupHeader(): Record<string, string> {
  return isLedgerReady() ? { "X-Agent-Dedup": "1" } : {};
}

/** ACK a printed job. Returns true only when the server confirms. */
async function ackJob(
  serverUrl: string,
  printJobId: string,
  agentKey: string
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/print/${printJobId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        // Without this the route falls through to session auth, 401s, and the
        // job is left looking un-printed forever. This was the bug that made
        // every job in Dine read "printing" whether it printed or vanished.
        Authorization: `Bearer ${agentKey}`,
        "X-Agent-Version": app.getVersion(),
      },
      body:   JSON.stringify({ action: "ack" }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.warn(`[ack] ${printJobId} HTTP ${res.status}`);
      return false;
    }
    markAcked(printJobId);
    return true;
  } catch (e) {
    // Deliberately not swallowed: an un-acked job stays in the ledger and is
    // retried by flushPendingAcks() on a later tick.
    logger.warn(`[ack] ${printJobId} failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * NACK a job we failed to deliver. This is what actually kills head-of-line
 * blocking: a job left `printing` on a down printer is reclaimed as the
 * OLDEST job on every poll, forever shadowing every newer ticket behind it.
 * Telling the server to fail the job (and mark the printer offline) frees
 * that slot immediately so newer jobs can be served. Best-effort — if the
 * NACK itself fails, the job is still stuck server-side, but we've already
 * given up on it locally and move on rather than blocking this printer's
 * poll loop on a second network call.
 */
async function nackJob(
  serverUrl: string,
  printJobId: string,
  agentKey: string,
  error: unknown
): Promise<void> {
  try {
    const res = await fetch(`${serverUrl}/api/print/${printJobId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentKey}`,
        "X-Agent-Version": app.getVersion(),
      },
      body:   JSON.stringify({ action: "nack", error: String(error).slice(0, 500) }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.warn(`[poll] nack ${printJobId} HTTP ${res.status}`);
      return;
    }
    // Never log agentKey — it is a bearer secret that would leak into agent.log.
    logger.warn(`[poll] nacked job ${printJobId}`);
  } catch (e) {
    logger.warn(`[poll] nack ${printJobId} failed: ${(e as Error).message}`);
  }
}

/** Retry ACKs for jobs we printed but never got confirmation for. */
async function flushPendingAcks(serverUrl: string): Promise<void> {
  const pending = pendingAcks();
  if (pending.length === 0) return;
  logger.info(`[ack] retrying ${pending.length} pending ack(s)`);
  for (const p of pending) {
    await ackJob(serverUrl, p.printJobId, p.agentKey);
  }
}

async function pollPrinter(serverUrl: string, printer: PrinterEntry): Promise<void> {
  const url = `${serverUrl}/api/print/pending?printerId=${encodeURIComponent(printer.printerId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${printer.agentKey}`,
      // Lets the server record a heartbeat (lastSeenAt + version) so the web UI
      // shows the agent as connected even when the browser can't reach the local
      // bridge (e.g. the web runs on a different device than the agent).
      "X-Agent-Version": app.getVersion(),
      ...dedupHeader(),
    },
    signal:  AbortSignal.timeout(8_000),
  });

  if (res.status === 204) return; // Idle — no queued jobs
  if (!res.ok) {
    logger.warn(`[poll] ${printer.printerId} HTTP ${res.status}`);
    return;
  }

  const { printJobId, bytesBase64 } = (await res.json()) as {
    printJobId:  string;
    bytesBase64: string;
  };

  logger.info(`[poll] received job ${printJobId} for ${printer.printerId}`);

  // Redelivery of something we already printed — the server simply never heard
  // our ACK. Re-ACK it and print nothing.
  if (hasPrinted(printJobId)) {
    logger.info(`[poll] job ${printJobId} already printed — re-acking, not reprinting`);
    await ackJob(serverUrl, printJobId, printer.agentKey);
    return;
  }

  const bytes = Buffer.from(bytesBase64, "base64");
  lastPrintAt = Date.now();
  try {
    await deliverToPrinter(printer, bytes);
  } catch (e) {
    // Do NOT rethrow: an uncleared "printing" job on the server is reclaimed
    // as the OLDEST job on every subsequent poll, so it would head-of-line
    // block every newer ticket to this printer for as long as it's down.
    // NACKing fails the job server-side and frees the printer to move on.
    const msg = (e as Error).message;
    recordResult({ printerId: printer.printerId, printerName: printer.name, kind: "queued", ok: false, error: msg });
    await nackJob(serverUrl, printJobId, printer.agentKey, msg);
    logger.warn(`[poll] delivery failed for ${printJobId} on ${printer.printerId}: ${msg} — nacked (parked)`);
    return;
  }

  // Record BEFORE acking: the gap between paper coming out and the ledger write
  // is the only window a crash could duplicate, so it stays as small as possible.
  markPrinted(printJobId, printer.printerId, printer.agentKey);

  recordResult({ printerId: printer.printerId, printerName: printer.name, kind: "queued", ok: true });
  logger.info(`[poll] printed job ${printJobId} on ${printer.printerId}`);

  await ackJob(serverUrl, printJobId, printer.agentKey);
}

/** Drop entries that can never poll — they only burn requests and log noise. */
function usablePrinters(printers: PrinterEntry[]): PrinterEntry[] {
  return printers.filter((p) => {
    if (!p.printerId || !p.agentKey) {
      logger.warn(
        `[poll] skipping printer "${p.name ?? "unnamed"}" — missing ${!p.printerId ? "printerId" : "agentKey"}`
      );
      return false;
    }
    return true;
  });
}

/**
 * Printers currently mid poll-and-deliver. This is what gives each printer
 * its own timeline: a printer can take 5-6s to fail through delivery
 * retries, but `Promise.all`-ing every printer on one shared tick would
 * stretch every OTHER printer's poll cycle out to match the slowest one.
 * Skipping a printer that's still in-flight (rather than awaiting it) means
 * a stuck printer just misses a tick or two of its own — it never delays
 * anyone else's.
 */
const inFlight = new Set<string>();

/** Per-printer consecutive-error counts, used only to back off a chronically failing printer. */
const consecutiveErrors = new Map<string, number>();

/** Per-printer timestamp of the last poll attempt, used to pace the backoff below. */
const lastAttemptAt = new Map<string, number>();

export function startPolling(): NodeJS.Timeout {
  const tick = async () => {
    const config = loadConfig();
    const printers = usablePrinters(config.printers);
    if (printers.length === 0) return;

    flushPendingAcks(config.serverUrl).catch((e) => {
      logger.warn(`[poll] flushPendingAcks error: ${(e as Error).message}`);
    });

    const now = Date.now();
    for (const p of printers) {
      if (inFlight.has(p.printerId)) continue; // still working the previous job — don't pile up

      // Cheap per-printer backoff: a chronically failing printer polls at
      // BACKOFF_INTERVAL_MS instead of every tick, without needing its own
      // timer. Every other printer is unaffected either way.
      const errCount = consecutiveErrors.get(p.printerId) ?? 0;
      const last     = lastAttemptAt.get(p.printerId) ?? 0;
      const interval = errCount > 5 ? BACKOFF_INTERVAL_MS : POLL_INTERVAL_MS;
      if (now - last < interval) continue;

      inFlight.add(p.printerId);
      lastAttemptAt.set(p.printerId, now);
      pollPrinter(config.serverUrl, p)
        .then(() => consecutiveErrors.set(p.printerId, 0))
        .catch((e) => {
          consecutiveErrors.set(p.printerId, errCount + 1);
          logger.warn(`[poll] error for ${p.printerId}: ${(e as Error).message}`);
        })
        .finally(() => inFlight.delete(p.printerId));
    }
  };

  return setInterval(tick, POLL_INTERVAL_MS);
}
