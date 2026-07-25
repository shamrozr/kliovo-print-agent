import { describe, it, expect } from "vitest";
import { mergeRoutes, resolveKotTargets, resolveReceiptTarget, toPrinterEntry, type MirroredPrinter, type MirroredRoute } from "./router";

const kitchen: MirroredPrinter = { id: "pk", name: "Kitchen", connection: "network", host: "10.0.0.5", port: 9100, is_active: 1 };
const bar: MirroredPrinter = { id: "pb", name: "Bar", connection: "network", host: "10.0.0.6", port: 9100, is_active: 1 };
const cashier: MirroredPrinter = { id: "pc", name: "Cashier", connection: "network", host: "10.0.0.7", port: 9100, printer_mode: "receipt", is_default: 1, is_active: 1 };
const printers = [kitchen, bar, cashier];

describe("resolveKotTargets", () => {
  it("routes a station to its mapped printer with copies", () => {
    const routes: MirroredRoute[] = [{ id: "r1", station_id: "s-kitchen", printer_id: "pk", copies: 2, role: "kot" }];
    const t = resolveKotTargets(printers, routes, "dine_in", "s-kitchen");
    expect(t).toHaveLength(1);
    expect(t[0].printer.printerId).toBe("pk");
    expect(t[0].copies).toBe(2);
    expect(t[0].fallback).toBe(false);
  });

  it("falls back to the default printer (flagged) when the station has no route", () => {
    const t = resolveKotTargets(printers, [], "dine_in", "s-unknown");
    expect(t).toHaveLength(1);
    expect(t[0].printer.printerId).toBe("pc");
    expect(t[0].fallback).toBe(true);
  });

  it("falls back to the first active printer when no default exists", () => {
    const noDefault = printers.map((p) => ({ ...p, is_default: 0 }));
    const t = resolveKotTargets(noDefault, [], "dine_in", "s-unknown");
    expect(t[0].printer.printerId).toBe("pk");
    expect(t[0].fallback).toBe(true);
  });

  it("skips inactive printers", () => {
    const routes: MirroredRoute[] = [{ id: "r1", station_id: "s-kitchen", printer_id: "pk", role: "kot" }];
    const inactive = printers.map((p) => (p.id === "pk" ? { ...p, is_active: 0 } : p));
    const t = resolveKotTargets(inactive, routes, "dine_in", "s-kitchen");
    expect(t[0].fallback).toBe(true);
  });

  it("returns [] when there are no active printers at all", () => {
    const dead = printers.map((p) => ({ ...p, is_active: 0 }));
    expect(resolveKotTargets(dead, [], "dine_in", "s-kitchen")).toEqual([]);
  });

  it("uses a wildcard catch-all route for a stationed item with no specific route", () => {
    const routes: MirroredRoute[] = [{ id: "rw", station_id: "*", printer_id: "pb", role: "kot" }];
    const t = resolveKotTargets(printers, routes, "dine_in", "s-grill");
    expect(t).toHaveLength(1);
    expect(t[0].printer.printerId).toBe("pb");
    expect(t[0].fallback).toBe(false);
  });

  it("prefers a station-specific route over a wildcard catch-all", () => {
    const routes: MirroredRoute[] = [
      { id: "rw", station_id: "*", printer_id: "pb", role: "kot" },
      { id: "rs", station_id: "s-grill", printer_id: "pk", role: "kot" },
    ];
    const t = resolveKotTargets(printers, routes, "dine_in", "s-grill");
    expect(t).toHaveLength(1);
    expect(t[0].printer.printerId).toBe("pk");
  });

  // Reproduces the live routing bug: Dine derives KOT routes as station-specific
  // ONLY (no wildcard-station KOT route). If an order item reaches here with a
  // NULL station (because it was never stamped), it matches no route and drops to
  // the default printer — the cashier. This is why kitchen tickets printed on the
  // cashier USB and the network kitchen printers were never even tried. Stamp the
  // item's station (agent derives it from the menu item) and it routes correctly.
  describe("station-specific routes (as Dine derives them)", () => {
    const routes: MirroredRoute[] = [
      { id: "kot-s-grill", fulfillment_type: null, station_id: "s-grill", printer_id: "pk", role: "kot" },
      { id: "kot-s-bar", fulfillment_type: null, station_id: "s-bar", printer_id: "pb", role: "kot" },
    ];

    it("a stationed item routes to its kitchen printer (not the cashier)", () => {
      const t = resolveKotTargets(printers, routes, "dine_in", "s-grill");
      expect(t).toHaveLength(1);
      expect(t[0].printer.printerId).toBe("pk");
      expect(t[0].fallback).toBe(false);
    });

    it("a NULL-station item wrongly collapses to the default (cashier) — the bug", () => {
      const t = resolveKotTargets(printers, routes, "dine_in", null);
      expect(t).toHaveLength(1);
      expect(t[0].printer.printerId).toBe("pc"); // cashier default
      expect(t[0].fallback).toBe(true); // flagged: nothing matched
    });
  });
});

describe("mergeRoutes (local overrides win over mirrored)", () => {
  const mirrored: MirroredRoute[] = [
    { id: "kot-s-grill", station_id: "s-grill", printer_id: "pk", role: "kot" },
    { id: "kot-s-bar", station_id: "s-bar", printer_id: "pb", role: "kot" },
  ];

  it("keeps mirrored routes when there are no local overrides", () => {
    expect(mergeRoutes([], mirrored)).toEqual(mirrored);
  });

  it("a local station route replaces the mirrored route for that station only", () => {
    const merged = mergeRoutes([{ id: "l1", station_id: "s-grill", printer_id: "pb", role: "kot" }], mirrored);
    const grill = merged.filter((r) => r.station_id === "s-grill");
    expect(grill).toHaveLength(1);
    expect(grill[0].printer_id).toBe("pb"); // overridden
    expect(merged.find((r) => r.station_id === "s-bar")?.printer_id).toBe("pb"); // untouched mirrored bar route kept
  });

  it("a local '*' KOT fallback becomes the catch-all a NULL-station item resolves to (not the cashier)", () => {
    const printers: MirroredPrinter[] = [
      { id: "pk", name: "Kitchen", is_active: 1 },
      { id: "pc", name: "Cashier", is_default: 1, printer_mode: "receipt", is_active: 1 },
    ];
    const merged = mergeRoutes([{ id: "fb", station_id: "*", printer_id: "pk", role: "kot" }], mirrored);
    const t = resolveKotTargets(printers, merged, "dine_in", null);
    expect(t).toHaveLength(1);
    expect(t[0].printer.printerId).toBe("pk"); // kitchen fallback, NOT cashier default
    expect(t[0].fallback).toBe(false); // it's a real route now
  });
});

describe("resolveReceiptTarget", () => {
  it("prefers an explicit receipt route", () => {
    const routes: MirroredRoute[] = [{ id: "r1", printer_id: "pb", role: "receipt", fulfillment_type: "*" }];
    const t = resolveReceiptTarget(printers, routes, "dine_in");
    expect(t?.printer.printerId).toBe("pb");
    expect(t?.fallback).toBe(false);
  });

  it("routes to a printer_mode=receipt printer as the designated destination (not a fallback)", () => {
    const t = resolveReceiptTarget(printers, [], "dine_in");
    expect(t?.printer.printerId).toBe("pc");
    expect(t?.fallback).toBe(false);
  });

  it("only truly falls back (flagged) when no receipt-mode printer exists", () => {
    const noReceiptMode = printers.map((p) => (p.id === "pc" ? { ...p, printer_mode: "kot" } : p));
    const t = resolveReceiptTarget(noReceiptMode, [], "dine_in");
    expect(t?.fallback).toBe(true);
  });
});

describe("toPrinterEntry", () => {
  it("maps snake_case mirror row to camelCase PrinterEntry", () => {
    const e = toPrinterEntry(kitchen);
    expect(e).toMatchObject({ printerId: "pk", host: "10.0.0.5", port: 9100, connection: "network", paperWidth: 80 });
  });
});
