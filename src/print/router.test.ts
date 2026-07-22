import { describe, it, expect } from "vitest";
import { resolveKotTargets, resolveReceiptTarget, toPrinterEntry, type MirroredPrinter, type MirroredRoute } from "./router";

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
