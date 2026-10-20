/**
 * Local hold-and-retry for unreachable network printers.
 *
 * Why this exists (Belly Bro's, 2026-09-12): a kitchen printer on Wi-Fi went
 * quiet for ~2 minutes, twelve times over two evenings. Each time the agent
 * gave up after ~7s (three quick connect attempts), NACKed, and the ticket was
 * parked `failed` on the server until a cashier pressed Reprint. The bytes
 * were on this machine the whole time; nothing the server could do would have
 * helped, and every "fix" cost a human and a round-trip.
 *
 * So: after the quick attempts fail with a PRE-CONNECT error, the job is held
 * here — per printer, FIFO — and retried on a backoff schedule for up to its
 * own hold window. Success takes the normal path (ledger → ACK). Expiry NACKs
 * with an aggregated reason, so the failed-print alert on the counter says how
 * long the agent tried. The delivery callback validates eligibility with the
 * server before each attempt, so cached bytes cannot outlive the order.
 *
 * Invariants:
 *  - Only RetryableSendError (failed BEFORE connect) is retried. A failure after
 *    connect means bytes may be on the wire; retrying that is the 2026-07-17
 *    duplicate incident. `isRetryable` is the tcp-sender boundary, not a new one.
 *  - The server redelivers a job it has not heard about after its 20s grace
 *    (bounded reclaim). `isHeld` lets the poll loop recognise the redelivered
 *    id and drop the copy — otherwise the same ticket prints twice the moment
 *    the printer answers. This is separate from the printed-jobs ledger, which
 *    only knows jobs that already reached paper.
 *  - A hold window must stay under the server's 20-minute stuck sweeper, or the
 *    job is failed underneath us. The caller clamps; MAX_HOLD_MS is the ceiling.
 *  - Order is preserved per printer. Anything delivered for a printer that is
 *    already held joins the back of its queue; the flush is FIFO with a short
 *    gap so a burst prints as a burst.
 *  - Printers are independent: one dead printer's timer never touches another.
 *  - Pure: no electron, no store, no net. Everything external is injected, so
 *    this runs under plain vitest with a fake clock.
 */

export interface HeldJob<C = unknown> {
  printerId: string;
  printJobId: string;
  bytes: Buffer;
  /** Per-job deadline — each ticket gets its own window from when IT was held. */
  holdMs: number;
  /** The error that put it here (the last quick-attempt failure). */
  error: string;
  /** Opaque caller context (server url, agent key, printer entry …). */
  ctx: C;
  enqueuedAt: number;
  attempts: number;
  lastError: string;
}

export interface HoldDeps<C = unknown> {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** One delivery attempt. Throws on failure; `isRetryable(err)` decides what happens next. */
  deliver(job: HeldJob<C>): Promise<void>;
  /** Bytes reached the printer — caller records the ledger and ACKs. */
  onPrinted(job: HeldJob<C>): void;
  /** Window expired or a non-retryable error — caller NACKs with `reason`. */
  onGiveUp(job: HeldJob<C>, reason: string): void;
  /** Server revoked a buffered ticket: release it without NACKing a settled row. */
  onDiscard?(job: HeldJob<C>, reason: string): void;
  isRetryable(err: unknown): boolean;
  log(msg: string): void;
}

/** Backoff between attempts on a printer that keeps refusing; the last value repeats. */
export const HOLD_BACKOFF_MS = [3_000, 5_000, 10_000, 15_000, 20_000];
/** Gap between consecutive tickets once a printer answers again. */
const FLUSH_GAP_MS = 300;
/** Ceiling — the server's stuck-printing sweeper is 20 minutes. */
export const MAX_HOLD_MS = 5 * 60 * 1000;
export const DEFAULT_HOLD_MS = 60 * 1000;
export class DiscardHeldPrint extends Error {}
/** Bounded so a dead printer during a long outage cannot grow memory without limit. */
const MAX_QUEUE_PER_PRINTER = 200;

interface PrinterState<C> {
  queue: HeldJob<C>[];
  timer: unknown | null;
  consecutiveFailures: number;
  running: boolean;
}

export class PrintHold<C = unknown> {
  private printers = new Map<string, PrinterState<C>>();
  private held = new Set<string>();

  constructor(private deps: HoldDeps<C>) {}

  /** Is this job id currently waiting here? (Redelivery guard for the poll loop.) */
  isHeld(printJobId: string): boolean {
    return this.held.has(printJobId);
  }

  /** Does this printer have anything held? New jobs for it should join the queue. */
  has(printerId: string): boolean {
    const s = this.printers.get(printerId);
    return !!s && s.queue.length > 0;
  }

  size(printerId: string): number {
    return this.printers.get(printerId)?.queue.length ?? 0;
  }

  /**
   * Hold a job. Returns false when the id is already held (a redelivery) or the
   * printer's queue is full — in the latter case the caller should NACK so the
   * server keeps the ticket rather than the agent silently dropping it.
   */
  enqueue(input: Omit<HeldJob<C>, "enqueuedAt" | "attempts" | "lastError">): boolean {
    if (this.held.has(input.printJobId)) {
      this.deps.log(`[hold] ${input.printJobId} already held — redelivery ignored`);
      return false;
    }
    let s = this.printers.get(input.printerId);
    if (!s) {
      s = { queue: [], timer: null, consecutiveFailures: 0, running: false };
      this.printers.set(input.printerId, s);
    }
    if (s.queue.length >= MAX_QUEUE_PER_PRINTER) {
      this.deps.log(`[hold] ${input.printerId} queue full (${s.queue.length}) — refusing ${input.printJobId}`);
      return false;
    }
    const holdMs = Math.max(0, Math.min(input.holdMs, MAX_HOLD_MS));
    const job: HeldJob<C> = {
      ...input,
      holdMs,
      enqueuedAt: this.deps.now(),
      attempts: 0,
      lastError: input.error,
    };
    s.queue.push(job);
    this.held.add(job.printJobId);
    this.deps.log(
      `[hold] holding ${job.printJobId} for ${job.printerId} up to ${Math.round(holdMs / 1000)}s (queue ${s.queue.length}): ${job.error}`
    );
    if (s.timer === null && !s.running) this.schedule(input.printerId, s, this.nextDelay(s));
    return true;
  }

  private nextDelay(s: PrinterState<C>): number {
    const i = Math.min(s.consecutiveFailures, HOLD_BACKOFF_MS.length - 1);
    return HOLD_BACKOFF_MS[i];
  }

  private schedule(printerId: string, s: PrinterState<C>, ms: number): void {
    if (s.timer !== null) this.deps.clearTimer(s.timer);
    s.timer = this.deps.setTimer(() => {
      s.timer = null;
      void this.tick(printerId, s);
    }, ms);
  }

  private release(job: HeldJob<C>, s: PrinterState<C>): void {
    const i = s.queue.indexOf(job);
    if (i >= 0) s.queue.splice(i, 1);
    this.held.delete(job.printJobId);
  }

  private giveUp(job: HeldJob<C>, s: PrinterState<C>, reason: string): void {
    this.release(job, s);
    this.deps.log(`[hold] giving up ${job.printJobId} on ${job.printerId}: ${reason}`);
    this.deps.onGiveUp(job, reason);
  }

  private expiredReason(job: HeldJob<C>): string {
    const secs = Math.round((this.deps.now() - job.enqueuedAt) / 1000);
    return `Printer unreachable for ${secs}s (${job.attempts} attempts): ${job.lastError}`;
  }

  private async tick(printerId: string, s: PrinterState<C>): Promise<void> {
    if (s.running) return;
    s.running = true;
    try {
      // Anything whose own window has closed leaves first — an expired ticket
      // must not gate a newer one that could still make it to paper.
      for (const job of [...s.queue]) {
        if (this.deps.now() - job.enqueuedAt >= job.holdMs) this.giveUp(job, s, this.expiredReason(job));
      }
      const head = s.queue[0];
      if (!head) return;

      head.attempts += 1;
      try {
        await this.deps.deliver(head);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (err instanceof DiscardHeldPrint) {
          this.release(head, s);
          this.deps.log(`[hold] discarded ${head.printJobId}: ${err.message}`);
          this.deps.onDiscard?.(head, err.message);
          if (s.queue.length > 0) this.schedule(printerId, s, FLUSH_GAP_MS);
          return;
        }
        head.lastError = err.message;
        if (!this.deps.isRetryable(err)) {
          // Connected, then failed: bytes may already be on the wire. Never retry.
          this.giveUp(head, s, err.message);
          // The printer answered the connect, so the next ticket gets a normal go.
          s.consecutiveFailures = 0;
          if (s.queue.length > 0) this.schedule(printerId, s, FLUSH_GAP_MS);
          return;
        }
        s.consecutiveFailures += 1;
        if (this.deps.now() - head.enqueuedAt >= head.holdMs) this.giveUp(head, s, this.expiredReason(head));
        if (s.queue.length > 0) this.schedule(printerId, s, this.nextDelay(s));
        return;
      }

      // Printed.
      s.consecutiveFailures = 0;
      this.release(head, s);
      this.deps.log(`[hold] printed ${head.printJobId} on ${printerId} after ${head.attempts} attempt(s)`);
      this.deps.onPrinted(head);
      if (s.queue.length > 0) this.schedule(printerId, s, FLUSH_GAP_MS);
    } finally {
      s.running = false;
      if (s.queue.length === 0 && s.timer === null) this.printers.delete(printerId);
    }
  }
}
