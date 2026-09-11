import { describe, it, expect, vi } from "vitest";
import { PrintHold, HOLD_BACKOFF_MS, type HoldDeps } from "./print-hold";

/** Deterministic clock + timer that only fires when the test advances time. */
function fakeTime() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    /** Advance and run every timer that comes due, in order, awaiting async work. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        now = next.at;
        timers.shift();
        await next.fn();
        // let promise chains settle
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    },
    pending: () => timers.length,
  };
}

class Retryable extends Error {}

function makeHold(opts: { deliverImpl?: (printerId: string, jobId: string) => Promise<void> } = {}) {
  const t = fakeTime();
  const printed: string[] = [];
  const gaveUp: { jobId: string; reason: string }[] = [];
  const deliver = vi.fn(opts.deliverImpl ?? (async () => {}));
  const deps: HoldDeps = {
    now: t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    deliver: (job) => deliver(job.printerId, job.printJobId),
    onPrinted: (job) => {
      printed.push(job.printJobId);
    },
    onGiveUp: (job, reason) => {
      gaveUp.push({ jobId: job.printJobId, reason });
    },
    isRetryable: (e) => e instanceof Retryable,
    log: () => {},
  };
  const hold = new PrintHold(deps);
  return { hold, t, printed, gaveUp, deliver };
}

const bytes = Buffer.from("x");

describe("PrintHold", () => {
  it("prints a held job on the first retry that reaches the printer, then acks", async () => {
    let fail = true;
    const { hold, t, printed, gaveUp, deliver } = makeHold({
      deliverImpl: async () => {
        if (fail) throw new Retryable("TCP connect timeout");
      },
    });
    hold.enqueue({ printerId: "p1", printJobId: "j1", bytes, holdMs: 60_000, error: "TCP connect timeout", ctx: {} });
    expect(hold.isHeld("j1")).toBe(true);
    expect(hold.has("p1")).toBe(true);

    await t.advance(HOLD_BACKOFF_MS[0]); // attempt 1 fails
    expect(deliver).toHaveBeenCalledTimes(1);
    fail = false;
    await t.advance(HOLD_BACKOFF_MS[1]); // attempt 2 succeeds
    expect(printed).toEqual(["j1"]);
    expect(gaveUp).toEqual([]);
    expect(hold.isHeld("j1")).toBe(false);
    expect(hold.has("p1")).toBe(false);
  });

  it("gives up with an aggregated reason once the job's own window expires", async () => {
    const { hold, t, gaveUp, deliver } = makeHold({
      deliverImpl: async () => {
        throw new Retryable("TCP connect timeout after 2000ms to 10.0.0.9:9100");
      },
    });
    hold.enqueue({ printerId: "p1", printJobId: "j1", bytes, holdMs: 30_000, error: "TCP connect timeout after 2000ms to 10.0.0.9:9100", ctx: {} });
    await t.advance(60_000);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0].jobId).toBe("j1");
    expect(gaveUp[0].reason).toMatch(/^Printer unreachable for \d+s \(\d+ attempts\): TCP connect timeout/);
    expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(hold.has("p1")).toBe(false);
    expect(t.pending()).toBe(0); // no timer left running for an empty printer
  });

  it("keeps ticket order: jobs queued behind a held one flush FIFO when the printer returns", async () => {
    let fail = true;
    const { hold, t, printed } = makeHold({
      deliverImpl: async () => {
        if (fail) throw new Retryable("down");
      },
    });
    hold.enqueue({ printerId: "p1", printJobId: "j1", bytes, holdMs: 60_000, error: "down", ctx: {} });
    hold.enqueue({ printerId: "p1", printJobId: "j2", bytes, holdMs: 60_000, error: "down", ctx: {} });
    hold.enqueue({ printerId: "p1", printJobId: "j3", bytes, holdMs: 60_000, error: "down", ctx: {} });
    await t.advance(HOLD_BACKOFF_MS[0]);
    fail = false;
    await t.advance(30_000);
    expect(printed).toEqual(["j1", "j2", "j3"]);
    expect(hold.has("p1")).toBe(false);
  });

  it("a redelivered id that is already held is recognised and not enqueued twice", () => {
    const { hold } = makeHold({ deliverImpl: async () => { throw new Retryable("down"); } });
    hold.enqueue({ printerId: "p1", printJobId: "j1", bytes, holdMs: 60_000, error: "down", ctx: {} });
    const second = hold.enqueue({ printerId: "p1", printJobId: "j1", bytes, holdMs: 60_000, error: "down", ctx: {} });
    expect(second).toBe(false);
    expect(hold.size("p1")).toBe(1);
  });

  it("a NON-retryable error (bytes may be on the wire) gives up immediately, never retries", async () => {
    const { hold, t, gaveUp, deliver } = makeHold({
      deliverImpl: async () => {
        throw new Error("TCP timeout after connect to 10.0.0.9:9100");
      },
    });
    hold.enqueue({ printerId: "p1", printJobId: "j1", bytes, holdMs: 60_000, error: "down", ctx: {} });
    await t.advance(HOLD_BACKOFF_MS[0]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0].reason).toContain("TCP timeout after connect");
    await t.advance(120_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("an expired job behind a live one is given up without blocking the live one", async () => {
    let fail = true;
    const { hold, t, printed, gaveUp } = makeHold({
      deliverImpl: async () => {
        if (fail) throw new Retryable("down");
      },
    });
    hold.enqueue({ printerId: "p1", printJobId: "old", bytes, holdMs: 5_000, error: "down", ctx: {} });
    hold.enqueue({ printerId: "p1", printJobId: "new", bytes, holdMs: 120_000, error: "down", ctx: {} });
    await t.advance(20_000); // "old" expires while the printer is still down
    expect(gaveUp.map((g) => g.jobId)).toEqual(["old"]);
    fail = false;
    await t.advance(30_000);
    expect(printed).toEqual(["new"]);
  });

  it("printers are independent — one held printer never delays another", async () => {
    const { hold, t, printed } = makeHold({
      deliverImpl: async (printerId) => {
        if (printerId === "dead") throw new Retryable("down");
      },
    });
    hold.enqueue({ printerId: "dead", printJobId: "d1", bytes, holdMs: 60_000, error: "down", ctx: {} });
    hold.enqueue({ printerId: "ok", printJobId: "o1", bytes, holdMs: 60_000, error: "down", ctx: {} });
    await t.advance(HOLD_BACKOFF_MS[0]);
    expect(printed).toEqual(["o1"]);
    expect(hold.has("dead")).toBe(true);
    expect(hold.has("ok")).toBe(false);
  });

  it("backs off between attempts on a dead printer and caps the interval", async () => {
    const { hold, t, deliver } = makeHold({ deliverImpl: async () => { throw new Retryable("down"); } });
    hold.enqueue({ printerId: "p1", printJobId: "j1", bytes, holdMs: 300_000, error: "down", ctx: {} });
    await t.advance(300_000);
    const cap = HOLD_BACKOFF_MS[HOLD_BACKOFF_MS.length - 1];
    const minCalls = Math.floor((300_000 - HOLD_BACKOFF_MS.reduce((a, b) => a + b, 0)) / cap);
    expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(minCalls);
    expect(deliver.mock.calls.length).toBeLessThan(300_000 / 1_000); // never a hot loop
  });
});
