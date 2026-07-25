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

/**
 * Heal each mirrored printer's CONNECTION (how to reach it — host/port/system
 * name) from the agent's LOCAL config, matched by id then by name. The local
 * config is authoritative for connectivity: it's what the operator set up and
 * proved with test-print, whereas the web-mirrored host can be blank or stale
 * (Dine only fills host when the connection string carries a ":port"). Config
 * printers with no mirrored twin are appended so they're routable too. Pure.
 *
 * This is why offline printing no longer depends on the web shipping a correct
 * host — the KOT resolves WHICH printer via routing, but HOW to reach it comes
 * from the agent's own config.
 */
export function resolvePrinters(configPrinters: MirroredPrinter[], mirrored: MirroredPrinter[]): MirroredPrinter[] {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const byId = new Map(configPrinters.map((c) => [c.id, c]));
  const byName = new Map(configPrinters.filter((c) => norm(c.name)).map((c) => [norm(c.name), c]));
  const used = new Set<string>();
  const healed = mirrored.map((m) => {
    const match = byId.get(m.id) ?? byName.get(norm(m.name));
    if (!match) return m;
    used.add(match.id);
    // Config wins for HOW to reach it; keep the mirrored identity + flags.
    return {
      ...m,
      connection: match.connection,
      host: match.host,
      port: match.port,
      system_printer_name: match.system_printer_name,
    };
  });
  const extra = configPrinters.filter((c) => !used.has(c.id) && !mirrored.some((m) => m.id === c.id));
  return [...healed, ...extra];
}

/** An operator-set local routing override (from the agent's Settings UI). */
export interface LocalRoute {
  id: string;
  station_id?: string | null; // NULL/'*' = kitchen fallback (catch-all KOT)
  printer_id: string;
  role?: string; // 'kot' | 'receipt'
  copies?: number;
}

/**
 * Fold operator-set local overrides over the mirrored (web-derived) routes. A
 * local row REPLACES the mirrored route(s) for the same (role, station) — so the
 * restaurant can correct a wrong web-derived route without the mirror clobbering
 * it — while mirrored routes for untouched stations are kept. Local rows sort
 * first. Pure so it's unit-testable. This is what makes offline routing fully
 * controllable from the agent regardless of what the snapshot shipped.
 */
export function mergeRoutes(local: LocalRoute[], mirrored: MirroredRoute[]): MirroredRoute[] {
  const key = (role: string | null | undefined, station: string | null | undefined) =>
    `${role ?? "kot"}::${wildcard(station) ? "*" : station}`;
  const overridden = new Set(local.map((l) => key(l.role, l.station_id)));
  const localAsRoutes: MirroredRoute[] = local.map((l) => ({
    id: `local:${l.id}`,
    fulfillment_type: null,
    station_id: l.station_id ?? null,
    printer_id: l.printer_id,
    copies: l.copies ?? 1,
    role: l.role ?? "kot",
  }));
  const keptMirrored = mirrored.filter((m) => !overridden.has(key(m.role, m.station_id)));
  return [...localAsRoutes, ...keptMirrored];
}

export function resolveKotTargets(
  printers: MirroredPrinter[],
  routes: MirroredRoute[],
  fulfillmentType: string,
  stationId: string | null
): ResolvedTarget[] {
  const byId = new Map(printers.map((p) => [p.id, p]));
  const eligible = routes.filter((r) => (r.role ?? "kot") !== "receipt" && ftMatch(r, fulfillmentType));
  // Most-specific-wins: a route naming THIS station beats a wildcard/catch-all
  // route. Only if no station-specific route exists do the wildcard routes act
  // as a true catch-all — so a stationed item never silently drops to the
  // default printer just because it lacks its own per-station rule.
  const specific = eligible.filter((r) => !wildcard(r.station_id) && r.station_id === stationId);
  const matched = specific.length > 0 ? specific : eligible.filter((r) => wildcard(r.station_id));

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
  // No explicit receipt route (routes default to role 'kot'), so send to a
  // printer explicitly in receipt mode — the designated receipt station,
  // preferring the default among them. This is a correct destination, not a
  // fallback, so it must NOT be flagged as one.
  const receiptPrinters = printers.filter(isActive).filter((p) => p.printer_mode === "receipt");
  const receiptPrinter = receiptPrinters.find((p) => p.is_default === 1) ?? receiptPrinters[0];
  if (receiptPrinter) return { printer: toPrinterEntry(receiptPrinter), copies: 1, fallback: false };
  // Genuine misconfig: no receipt-mode printer at all → default/any active.
  const fb = fallbackPrinter(printers);
  return fb ? { printer: toPrinterEntry(fb), copies: 1, fallback: true } : null;
}
