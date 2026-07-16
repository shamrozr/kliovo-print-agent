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
    recordResult({ printerId: printer.printerId, printerName: printer.name, kind: "queued", ok: false, error: (e as Error).message });
    throw e;
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

export function startPolling(): NodeJS.Timeout {
  let consecutiveErrors = 0;

  const tick = async () => {
    const config = loadConfig();
    const printers = usablePrinters(config.printers);
    if (printers.length === 0) return;

    try {
      await flushPendingAcks(config.serverUrl);
      await Promise.all(
        printers.map((p) =>
          pollPrinter(config.serverUrl, p).catch((e) => {
            consecutiveErrors++;
            logger.warn(`[poll] error for ${p.printerId}: ${(e as Error).message}`);
          })
        )
      );
      consecutiveErrors = 0;
    } catch (e) {
      logger.error(`[poll] tick error: ${(e as Error).message}`);
    }
  };

  let currentInterval = POLL_INTERVAL_MS;
  let timer = setTimeout(function run() {
    tick().finally(() => {
      currentInterval = consecutiveErrors > 5 ? BACKOFF_INTERVAL_MS : POLL_INTERVAL_MS;
      timer = setTimeout(run, currentInterval);
    });
  }, currentInterval);
  return timer;
}
