/**
 * Persistent idempotency guard for POS mutations. Aster sends a stable
 * `idempotencyKey` per submission and reuses it on retry; if we've already
 * applied that key we return the prior order id instead of re-applying +
 * re-printing. Survives restart (lives in the encrypted DB).
 */
import { getStore } from "./db";

export function getAppliedOrderId(key: string): string | null {
  const row = getStore()
    .prepare("SELECT order_id FROM applied_mutations WHERE idempotency_key = ?")
    .get(key) as { order_id: string } | undefined;
  return row?.order_id ?? null;
}

export function recordApplied(key: string, orderId: string, now: number = Date.now()): void {
  getStore()
    .prepare(
      "INSERT INTO applied_mutations (idempotency_key, order_id, applied_at) VALUES (?,?,?) ON CONFLICT(idempotency_key) DO NOTHING"
    )
    .run(key, orderId, now);
}

/** Drop idempotency records older than the retention window (retries happen in
 *  seconds; a couple of days is far more than enough). */
export function pruneAppliedMutations(olderThanMs: number, now: number = Date.now()): number {
  const info = getStore()
    .prepare("DELETE FROM applied_mutations WHERE applied_at < ?")
    .run(now - olderThanMs);
  return info.changes;
}
