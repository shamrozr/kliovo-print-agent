/**
 * Pure builders: local order/item rows → the render templates' input objects,
 * plus deterministic job ids used by the printed_jobs ledger. No I/O, no DB.
 * Receipt money is PAISA (integer); order-core stores rupees (REAL) → ×100.
 */
import type { KotInput } from "../render/templates/kot";
import type { ReceiptInput } from "../render/templates/receipt";

export interface OrderRow {
  id: string;
  reference?: string;
  status?: string;
  source?: string;
  table_id?: string | null;
  guest_name?: string | null;
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

export function buildKotInput(
  order: OrderRow,
  items: ItemRow[],
  station: StationRow | null,
  tableName: string | undefined,
  fireTime: string,
  fireDate?: string
): KotInput {
  return {
    referenceNumber: order.reference || order.id,
    stationName: station?.name || station?.label || "KITCHEN",
    tableName,
    guestName: order.guest_name ?? undefined,
    orderType: orderType(order),
    fireTime,
    fireDate,
    items: items.map((it) => ({
      name: it.name || "Item",
      quantity: Number(it.quantity) || 1,
      modifiers: parseMods(it.modifiers),
      notes: it.notes ?? undefined,
      course: it.course ?? undefined,
    })),
  };
}

export function buildReceiptInput(
  order: OrderRow,
  items: ItemRow[],
  payments: PaymentIn[],
  branding: BrandingRow | null,
  time: string,
  date: string,
  tableName?: string
): ReceiptInput {
  const subtotalPaisa = toPaisa(order.subtotal);
  const taxPaisa = toPaisa(order.tax_amount);
  const totalPaisa = toPaisa(order.total_amount);
  const paidPaisa = toPaisa(order.paid_amount);
  let taxLines: string[] = [];
  try {
    taxLines = JSON.parse(branding?.tax_lines || "[]");
  } catch {
    taxLines = [];
  }
  return {
    header: {
      tenantName: branding?.name || "Receipt",
      addressLines: branding?.address ? [branding.address] : undefined,
      phone: branding?.phone ?? undefined,
      taxLines,
      rasterLogo: undefined,
    },
    referenceNumber: order.reference || order.id,
    date,
    time,
    orderType: orderType(order),
    tableName,
    covers: order.covers ?? undefined,
    items: items.map((it) => ({
      name: it.name || "Item",
      quantity: Number(it.quantity) || 1,
      unitPricePaisa: toPaisa(it.unit_price),
      totalPaisa: toPaisa(it.total_price),
      modifiers: parseMods(it.modifiers).map((m) => ({ name: m.name, pricePaisa: 0 })),
      notes: it.notes ?? undefined,
    })),
    subtotalPaisa,
    taxes: taxPaisa > 0 ? [{ label: "Tax", rate: 0, amountPaisa: taxPaisa }] : undefined,
    serviceChargePaisa: toPaisa(order.service_charge_amount) || undefined,
    totalPaisa,
    paidPaisa,
    balanceDuePaisa: Math.max(0, totalPaisa - paidPaisa),
    payments: payments.map((p) => ({
      method: p.method,
      amountPaisa: toPaisa(p.amount),
      tipPaisa: toPaisa(p.tip),
      reference: p.reference,
    })),
  };
}
