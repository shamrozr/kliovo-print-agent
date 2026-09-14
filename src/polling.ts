import { app } from "electron";
import { loadConfig, PrinterEntry } from "./config";
import { drawerHeaders, drawerFingerprint, withDrawerKick } from "./print/drawer";
import { deliverToPrinter } from "./deliver";
import { sendRawToPrinter, RetryableSendError } from "./tcp-sender";
import { PrintHold, DEFAULT_HOLD_MS, MAX_HOLD_MS, type HeldJob } from "./print-hold";
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
 * Push-to-poll (v2.10.0). The server holds an idle poll open for up to this
 * many seconds and releases it the INSTANT a job becomes claimable (Redis wake
 * on its side), so the poll is the delivery channel — near-zero standing cost,
 * faster delivery than the old 2s hammer. Advertised via `X-Agent-Wait`; a
 * server that predates the header just answers immediately like before.
 *
 * POLL_FETCH_TIMEOUT_MS must stay comfortably ABOVE the advertised wait —
 * aborting a poll the server is still holding is how tickets get stranded at
 * 'printing' (reclaim is off server-side). 25s hold + 10s margin.
 *
 * ACK/NACK keep their own short 8s timeout — those are never held.
 */
const EXTENDED_WAIT_SECONDS = 25;
const POLL_FETCH_TIMEOUT_MS = (EXTENDED_WAIT_SECONDS + 10) * 1_000;

/**
 * Server-driven pacing: `X-Next-Poll-Ms` on every /api/print/pending response
 * says when this printer should poll next (short after a job to drain bursts,
 * short after a held 204 to re-arm the long-poll, long while paused). Absent
 * header (old server) → POLL_INTERVAL_MS, the pre-2.10 cadence. Clamped so a
 * bad header can neither hot-loop us nor silence a printer.
 */
const serverPollHint = new Map<string, number>();

function readPollHint(printerId: string, res: Response): void {
  const raw = res.headers.get("x-next-poll-ms");
  if (raw === null) {
    serverPollHint.delete(printerId);
    return;
  }
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return;
  serverPollHint.set(printerId, Math.min(Math.max(ms, 250), 60_000));
}

/**
 * When we last put bytes on a printer. The updater reads this so it never
 * restarts the agent in the middle of service.
 */
let lastPrintAt = 0;
export function msSinceLastPrint(): number {
  return lastPrintAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - lastPrintAt;
}

/**
 * Unreachable-printer hold (see print-hold.ts). Resolution of the window, in
 * order: the server's per-tenant value carried on the job payload
 * (`printHoldMs`, set by super admin so support can tune a branch remotely),
 * then this machine's Settings value, then the default. 0 = off (the pre-2.13
 * behaviour: NACK after the three quick attempts).
 */
const serverHoldHint = new Map<string, number>();

function readHoldHint(printerId: string, raw: unknown): void {
  if (raw === undefined) return; // old server: keep whatever we had
  if (raw === null) {
    serverHoldHint.delete(printerId); // server says "agent decides"
    return;
  }
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return;
  serverHoldHint.set(printerId, Math.min(Math.max(ms, 0), MAX_HOLD_MS));
}

export function resolveHoldMs(printerId: string, configHoldMs: number | undefined): number {
  const fromServer = serverHoldHint.get(printerId);
  if (fromServer !== undefined) return fromServer;
  if (typeof configHoldMs === "number" && Number.isFinite(configHoldMs)) {
    return Math.min(Math.max(configHoldMs, 0), MAX_HOLD_MS);
  }
  return DEFAULT_HOLD_MS;
}

interface HoldCtx {
  serverUrl: string;
  printer: PrinterEntry;
}

const hold = new PrintHold<HoldCtx>({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  // ONE attempt per tick — the hold's own backoff paces it. Network printers
  // only: a spooler failure is not a network blip, and deliverToPrinter's
  // quick triple already ran before the job got here.
  deliver: (job) => sendRawToPrinter(job.ctx.printer.host, job.ctx.printer.port || 9100, job.bytes),
  onPrinted: (job) => {
    lastPrintAt = Date.now();
    markPrinted(job.printJobId, job.ctx.printer.printerId, job.ctx.printer.agentKey);
    recordResult({ printerId: job.ctx.printer.printerId, printerName: job.ctx.printer.name, kind: "queued", ok: true });
    void ackJob(job.ctx.serverUrl, job.printJobId, job.ctx.printer.agentKey);
  },
  onGiveUp: (job, reason) => {
    recordResult({ printerId: job.ctx.printer.printerId, printerName: job.ctx.printer.name, kind: "queued", ok: false, error: reason });
    void nackJob(job.ctx.serverUrl, job.printJobId, job.ctx.printer.agentKey, reason);
  },
  isRetryable: (err) => err instanceof RetryableSendError,
  log: (msg) => logger.info(msg),
});

/** For the settings window / health: is anything being held right now? */
export function heldCount(printerId: string): number {
  return hold.size(printerId);
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

/**
 * Last drawer fingerprint we successfully reported, per printer.
 *
 * The config header rides the poll ONLY when this changes. `/api/print/pending`
 * is the highest-volume route on the platform, so a value sent on every poll
 * would put a database write on every poll for every printer, forever — the
 * shape of the Aug 5-7 2026 outage. Held in memory rather than persisted on
 * purpose: an agent restart re-reports once, which is a cheap way to heal a
 * report that was lost to a 500 or a network blip.
 */
const reportedDrawer = new Map<string, string>();

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
      // A definitive rejection (bad/unknown job id, revoked key) will never
      // succeed on retry. Leaving it pending made flushPendingAcks() replay it
      // on every tick forever — thousands of agents' dead acks compounded into
      // a request storm that pegged the prod app CPU (2026-07-28). Drop it;
      // only network failures and 5xx/429 are worth retrying.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        markAcked(printJobId);
      }
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

/**
 * Tell the server this job is HELD — the printer did not answer and the agent
 * is retrying it locally for `holdMs`. One request per job when it enters the
 * hold queue, fire-and-forget, never retried: a lost report costs the counter
 * a warning, never a ticket. The server keeps the job `printing` (ACK/NACK
 * still settle it) and lights the failed-print alert amber NOW, instead of red
 * when the hold expires. Before this (Belly Bro's, 2026-09-12) a 5-minute hold
 * was five minutes of silence at the counter, during which the cashier pressed
 * Print five more times and every copy joined the queue.
 * Older servers answer 400 for the unknown action; that is logged and ignored.
 */
function reportHeld(
  serverUrl: string,
  printJobId: string,
  agentKey: string,
  error: string,
  holdMs: number
): void {
  fetch(`${serverUrl}/api/print/${printJobId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentKey}`,
      "X-Agent-Version": app.getVersion(),
    },
    body:   JSON.stringify({ action: "hold", error: error.slice(0, 500), holdMs }),
    signal: AbortSignal.timeout(8_000),
  })
    .then((res) => {
      if (!res.ok) logger.warn(`[poll] hold report ${printJobId} HTTP ${res.status}`);
    })
    .catch((e) => logger.warn(`[poll] hold report ${printJobId} failed: ${(e as Error).message}`));
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
      // Opt into the server-side long-poll hold (see EXTENDED_WAIT_SECONDS).
      "X-Agent-Wait": String(EXTENDED_WAIT_SECONDS),
      ...dedupHeader(),
      // Tells the server this agent emits its own drawer kick from the
      // operator-verified pin/pulse below, so the server must NOT prepend one
      // of its own. Exactly one side emits.
      ...drawerHeaders(printer, reportedDrawer.get(printer.printerId) !== drawerFingerprint(printer)),
    },
    signal:  AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
  });

  readPollHint(printer.printerId, res);

  if (res.status === 204) return; // Idle — no queued jobs
  if (!res.ok) {
    logger.warn(`[poll] ${printer.printerId} HTTP ${res.status}`);
    return;
  }

  // The config header (if we sent one) reached the server with this request.
  // Record it only on a response we actually got back, so a dropped request
  // is retried rather than silently considered reported.
  reportedDrawer.set(printer.printerId, drawerFingerprint(printer));

  const { printJobId, bytesBase64, openDrawer, printHoldMs } = (await res.json()) as {
    printJobId:  string;
    bytesBase64: string;
    /** Cash changed hands — kick the drawer as this job goes out. Absent on
     *  older servers, which prepend the kick to the bytes themselves. */
    openDrawer?: boolean;
    /** Tenant's unreachable-printer hold window; null = agent decides. Absent on older servers. */
    printHoldMs?: number | null;
  };
  readHoldHint(printer.printerId, printHoldMs);

  // Redelivery of something we are still retrying locally (the server's
  // bounded reclaim re-serves an un-ACKed job after its grace). Printing this
  // copy too would double the ticket the moment the printer answers.
  if (hold.isHeld(printJobId)) {
    logger.info(`[poll] job ${printJobId} is held locally — redelivery ignored`);
    return;
  }

  logger.info(`[poll] received job ${printJobId} for ${printer.printerId}`);

  // Redelivery of something we already printed — the server simply never heard
  // our ACK. Re-ACK it and print nothing.
  if (hasPrinted(printJobId)) {
    logger.info(`[poll] job ${printJobId} already printed — re-acking, not reprinting`);
    await ackJob(serverUrl, printJobId, printer.agentKey);
    return;
  }

  // Prepended, never appended: the drawer opens while the paper is still
  // feeding, and a printer that jams halfway has already opened it. Returns
  // the bytes untouched when this printer has no drawer configured, so a
  // mis-set flag can never fire a solenoid pin on a kitchen printer.
  const bytes = withDrawerKick(
    Buffer.from(bytesBase64, "base64"),
    openDrawer ? printer : {}
  );
  const holdMs = printer.connection === "system" ? 0 : resolveHoldMs(printer.printerId, loadConfig().printHoldMs);

  // The printer is already being retried locally: join the back of its queue
  // so tickets stay in order, rather than burning 7s of connect attempts on a
  // printer we already know is not answering.
  if (holdMs > 0 && hold.has(printer.printerId)) {
    const joinedError = "printer still unreachable (joined hold queue)";
    const joined = hold.enqueue({
      printerId: printer.printerId, printJobId, bytes, holdMs,
      error: joinedError,
      ctx: { serverUrl, printer },
    });
    if (joined) {
      reportHeld(serverUrl, printJobId, printer.agentKey, joinedError, holdMs);
      return;
    }
    // Queue full — fall through and let the normal attempt/NACK path decide.
  }

  lastPrintAt = Date.now();
  try {
    await deliverToPrinter(printer, bytes);
  } catch (e) {
    const msg = (e as Error).message;
    // A PRE-CONNECT failure on a network printer is a blip until proven
    // otherwise: hold the bytes here and keep trying without the server.
    // Anything else (post-connect, spooler, hold off) is NACKed as before.
    if (holdMs > 0 && e instanceof RetryableSendError) {
      const held = hold.enqueue({
        printerId: printer.printerId, printJobId, bytes, holdMs, error: msg,
        ctx: { serverUrl, printer },
      });
      if (held) {
        reportHeld(serverUrl, printJobId, printer.agentKey, msg, holdMs);
        return;
      }
    }
    // Do NOT rethrow: an uncleared "printing" job on the server is reclaimed
    // as the OLDEST job on every subsequent poll, so it would head-of-line
    // block every newer ticket to this printer for as long as it's down.
    // NACKing fails the job server-side and frees the printer to move on.
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
      // timer. Every other printer is unaffected either way. When healthy,
      // the server's X-Next-Poll-Ms hint paces us (long-poll re-arm ≈250ms,
      // post-job drain ≈500ms, paused ≈5s); without a hint, the pre-2.10
      // 2s cadence. Note `last` is the poll's START time — a held long-poll
      // has already outlived any small hint by the time it returns, so the
      // next tick re-arms immediately, which is the point.
      const errCount = consecutiveErrors.get(p.printerId) ?? 0;
      const last     = lastAttemptAt.get(p.printerId) ?? 0;
      const interval = errCount > 5
        ? BACKOFF_INTERVAL_MS
        : (serverPollHint.get(p.printerId) ?? POLL_INTERVAL_MS);
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
