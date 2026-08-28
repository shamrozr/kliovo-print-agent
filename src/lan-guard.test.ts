import { describe, it, expect } from "vitest";
import { isLanRouteAllowed, isLoopbackAddr, isPrivateLanAddr } from "./lan-guard";

describe("LAN access guards", () => {
  it("treats IPv4-mapped IPv6 loopback as local", () => {
    expect(isLoopbackAddr("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddr("::1")).toBe(true);
    expect(isLoopbackAddr("192.168.1.20")).toBe(false);
  });

  it("accepts branch-network addresses and refuses everything else", () => {
    ["192.168.1.20", "10.0.0.5", "172.16.4.9", "172.31.255.254", "::ffff:192.168.0.3"].forEach((a) =>
      expect(isPrivateLanAddr(a)).toBe(true)
    );
    // 172.32.x is OUTSIDE RFC1918 — the classic off-by-one in this check.
    ["8.8.8.8", "172.32.0.1", "203.0.113.7", ""].forEach((a) => expect(isPrivateLanAddr(a)).toBe(false));
  });

  it("exposes only the POS routes over the LAN", () => {
    ["/ping", "/local/auth", "/local/pos/menu", "/local/pos/order/create", "/local/print/reprint"].forEach((u) =>
      expect(isLanRouteAllowed(u)).toBe(true)
    );
    // Pairing, the mirror, the sync outbox and the unauthenticated device routes
    // stay on this machine. A route added later is refused until it is listed.
    ["/local/pair", "/local/mirror", "/local/mark-synced", "/local/unsynced", "/biometric/devices", "/iclock/cdata", "/print", "/render-print", "/status"].forEach(
      (u) => expect(isLanRouteAllowed(u)).toBe(false)
    );
  });

  it("ignores the query string when matching a route", () => {
    expect(isLanRouteAllowed("/local/pos/orders?since=123")).toBe(true);
    expect(isLanRouteAllowed("/local/mirror?x=/local/pos/")).toBe(false);
  });
});
