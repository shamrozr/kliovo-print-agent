/**
 * Print dedup ledger — the agent half of exactly-once printing.
 *
 * The contract with Dine:
 *   server = at-least-once  (it redelivers any job it never heard an ACK for)
 *   agent  = idempotent     (this ledger refuses to print the same job twice)
 *
 * Only the agent knows whether paper actually came out, so the memory of "this
 * job is done" has to live here and has to survive a restart.
 *
 * Availability is deliberately explicit (`isLedgerReady`): the offline store is
 * allowed to fail without blocking printing, so if this ledger isn't up we tell
 * the server we can't dedup and it falls back to never redelivering. That
 * degrades to "might miss a ticket" rather than "might print two".
 */
import { getStore } from "./db";
import { logger } from "../logger";

/** Keep the ledger long enough to outlive any plausible redelivery window. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let ready = false;

/** Call once after initStore(). Cheap probe so callers can trust the ledger. */
export function initPrintLedger(): void {
  try {
    getStore().prepare("SELECT 1 FROM printed_jobs LIMIT 1").get();
    getStore().exec(`CREATE TABLE IF NOT EXISTS pending_print_sends (
      print_job_id TEXT PRIMARY KEY, printer_id TEXT NOT NULL, agent_key TEXT NOT NULL,
      attempted_at INTEGER NOT NULL, error TEXT NOT NULL
    )`);
    ready = true;
    logger.info("[ledger] print dedup ledger ready");
  } catch (e) {
    ready = false;
    logger.error(
      `[ledger] UNAVAILABLE — dedup disabled, server will not redeliver: ${(e as Error).message}`
    );
  }
}

export function isLedgerReady(): boolean {
  return ready;
}

/** Has this job already hit paper? Fail-safe: on error, claim "yes". */
export function hasPrinted(printJobId: string): boolean {
  if (!ready) return false;
  try {
    return !!getStore()
      .prepare("SELECT 1 FROM printed_jobs WHERE print_job_id = ?")
      .get(printJobId);
  } catch (e) {
    // If we cannot tell, prefer NOT printing again. A missing ticket is
    // recoverable with a manual reprint; a duplicate one is not.
    logger.error(`[ledger] hasPrinted failed for ${printJobId}: ${(e as Error).message}`);
    return true;
  }
}

/**
 * Record that bytes reached the printer. MUST be called immediately after a
 * successful send and before the ACK — that ordering is what bounds the
 * crash window to the microseconds between the two.
 */
export function markPrinted(printJobId: string, printerId: string, agentKey: string): void {
  if (!ready) return;
  try {
    getStore()
      .prepare(
        `INSERT INTO printed_jobs (print_job_id, printer_id, agent_key, printed_at, acked)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(print_job_id) DO NOTHING`
      )
      .run(printJobId, printerId, agentKey, Date.now());
    clearSendAttempt(printJobId);
  } catch (e) {
    logger.error(`[ledger] markPrinted failed for ${printJobId}: ${(e as Error).message}`);
  }
}

/** Write intent BEFORE touching the socket. A restart mid-send is uncertain,
 * never permission to replay bytes. Only a proven pre-connect error clears it. */
export function beginSendAttempt(printJobId: string, printerId: string, agentKey: string): boolean {
  if (!ready) return false;
  try {
    getStore().prepare(`INSERT INTO pending_print_sends (print_job_id, printer_id, agent_key, attempted_at, error)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(print_job_id) DO NOTHING`)
      .run(printJobId, printerId, agentKey, Date.now(), "Delivery interrupted — check the kitchen for a ticket before reprinting");
    return true;
  } catch (e) {
    logger.error(`[ledger] send intent failed for ${printJobId}: ${(e as Error).message}`);
    return false;
  }
}

export function clearSendAttempt(printJobId: string): void {
  if (!ready) return;
  try { getStore().prepare("DELETE FROM pending_print_sends WHERE print_job_id = ?").run(printJobId); }
  catch (e) { logger.error(`[ledger] clearing send intent failed: ${(e as Error).message}`); }
}

export function pendingUncertainSends(limit = 25): (PendingAck & { error: string })[] {
  if (!ready) return [];
  try {
    return getStore().prepare(`SELECT print_job_id AS printJobId, printer_id AS printerId, agent_key AS agentKey, error
      FROM pending_print_sends ORDER BY attempted_at LIMIT ?`).all(limit) as (PendingAck & { error: string })[];
  } catch { return []; }
}

export function uncertainSend(printJobId: string): boolean {
  if (!ready) return false;
  try { return !!getStore().prepare("SELECT 1 FROM pending_print_sends WHERE print_job_id = ?").get(printJobId); }
  catch { return true; }
}

export function markAcked(printJobId: string): void {
  if (!ready) return;
  try {
    getStore()
      .prepare("UPDATE printed_jobs SET acked = 1 WHERE print_job_id = ?")
      .run(printJobId);
  } catch (e) {
    logger.error(`[ledger] markAcked failed for ${printJobId}: ${(e as Error).message}`);
  }
}

export interface PendingAck {
  printJobId: string;
  printerId:  string;
  agentKey:   string;
}

/** Printed but the server was never told — retried on later ticks. */
export function pendingAcks(limit = 25): PendingAck[] {
  if (!ready) return [];
  try {
    const rows = getStore()
      .prepare(
        `SELECT print_job_id AS printJobId, printer_id AS printerId, agent_key AS agentKey
           FROM printed_jobs
          WHERE acked = 0
          ORDER BY printed_at ASC
          LIMIT ?`
      )
      .all(limit) as PendingAck[];
    return rows;
  } catch (e) {
    logger.error(`[ledger] pendingAcks failed: ${(e as Error).message}`);
    return [];
  }
}

/** Drop acked rows past the retention window. Unacked rows are never dropped. */
export function prunePrintLedger(now: number = Date.now()): number {
  if (!ready) return 0;
  try {
    const res = getStore()
      .prepare("DELETE FROM printed_jobs WHERE acked = 1 AND printed_at < ?")
      .run(now - RETENTION_MS);
    return res.changes;
  } catch (e) {
    logger.error(`[ledger] prune failed: ${(e as Error).message}`);
    return 0;
  }
}
