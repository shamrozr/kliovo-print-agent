/**
 * What a push response actually settles.
 *
 * Pure — no store, no electron, no fetch — so the rule can be tested directly.
 *
 * A 200 is NOT "synced". The push endpoint parks orders in a review queue and
 * answers `retry` with the refs it could not take (a transient failure on its
 * side). Everything else it either staged, or deliberately declined for good —
 * a human already resolved it, or the payload was malformed — and re-sending
 * those forever would be a standing poll for nothing.
 *
 * `pushOnce` used to mark EVERY pushed order regardless, reading `accepted` only
 * to log it. So when the server answered `accepted: 0` the agent still reported
 * synced and never sent those orders again: the till said done and the branch
 * never saw them. That is half of the Desi Dastarkhawan symptom ("it says
 * synced but not showing"); the other half was server-side.
 */
export interface PushableOrder {
  orderId: string;
  payload: { offlineRef: string };
}

export interface PushResponseBody {
  accepted?: number;
  enabled?: boolean;
  retry?: string[];
}

/**
 * Split what was pushed into what may be marked synced and what stays queued.
 * A server that does not send `retry` (older build) settles everything, which
 * is the previous behaviour — so an agent never blocks on an old server.
 */
export function planPushSettlement<T extends PushableOrder>(
  pushed: T[],
  body: PushResponseBody | null
): { settled: T[]; retry: T[] } {
  const refs = new Set(Array.isArray(body?.retry) ? body!.retry! : []);
  if (refs.size === 0) return { settled: pushed, retry: [] };
  const settled: T[] = [];
  const retry: T[] = [];
  for (const o of pushed) (refs.has(o.payload.offlineRef) ? retry : settled).push(o);
  return { settled, retry };
}
