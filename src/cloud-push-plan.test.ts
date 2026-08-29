import { describe, it, expect } from "vitest";
import { planPushSettlement } from "./cloud-push-plan";

const o = (ref: string) => ({ orderId: `id-${ref}`, payload: { offlineRef: ref } });

describe("planPushSettlement", () => {
  it("settles everything when the server asks for no retries", () => {
    const pushed = [o("OFF-T1-00001"), o("OFF-T1-00002")];
    const { settled, retry } = planPushSettlement(pushed, { accepted: 2, retry: [] });
    expect(settled).toHaveLength(2);
    expect(retry).toHaveLength(0);
  });

  it("keeps a retried ref queued and settles the rest", () => {
    const pushed = [o("OFF-T1-00001"), o("OFF-T1-00002"), o("OFF-T1-00003")];
    const { settled, retry } = planPushSettlement(pushed, {
      accepted: 2,
      retry: ["OFF-T1-00002"],
    });
    expect(settled.map((s) => s.payload.offlineRef)).toEqual(["OFF-T1-00001", "OFF-T1-00003"]);
    expect(retry.map((r) => r.payload.offlineRef)).toEqual(["OFF-T1-00002"]);
  });

  it("settles nothing when the server could take nothing", () => {
    const pushed = [o("OFF-T1-00001")];
    const { settled, retry } = planPushSettlement(pushed, {
      accepted: 0,
      retry: ["OFF-T1-00001"],
    });
    expect(settled).toHaveLength(0);
    expect(retry).toHaveLength(1);
  });

  it("accepted:0 with no retry list still settles — the server declined them for good", () => {
    // A ref a human already resolved is reported skipped, never retried. Holding
    // it forever would be a standing poll for nothing.
    const pushed = [o("OFF-T1-00001")];
    const { settled, retry } = planPushSettlement(pushed, { accepted: 0, retry: [] });
    expect(settled).toHaveLength(1);
    expect(retry).toHaveLength(0);
  });

  it("an older server that sends no retry field settles everything (no deadlock)", () => {
    const pushed = [o("OFF-T1-00001"), o("OFF-T1-00002")];
    expect(planPushSettlement(pushed, { accepted: 2 }).settled).toHaveLength(2);
    expect(planPushSettlement(pushed, null).settled).toHaveLength(2);
  });
});
