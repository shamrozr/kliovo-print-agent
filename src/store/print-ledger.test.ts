import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }));
vi.mock("./db", () => ({ getStore: () => state.db }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { initPrintLedger, beginSendAttempt, uncertainSend, pendingUncertainSends, clearSendAttempt, markPrinted, hasPrinted, pendingAcks } from "./print-ledger";
beforeEach(() => {
  state.db = new DatabaseSync(":memory:");
  state.db.exec(`CREATE TABLE printed_jobs (print_job_id TEXT PRIMARY KEY, printer_id TEXT, agent_key TEXT, printed_at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0)`);
  initPrintLedger();
});
afterEach(() => state.db.close());
describe("durable send intent", () => {
  it("retains an interrupted send across ledger initialization/restart without claiming success", () => {
    expect(beginSendAttempt("job", "printer", "secret")).toBe(true);
    initPrintLedger();
    expect(uncertainSend("job")).toBe(true);
    expect(hasPrinted("job")).toBe(false);
    expect(pendingUncertainSends()).toMatchObject([{ printJobId: "job" }]);
    expect(pendingAcks()).toEqual([]);
  });
  it("clears intent only for a proven pre-connect failure or accepted NACK", () => {
    beginSendAttempt("job", "printer", "secret");
    clearSendAttempt("job");
    expect(uncertainSend("job")).toBe(false);
  });
  it("successful delivery records a pending ACK and removes uncertainty", () => {
    beginSendAttempt("job", "printer", "secret");
    markPrinted("job", "printer", "secret");
    expect(hasPrinted("job")).toBe(true);
    expect(uncertainSend("job")).toBe(false);
    expect(pendingAcks()).toMatchObject([{ printJobId: "job" }]);
  });
  it("does not erase send intent when recording success fails", () => {
    beginSendAttempt("job", "printer", "secret");
    state.db.exec("DROP TABLE printed_jobs");
    markPrinted("job", "printer", "secret");
    expect(uncertainSend("job")).toBe(true);
  });
  it("refuses to send if the intent cannot be persisted", () => {
    state.db.exec("DROP TABLE pending_print_sends");
    expect(beginSendAttempt("job", "printer", "secret")).toBe(false);
  });
});
