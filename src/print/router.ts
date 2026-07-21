/**
 * Pure print routing. Given the mirrored printers + routing rows, resolve which
 * physical printer(s) a KOT (per station) or a receipt should go to. No I/O, no
 * DB — fully unit-testable. `import type` only, so vitest never loads electron.
 *
 * SAFETY (locked decision): a real ticket must NEVER resolve to nothing when any
 * printer is reachable. Unmapped → default printer → first active printer, with
 * `fallback: true` so the caller can flag it. Only [] when zero active printers.
 */
import type { PrinterEntry } from "../config";

export interface MirroredPrinter {
  id: string;
  name?: string;
  connection?: "network" | "system";
  host?: string;
  port?: number;
  system_printer_name?: string;
  paper_width?: number;
  printer_mode?: string;
  label_language?: string;
  label_width_mm?: number;
  label_height_mm?: number;
  gap_type?: string;
  is_default?: number;
  is_active?: number;
}

export interface MirroredRoute {
  id: string;
  fulfillment_type?: string | null;
  station_id?: string | null;
  printer_id: string;
  copies?: number;
  role?: string;
}

export interface ResolvedTarget {
  printer: PrinterEntry;
  copies: number;
  fallback: boolean;
}

export function toPrinterEntry(p: MirroredPrinter): PrinterEntry {
  return {
    printerId: p.id,
    agentKey: "",
    connection: p.connection === "system" ? "system" : "network",
    host: p.host ?? "",
    port: p.port ?? 9100,
    systemPrinterName: p.system_printer_name,
    name: p.name ?? p.id,
    paperWidth: p.paper_width === 58 ? 58 : 80,
    printerMode: p.printer_mode === "label" ? "label" : "receipt",
    labelWidthMm: p.label_width_mm,
    labelHeightMm: p.label_height_mm,
    gapType: p.gap_type as PrinterEntry["gapType"],
    labelLanguage: p.label_language as PrinterEntry["labelLanguage"],
  };
}

const isActive = (p: MirroredPrinter) => p.is_active !== 0;
const wildcard = (v: string | null | undefined) => v == null || v === "" || v === "*";

function ftMatch(route: MirroredRoute, ft: string): boolean {
  return wildcard(route.fulfillment_type) || route.fulfillment_type === ft;
}

function fallbackPrinter(printers: MirroredPrinter[]): MirroredPrinter | null {
  const active = printers.filter(isActive);
  if (active.length === 0) return null;
  return active.find((p) => p.is_default === 1) ?? active[0];
}

export function resolveKotTargets(
  printers: MirroredPrinter[],
  routes: MirroredRoute[],
  fulfillmentType: string,
  stationId: string | null
): ResolvedTarget[] {
  const byId = new Map(printers.map((p) => [p.id, p]));
  const matched = routes.filter(
    (r) =>
      (r.role ?? "kot") !== "receipt" &&
      ftMatch(r, fulfillmentType) &&
      (wildcard(r.station_id) ? stationId == null : r.station_id === stationId)
  );

  const targets: ResolvedTarget[] = [];
  for (const r of matched) {
    const p = byId.get(r.printer_id);
    if (p && isActive(p)) {
      targets.push({ printer: toPrinterEntry(p), copies: Math.max(1, r.copies ?? 1), fallback: false });
    }
  }
  if (targets.length > 0) return targets;

  const fb = fallbackPrinter(printers);
  return fb ? [{ printer: toPrinterEntry(fb), copies: 1, fallback: true }] : [];
}

export function resolveReceiptTarget(
  printers: MirroredPrinter[],
  routes: MirroredRoute[],
  fulfillmentType: string
): ResolvedTarget | null {
  const byId = new Map(printers.map((p) => [p.id, p]));
  const route = routes.find((r) => r.role === "receipt" && ftMatch(r, fulfillmentType));
  if (route) {
    const p = byId.get(route.printer_id);
    if (p && isActive(p)) return { printer: toPrinterEntry(p), copies: Math.max(1, route.copies ?? 1), fallback: false };
  }
  const receiptPrinter = printers.filter(isActive).find((p) => p.printer_mode === "receipt");
  if (receiptPrinter) return { printer: toPrinterEntry(receiptPrinter), copies: 1, fallback: true };
  const fb = fallbackPrinter(printers);
  return fb ? { printer: toPrinterEntry(fb), copies: 1, fallback: true } : null;
}
