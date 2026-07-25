/**
 * DB reads/writes the fire orchestrator needs. Thin wrappers over the encrypted
 * store; kept separate from repo.ts so the print path is self-contained.
 */
import { getStore } from "./db";
import type { OrderRow, ItemRow, StationRow, BrandingRow } from "../print/render-map";
import { mergeRoutes, type LocalRoute, type MirroredPrinter, type MirroredRoute } from "../print/router";
import type { LayoutConfig } from "../render/designer-types";

/** Mirrored designer template for a document kind (e.g. "receipt"). Returns the
 *  parsed layout_config, or null when no template/invalid JSON — callers then
 *  render with built-in defaults. */
export function getPrintTemplate(kind: string): LayoutConfig | null {
  const row = getStore()
    .prepare("SELECT layout_config FROM print_templates WHERE kind = ?")
    .get(kind) as { layout_config?: string } | undefined;
  if (!row?.layout_config) return null;
  try {
    return JSON.parse(row.layout_config) as LayoutConfig;
  } catch {
    return null;
  }
}

export function getOrderRow(orderId: string): OrderRow | null {
  return (getStore().prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow) ?? null;
}

/** All items for an order, oldest first. */
export function getOrderItems(orderId: string): ItemRow[] {
  return getStore()
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(orderId) as ItemRow[];
}

/** Items not yet fired to the kitchen (fired_at IS NULL) — for incremental KOTs. */
export function getUnfiredItems(orderId: string): ItemRow[] {
  return getStore()
    .prepare("SELECT * FROM order_items WHERE order_id = ? AND fired_at IS NULL ORDER BY sort_order ASC, created_at ASC")
    .all(orderId) as ItemRow[];
}

export function markItemsFired(itemIds: string[], now: number = Date.now()): void {
  if (itemIds.length === 0) return;
  const ph = itemIds.map(() => "?").join(", ");
  getStore().prepare(`UPDATE order_items SET fired_at = ? WHERE id IN (${ph})`).run(now, ...itemIds);
}

export function getPayment(orderId: string, paymentId: string): { id: string; method: string; amount: number; tip: number } | null {
  return (
    (getStore().prepare("SELECT * FROM order_payments WHERE id = ? AND order_id = ?").get(paymentId, orderId) as any) ?? null
  );
}

export function getMirroredPrinters(): MirroredPrinter[] {
  return getStore().prepare("SELECT * FROM printers").all() as MirroredPrinter[];
}

export function getMirroredRoutes(): MirroredRoute[] {
  return getStore().prepare("SELECT * FROM print_routing").all() as MirroredRoute[];
}

/** Operator-set local overrides (agent Settings → Printer Routing). */
export function getLocalRoutes(): LocalRoute[] {
  return getStore().prepare("SELECT * FROM local_print_routing").all() as LocalRoute[];
}

/** The routes the fire path actually uses: local overrides folded over mirrored.
 *  Local wins per (role, station); a local '*' KOT row is the kitchen fallback. */
export function getEffectiveRoutes(): MirroredRoute[] {
  return mergeRoutes(getLocalRoutes(), getMirroredRoutes());
}

/** Upsert one local override for (role, station). stationId null/'*' = fallback. */
export function setLocalRoute(input: { stationId: string | null; printerId: string; role?: string; copies?: number }): void {
  const role = input.role === "receipt" ? "receipt" : "kot";
  const station = input.stationId && input.stationId !== "*" ? input.stationId : null;
  const d = getStore();
  // One row per (role, station) — delete any prior, then insert. Simpler than an
  // upsert on a composite key and keeps the table free of duplicates.
  d.prepare("DELETE FROM local_print_routing WHERE role = ? AND (station_id IS ? OR station_id = ?)").run(role, station, station ?? "");
  d.prepare(
    "INSERT INTO local_print_routing (id, station_id, printer_id, role, copies, updated_at) VALUES (?,?,?,?,?,?)"
  ).run(`lr_${role}_${station ?? "fallback"}`, station, input.printerId, role, Math.max(1, input.copies ?? 1), Date.now());
}

/** Remove one local override for (role, station). */
export function clearLocalRoute(stationId: string | null, role = "kot"): void {
  const station = stationId && stationId !== "*" ? stationId : null;
  getStore()
    .prepare("DELETE FROM local_print_routing WHERE role = ? AND (station_id IS ? OR station_id = ?)")
    .run(role === "receipt" ? "receipt" : "kot", station, station ?? "");
}

/** One-glance routing diagnostics (served read-only at /local/print-diag). Adds
 *  station coverage on recent offline items so we can see whether tickets even
 *  carry a station — the difference between "routes wrong" and "no station". */
export function getPrintDiagnostics() {
  const d = getStore();
  const coverage = d
    .prepare(
      `SELECT COUNT(*) AS items,
              SUM(CASE WHEN station_id IS NULL THEN 1 ELSE 0 END) AS nullStation
       FROM order_items
       WHERE order_id IN (SELECT id FROM orders WHERE origin = 'offline' ORDER BY created_at DESC LIMIT 50)`
    )
    .get();
  return { ...getRoutingSnapshot(), recentOfflineItems: coverage };
}

/** Everything the Printer Routing modal needs: stations, printers, the mirrored
 *  (web) routes, and the operator's local overrides — so the UI can show the
 *  effective printer per station and let each be overridden. */
export function getRoutingSnapshot() {
  const d = getStore();
  const printers = d
    .prepare("SELECT id, name, connection, host, port, printer_mode, is_default, is_active FROM printers ORDER BY is_default DESC, name")
    .all();
  const stations = d.prepare("SELECT id, name, label FROM kitchen_stations ORDER BY sort_order, name").all();
  return {
    printers,
    stations,
    mirroredRoutes: getMirroredRoutes(),
    localRoutes: getLocalRoutes(),
  };
}

export function getStation(stationId: string | null): StationRow | null {
  if (!stationId) return null;
  return (getStore().prepare("SELECT * FROM kitchen_stations WHERE id = ?").get(stationId) as StationRow) ?? null;
}

export function getBranding(): BrandingRow | null {
  return (getStore().prepare("SELECT * FROM branding LIMIT 1").get() as BrandingRow) ?? null;
}

export function getTableName(tableId: string | null | undefined): string | undefined {
  if (!tableId) return undefined;
  const row = getStore().prepare("SELECT name FROM tables WHERE id = ?").get(tableId) as { name?: string } | undefined;
  return row?.name;
}
