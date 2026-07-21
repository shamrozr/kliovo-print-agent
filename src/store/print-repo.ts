/**
 * DB reads/writes the fire orchestrator needs. Thin wrappers over the encrypted
 * store; kept separate from repo.ts so the print path is self-contained.
 */
import { getStore } from "./db";
import type { OrderRow, ItemRow, StationRow, BrandingRow } from "../print/render-map";
import type { MirroredPrinter, MirroredRoute } from "../print/router";

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
