import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { authorizeHeldDelivery } from "./held-validation";
import { DiscardHeldPrint } from "./print-hold";
import { RetryableSendError } from "./tcp-sender";
afterEach(() => vi.unstubAllGlobals());
function response(data: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status })));
}
describe("held delivery authorization", () => {
  it("permits only explicit server authorization", async () => {
    response({ success: true, data: { allowed: true } });
    await expect(authorizeHeldDelivery("https://dine.test", "job", "secret")).resolves.toBeUndefined();
  });
  it.each(["Ticket expired", "Order served", "Replacement printed", "Ticket dismissed"])("discards %s without retrying bytes", async reason => {
    response({ success: true, data: { allowed: false, reason } });
    await expect(authorizeHeldDelivery("https://dine.test", "job", "secret")).rejects.toBeInstanceOf(DiscardHeldPrint);
  });
  it("discards deleted jobs", async () => {
    response({}, 404);
    await expect(authorizeHeldDelivery("https://dine.test", "job", "secret")).rejects.toBeInstanceOf(DiscardHeldPrint);
  });
  it.each([{}, { success: true }, { success: true, data: { allowed: "yes" } }])("fails closed on malformed/older server responses", async body => {
    response(body);
    await expect(authorizeHeldDelivery("https://dine.test", "job", "secret")).rejects.toBeInstanceOf(RetryableSendError);
  });
  it("does not deliver while paused", async () => {
    response({ success: true, data: { allowed: false, retry: true } });
    await expect(authorizeHeldDelivery("https://dine.test", "job", "secret")).rejects.toBeInstanceOf(RetryableSendError);
  });
  it("does not deliver during cloud outages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(authorizeHeldDelivery("https://dine.test", "job", "secret")).rejects.toBeInstanceOf(RetryableSendError);
  });
});
