import { describe, it, expect } from "vitest";
import {
  normalizeOrderNumbering,
  formatOfflineRef,
  DEFAULT_ORDER_NUMBERING,
  type OrderNumberingConfig,
} from "./offline-ref";

// NOTE: the DB-backed atomic increment (UPDATE terminals ... RETURNING) lives in
// pos-repo.nextOfflineRef and is exercised by the integration script
// (scripts/offline-print-itest.mjs) — the encrypted-DB native module can't load
// under plain node/vitest. Here we prove the PURE properties that guarantee
// uniqueness: formatting is collision-proof across terminal codes, and a
// monotonic counter yields strictly distinct refs.

describe("normalizeOrderNumbering", () => {
  it("fills defaults (incl. the offline block) from an empty/garbage input", () => {
    expect(normalizeOrderNumbering(undefined)).toEqual(DEFAULT_ORDER_NUMBERING);
    expect(normalizeOrderNumbering("nope").offline).toEqual({ marker: "OFF", includeTerminal: true });
  });

  it("honors a web-supplied offline block and shared formatting fields", () => {
    const cfg = normalizeOrderNumbering({
      separator: "/",
      padLength: 4,
      offline: { marker: "off", includeTerminal: false },
    });
    expect(cfg.separator).toBe("/");
    expect(cfg.padLength).toBe(4);
    expect(cfg.offline).toEqual({ marker: "OFF", includeTerminal: false });
  });
});

describe("formatOfflineRef", () => {
  const cfg = DEFAULT_ORDER_NUMBERING; // sep "-", padLength 5, marker "OFF"

  it("formats as {marker}-{terminalCode}-{seq} using the shared separator + padLength", () => {
    expect(formatOfflineRef(cfg, "A7", 1)).toBe("OFF-A7-00001");
    expect(formatOfflineRef(cfg, "a7", 42)).toBe("OFF-A7-00042"); // code upper-cased
  });

  it("reuses a custom separator and padLength from the web config", () => {
    const custom = normalizeOrderNumbering({ separator: "/", padLength: 3 });
    expect(formatOfflineRef(custom, "K9", 5)).toBe("OFF/K9/005");
  });

  it("omits the terminal segment when includeTerminal is false", () => {
    const noTerm = normalizeOrderNumbering({ offline: { marker: "OFF", includeTerminal: false } });
    expect(formatOfflineRef(noTerm, "A7", 1)).toBe("OFF-00001");
  });

  it("never collides across two different terminal codes at the same seq", () => {
    for (let seq = 1; seq <= 1000; seq++) {
      expect(formatOfflineRef(cfg, "T1", seq)).not.toBe(formatOfflineRef(cfg, "T2", seq));
    }
  });

  it("produces globally-unique refs when each terminal drives its own monotonic counter", () => {
    // Simulate the per-terminal atomic counter (terminals.offline_seq): each
    // terminal increments independently; refs must be unique across the fleet.
    const counters = new Map<string, number>();
    const nextRef = (code: string): string => {
      const seq = (counters.get(code) ?? 0) + 1; // mirrors UPDATE ... offline_seq + 1 RETURNING
      counters.set(code, seq);
      return formatOfflineRef(cfg, code, seq);
    };

    const seen = new Set<string>();
    const codes = ["T1", "T2", "KITCHEN", "BAR"];
    for (let i = 0; i < 500; i++) {
      for (const code of codes) {
        const ref = nextRef(code);
        expect(seen.has(ref)).toBe(false); // no duplicate ever
        seen.add(ref);
      }
    }
    // Each terminal produced a strictly increasing series 1..500.
    expect([...counters.values()]).toEqual([500, 500, 500, 500]);
    expect(seen.size).toBe(codes.length * 500);
  });
});
