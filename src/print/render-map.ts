/**
 * Pure builders: local order/item rows → the render templates' input objects,
 * plus deterministic job ids used by the printed_jobs ledger. No I/O, no DB.
 * Receipt money is PAISA (integer); order-core stores rupees (REAL) → ×100.
 */
import type { KotInput } from "../render/templates/kot";
import type { ReceiptInput } from "../render/templates/receipt";
import type { LayoutConfig } from "../render/designer-types";
import {
  isKotSuppressed,
  ownAddonsOnStation,
  printsItemAtStation,
  ridingModifiers,
} from "../store/kot-plan";

export type RasterLogo = { bytes: Buffer; widthBytes: number; heightDots: number };

export interface OrderRow {
  id: string;
  reference?: string;
  status?: string;
  source?: string;
  table_id?: string | null;
  guest_name?: string | null;
  guest_phone?: string | null;
  covers?: number | null;
  fields?: string;
  subtotal?: number;
  tax_amount?: number;
  service_charge_amount?: number;
  discount_amount?: number;
  total_amount?: number;
  paid_amount?: number;
  created_at?: number;
}

export interface ItemRow {
  id: string;
  name?: string;
  quantity?: number;
  unit_price?: number;
  total_price?: number;
  modifiers?: string;
  notes?: string | null;
  course?: string | null;
  station_id?: string | null;
  /** Frozen Ticket Router plan (JSON) — see store/kot-routing.ts. */
  station_ids?: string | null;
  kot_routing?: string | null;
}

export interface StationRow {
  id: string;
  name?: string;
  label?: string;
}

export interface BrandingRow {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  tax_lines?: string;
  logo_bytes?: Buffer | null;
}

export interface PaymentIn {
  method: string;
  amount: number;
  tip?: number;
  reference?: string;
}

const toPaisa = (rupees: number | null | undefined) => Math.round((Number(rupees) || 0) * 100);
const orderType = (o: OrderRow): string => {
  try {
    const f = JSON.parse(o.fields || "{}");
    return String(f.orderType || o.source || "dine_in");
  } catch {
    return o.source || "dine_in";
  }
};
const parseMods = (s?: string): { name: string }[] => {
  try {
    const a = JSON.parse(s || "[]");
    return Array.isArray(a) ? a.map((m: any) => ({ name: String(m?.name ?? m) })) : [];
  } catch {
    return [];
  }
};

export function kotJobId(orderId: string, stationId: string | null, seq: number): string {
  return `OFF:${orderId}:kot:${stationId ?? "none"}:${seq}`;
}

export function receiptJobId(orderId: string, paymentId: string): string {
  return `OFF:${orderId}:receipt:${paymentId}`;
}

/**
 * Build ONE station's ticket out of the round's lines.
 *
 * `stationId` — not just the station row — is what the per-line filtering keys
 * off, because a station present in routing may have no mirrored `kitchen_stations`
 * row yet, and `null` is a real value: the catch-all slip for unrouted lines (the
 * offline equivalent of the cloud's `kitchen_ticket:none`).
 *
 * Filtering happens HERE rather than at the caller so the two things that must
 * agree — which stations get a ticket, and what goes on one — read the same
 * frozen plan. Diverge and a station gets a slip with nothing on it, which a line
 * cook reads as a lost order.
 */
export function buildKotInput(
  order: OrderRow,
  items: ItemRow[],
  station: StationRow | null,
  tableName: string | undefined,
  fireTime: string,
  fireDate?: string,
  stationId: string | null = station?.id ?? null
): KotInput {
  const live = items.filter((it) => !isKotSuppressed(it));
  const itemLines = live
    .filter((it) => printsItemAtStation(it, stationId))
    .map((it) => ({
      name: it.name || "Item",
      quantity: Number(it.quantity) || 1,
      modifiers: ridingModifiers(it, parseMods(it.modifiers)),
      notes: it.notes ?? undefined,
      course: it.course ?? undefined,
    }));
  // Own-line add-ons routed to THIS station, including ones whose base item
  // prints somewhere else entirely.
  const addonLines = live.flatMap((it) =>
    ownAddonsOnStation(it, stationId).map((name) => ({
      name,
      quantity: Number(it.quantity) || 1,
      modifiers: [] as { name: string }[],
      notes: `for ${it.name || "item"}`,
      course: it.course ?? undefined,
    }))
  );
  return {
    referenceNumber: order.reference || order.id,
    stationName: station?.name || station?.label || (stationId === null ? "UNROUTED" : "KITCHEN"),
    tableName,
    guestName: order.guest_name ?? undefined,
    orderType: orderType(order),
    fireTime,
    fireDate,
    items: [...itemLines, ...addonLines],
  };
}

export function buildReceiptInput(
  order: OrderRow,
  items: ItemRow[],
  payments: PaymentIn[],
  branding: BrandingRow | null,
  time: string,
  date: string,
  tableName?: string,
  opts?: { layoutConfig?: LayoutConfig; rasterLogo?: RasterLogo }
): ReceiptInput {
  const subtotalPaisa = toPaisa(order.subtotal);
  const taxPaisa = toPaisa(order.tax_amount);
  const discountPaisa = toPaisa(order.discount_amount);
  const totalPaisa = toPaisa(order.total_amount);
  const paidPaisa = toPaisa(order.paid_amount);
  let taxLines: string[] = [];
  try {
    taxLines = JSON.parse(branding?.tax_lines || "[]");
  } catch {
    taxLines = [];
  }
  // Customer + delivery live in the order's `fields` JSON (same shape Dine reads
  // on reconcile: deliveryAddress + a manual deliveryFee). Parse defensively.
  let fields: Record<string, unknown> = {};
  try {
    fields = order.fields ? (JSON.parse(order.fields) as Record<string, unknown>) : {};
  } catch {
    fields = {};
  }
  const deliveryAddress = typeof fields.deliveryAddress === "string" ? fields.deliveryAddress : undefined;
  const deliveryFeePaisa = toPaisa(Number(fields.deliveryFee) || 0) || undefined;
  // Named charges (service fee, GST…) — one receipt line each, matching the web.
  const appliedCharges = Array.isArray(fields.appliedCharges) ? (fields.appliedCharges as Array<{ name?: string; amount?: number }>) : [];
  const chargeLines = appliedCharges
    .filter((c) => Number(c.amount) > 0)
    .map((c) => ({ label: String(c.name || "Charge"), amountPaisa: toPaisa(Number(c.amount) || 0) }));
  const customerName = order.guest_name ?? undefined;
  const customerPhone = order.guest_phone ?? undefined;
  return {
    header: {
      tenantName: branding?.name || "Receipt",
      addressLines: branding?.address ? [branding.address] : undefined,
      phone: branding?.phone ?? undefined,
      taxLines,
      rasterLogo: opts?.rasterLogo,
    },
    referenceNumber: order.reference || order.id,
    date,
    time,
    orderType: orderType(order),
    tableName,
    covers: order.covers ?? undefined,
    customer: customerName || customerPhone ? { name: customerName, phone: customerPhone } : undefined,
    deliveryAddress,
    items: items.map((it) => ({
      name: it.name || "Item",
      quantity: Number(it.quantity) || 1,
      unitPricePaisa: toPaisa(it.unit_price),
      totalPaisa: toPaisa(it.total_price),
      modifiers: parseMods(it.modifiers).map((m) => ({ name: m.name, pricePaisa: 0 })),
      notes: it.notes ?? undefined,
    })),
    subtotalPaisa,
    discounts: discountPaisa > 0 ? [{ label: "Discount", amountPaisa: discountPaisa }] : undefined,
    taxes: taxPaisa > 0 ? [{ label: "Tax", rate: 0, amountPaisa: taxPaisa }] : undefined,
    // Prefer itemized charge lines; fall back to the aggregate service line only
    // when there are no named charges (legacy flat serviceChargeRate path).
    charges: chargeLines.length > 0 ? chargeLines : undefined,
    serviceChargePaisa: chargeLines.length > 0 ? undefined : toPaisa(order.service_charge_amount) || undefined,
    deliveryFeePaisa,
    totalPaisa,
    paidPaisa,
    balanceDuePaisa: Math.max(0, totalPaisa - paidPaisa),
    payments: payments.map((p) => ({
      method: p.method,
      amountPaisa: toPaisa(p.amount),
      tipPaisa: toPaisa(p.tip),
      reference: p.reference,
    })),
    layoutConfig: opts?.layoutConfig,
  };
}
