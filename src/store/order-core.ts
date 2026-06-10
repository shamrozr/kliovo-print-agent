// Vendored copy of Kliovo-Dine/src/lib/order-core (pure; keep in sync manually).
// The web and the agent compute order math identically so offline totals match
// the cloud. Self-contained — no external deps.

export interface CoreModifier {
  id?: string;
  modifierId?: string;
  name: string;
  priceAdjustment: number;
}
export interface CoreOrderItem {
  unitPrice: number;
  quantity: number;
  modifiers?: CoreModifier[];
}
export interface CorePayment {
  amount: number;
  tip?: number | null;
  isRefunded?: boolean | null;
}
export interface AppliedCharge {
  amount: number;
  [k: string]: unknown;
}
export interface OrderTotals {
  subtotal: number;
  taxAmount: number;
  serviceChargeAmount: number;
  discountAmount: number;
  totalAmount: number;
}
export type PaymentStatus = "paid" | "partial" | "unpaid";
export interface PaymentTotals {
  paidAmount: number;
  balanceDue: number;
  paymentStatus: PaymentStatus;
}

export function normalizeOrderModifiers<T extends CoreModifier>(modifiers: T[] = []): T[] {
  return modifiers.map((m) => ({ ...m, modifierId: m.modifierId ?? m.id }));
}

export function computeLineTotal(item: CoreOrderItem): number {
  const modifierTotal = normalizeOrderModifiers(item.modifiers).reduce(
    (s, m) => s + m.priceAdjustment,
    0
  );
  return (item.unitPrice + modifierTotal) * item.quantity;
}

export function computeTotals(
  items: CoreOrderItem[],
  taxRate = 0,
  serviceChargeRate = 0,
  extraFeeAmount = 0,
  discountAmount = 0,
  appliedCharges: AppliedCharge[] = []
): OrderTotals {
  const subtotal = items.reduce((sum, item) => sum + computeLineTotal(item), 0);
  const taxAmount = (subtotal * taxRate) / 100;
  const appliedChargesTotal = appliedCharges.reduce(
    (s, c) => s + (Number.isFinite(c.amount) ? Math.max(0, c.amount) : 0),
    0
  );
  const serviceChargeAmount =
    (subtotal * serviceChargeRate) / 100 + extraFeeAmount + appliedChargesTotal;
  const totalAmount = subtotal + taxAmount + serviceChargeAmount - discountAmount;
  return {
    subtotal: Math.max(0, subtotal),
    taxAmount: Math.max(0, taxAmount),
    serviceChargeAmount: Math.max(0, serviceChargeAmount),
    discountAmount: Math.max(0, discountAmount),
    totalAmount: Math.max(0, totalAmount),
  };
}

export function recomputePaymentTotals(
  payments: CorePayment[],
  totalAmount: number
): PaymentTotals {
  const paidAmount = payments
    .filter((p) => !p.isRefunded)
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const balanceDue = Math.max(0, totalAmount - paidAmount);
  const paymentStatus: PaymentStatus =
    balanceDue <= 0 && paidAmount > 0 ? "paid" : paidAmount > 0 ? "partial" : "unpaid";
  return { paidAmount, balanceDue, paymentStatus };
}
