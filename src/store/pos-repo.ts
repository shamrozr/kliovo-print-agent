import bcrypt from "bcryptjs";
import { getStore } from "./db";
import { getState, setState } from "./repo";
import {
  computeTotals,
  recomputePaymentTotals,
  type CoreOrderItem,
  type CorePayment,
  type AppliedCharge,
} from "./order-core";

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function now(): number {
  return Date.now();
}

// ── Sessions (offline login) ─────────────────────────────────
export interface Session {
  userId: string;
  name: string;
  role: string;
  allowedRoutes: string[];
  expiresAt: number;
}

export function authenticate(
  email: string,
  password: string
): { ok: boolean; token?: string; user?: Omit<Session, "expiresAt">; error?: string } {
  const u = getStore()
    .prepare("SELECT * FROM users WHERE lower(email) = lower(?) AND is_active = 1")
    .get(email) as Record<string, any> | undefined;
  if (!u || !u.password_hash) return { ok: false, error: "invalid_credentials" };
  if (!bcrypt.compareSync(password, u.password_hash)) {
    return { ok: false, error: "invalid_credentials" };
  }
  let allowedRoutes: string[] = [];
  try {
    allowedRoutes = JSON.parse(u.permissions || "{}").allowedRoutes ?? [];
  } catch {
    /* ignore */
  }
  const token = id("ses");
  const session: Session = {
    userId: u.id,
    name: u.name,
    role: u.role,
    allowedRoutes,
    expiresAt: now() + 12 * 60 * 60 * 1000, // 12h
  };
  setState(`session:${token}`, JSON.stringify(session));
  return {
    ok: true,
    token,
    user: { userId: u.id, name: u.name, role: u.role, allowedRoutes },
  };
}

export function verifyToken(token: string | undefined): Session | null {
  if (!token) return null;
  const raw = getState(`session:${token}`);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    if (s.expiresAt < now()) return null;
    return s;
  } catch {
    return null;
  }
}

// Manager-PIN check for refunds/discounts/voids (matches the web's any-active-PIN rule).
export function verifyManagerPin(pin: string): boolean {
  if (!/^\d{4,6}$/.test(pin)) return false;
  const rows = getStore()
    .prepare("SELECT pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_active = 1")
    .all() as Array<{ pin_hash: string }>;
  return rows.some((r) => bcrypt.compareSync(pin, r.pin_hash));
}

// ── Offline numbering: OFF-{terminalCode}-{seq} (per-terminal, collision-proof) ──
function nextOfflineRef(terminalCode: string): string {
  const code = (terminalCode || "T1").toUpperCase();
  const key = `seq:${code}`;
  const next = Number(getState(key) ?? "0") + 1;
  setState(key, String(next));
  return `OFF-${code}-${String(next).padStart(5, "0")}`;
}

// ── Reads ────────────────────────────────────────────────────
export function getMenu() {
  const d = getStore();
  const cats = d.prepare("SELECT * FROM menu_categories WHERE is_active = 1 ORDER BY sort_order").all() as any[];
  const items = d.prepare("SELECT * FROM menu_items WHERE is_active = 1 ORDER BY sort_order").all() as any[];
  const byCat = new Map<string, any[]>();
  for (const it of items) {
    const row = {
      id: it.id,
      name: it.name,
      price: it.price,
      imageUrl: it.image_url,
      stationId: it.station_id,
      available: !!it.is_available,
      modifierGroups: safeJson(it.modifier_groups, []),
      variants: safeJson(it.variants, []),
    };
    const arr = byCat.get(it.category_id) ?? [];
    arr.push(row);
    byCat.set(it.category_id, arr);
  }
  return {
    categories: cats.map((c) => ({ id: c.id, name: c.name, items: byCat.get(c.id) ?? [] })),
  };
}

export function getTables() {
  return getStore().prepare("SELECT * FROM tables ORDER BY name").all();
}

export function listOrders(): any[] {
  const d = getStore();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const orders = d
    .prepare("SELECT * FROM orders WHERE created_at >= ? ORDER BY created_at DESC")
    .all(start.getTime()) as any[];
  const itemsStmt = d.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order");
  const paysStmt = d.prepare("SELECT * FROM order_payments WHERE order_id = ?");
  return orders.map((o) => ({ ...o, items: itemsStmt.all(o.id), payments: paysStmt.all(o.id) }));
}

export function getOrder(orderId: string): any | null {
  const d = getStore();
  const o = d.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
  if (!o) return null;
  o.items = d.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order").all(orderId);
  o.payments = d.prepare("SELECT * FROM order_payments WHERE order_id = ?").all(orderId);
  return o;
}

function safeJson<T>(s: unknown, fallback: T): T {
  try {
    return s ? (JSON.parse(s as string) as T) : fallback;
  } catch {
    return fallback;
  }
}

function logChange(
  entityType: string,
  entityId: string,
  op: string,
  payload: Record<string, unknown>,
  terminalCode?: string
): void {
  getStore()
    .prepare(
      "INSERT INTO change_log (id, entity_type, entity_id, op, payload, terminal_id, created_at, synced_at) VALUES (?,?,?,?,?,?,?,NULL)"
    )
    .run(id("cl"), entityType, entityId, op, JSON.stringify(payload), terminalCode ?? null, now());
}

// Recompute an order's totals from its current items + payments (after edits).
function recalc(orderId: string): void {
  const d = getStore();
  const o = d.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
  if (!o) return;
  const fields = safeJson<Record<string, any>>(o.fields, {});
  const items = d.prepare("SELECT * FROM order_items WHERE order_id = ?").all(orderId) as any[];
  const coreItems: CoreOrderItem[] = items.map((it) => ({
    unitPrice: it.unit_price,
    quantity: it.quantity,
    modifiers: safeJson(it.modifiers, []),
  }));
  const totals = computeTotals(
    coreItems,
    fields.taxRate ?? 0,
    fields.serviceChargeRate ?? 0,
    0,
    o.discount_amount ?? 0,
    (fields.appliedCharges ?? []) as AppliedCharge[]
  );
  const pays = d.prepare("SELECT * FROM order_payments WHERE order_id = ?").all(orderId) as any[];
  const corePays: CorePayment[] = pays.map((p) => ({ amount: p.amount, isRefunded: !!p.is_refunded }));
  const pt = recomputePaymentTotals(corePays, totals.totalAmount);
  d.prepare(
    "UPDATE orders SET subtotal=?, tax_amount=?, service_charge_amount=?, total_amount=?, paid_amount=?, balance_due=?, payment_status=?, updated_at=? WHERE id=?"
  ).run(
    totals.subtotal,
    totals.taxAmount,
    totals.serviceChargeAmount,
    totals.totalAmount,
    pt.paidAmount,
    pt.balanceDue,
    pt.paymentStatus,
    now(),
    orderId
  );
}

// ── Order operations (each writes to the change_log outbox) ──────
export interface CreateOrderInput {
  terminalCode?: string;
  source?: string;
  tableId?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  covers?: number | null;
  taxRate?: number;
  serviceChargeRate?: number;
  discountAmount?: number;
  appliedCharges?: AppliedCharge[];
  items: Array<{
    menuItemId?: string;
    variantId?: string | null;
    name: string;
    quantity: number;
    unitPrice: number;
    modifiers?: any[];
    notes?: string | null;
    course?: string | null;
    stationId?: string | null;
  }>;
}

export function createOrder(input: CreateOrderInput) {
  const d = getStore();
  const orderId = id("o");
  const ref = nextOfflineRef(input.terminalCode ?? "T1");
  const ts = now();
  const coreItems: CoreOrderItem[] = input.items.map((it) => ({
    unitPrice: it.unitPrice,
    quantity: it.quantity,
    modifiers: it.modifiers ?? [],
  }));
  const totals = computeTotals(
    coreItems,
    input.taxRate ?? 0,
    input.serviceChargeRate ?? 0,
    0,
    input.discountAmount ?? 0,
    input.appliedCharges ?? []
  );
  const fields = {
    taxRate: input.taxRate ?? 0,
    serviceChargeRate: input.serviceChargeRate ?? 0,
    appliedCharges: input.appliedCharges ?? [],
  };

  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO orders (id, reference, status, source, table_id, guest_name, guest_phone, covers,
        subtotal, tax_amount, service_charge_amount, discount_amount, total_amount, paid_amount,
        balance_due, payment_status, kitchen_status, terminal_id, fields, created_at, updated_at, origin, synced_at)
       VALUES (@id,@ref,'pending',@source,@tableId,@guestName,@guestPhone,@covers,
        @subtotal,@tax,@sc,@discount,@total,0,@total,'unpaid',NULL,@terminal,@fields,@ts,@ts,'offline',NULL)`
    ).run({
      id: orderId,
      ref,
      source: input.source ?? "pos",
      tableId: input.tableId ?? null,
      guestName: input.guestName ?? null,
      guestPhone: input.guestPhone ?? null,
      covers: input.covers ?? null,
      subtotal: totals.subtotal,
      tax: totals.taxAmount,
      sc: totals.serviceChargeAmount,
      discount: totals.discountAmount,
      total: totals.totalAmount,
      terminal: input.terminalCode ?? "T1",
      fields: JSON.stringify(fields),
      ts,
    });
    const insItem = d.prepare(
      `INSERT INTO order_items (id, order_id, menu_item_id, variant_id, name, quantity, unit_price,
        total_price, modifiers, notes, course, station_id, kitchen_status, sort_order, created_at)
       VALUES (@id,@orderId,@menuItemId,@variantId,@name,@qty,@unit,@total,@mods,@notes,@course,@station,'pending',@sort,@ts)`
    );
    input.items.forEach((it, i) => {
      const mods = it.modifiers ?? [];
      const modTotal = mods.reduce((s: number, m: any) => s + (m.priceAdjustment ?? 0), 0);
      insItem.run({
        id: id("oi"),
        orderId,
        menuItemId: it.menuItemId ?? null,
        variantId: it.variantId ?? null,
        name: it.name,
        qty: it.quantity,
        unit: it.unitPrice,
        total: (it.unitPrice + modTotal) * it.quantity,
        mods: JSON.stringify(mods),
        notes: it.notes ?? null,
        course: it.course ?? null,
        station: it.stationId ?? null,
        sort: i,
        ts,
      });
    });
    logChange("order", orderId, "create_order", { ...input, localId: orderId, reference: ref }, input.terminalCode);
  });
  tx();
  return getOrder(orderId);
}

export function addPayment(
  orderId: string,
  payment: { method: string; amount: number; tip?: number; note?: string }
) {
  const d = getStore();
  const payId = id("op");
  const tx = d.transaction(() => {
    d.prepare(
      "INSERT INTO order_payments (id, order_id, method, amount, tip, note, is_refunded, paid_at, created_at) VALUES (?,?,?,?,?,?,0,?,?)"
    ).run(payId, orderId, payment.method, payment.amount, payment.tip ?? 0, payment.note ?? null, now(), now());
    recalc(orderId);
    logChange("payment", orderId, "record_payment", { orderId, paymentId: payId, ...payment });
  });
  tx();
  return getOrder(orderId);
}

export function updateStatus(orderId: string, status: string) {
  const d = getStore();
  d.prepare("UPDATE orders SET status=?, updated_at=? WHERE id=?").run(status, now(), orderId);
  logChange("order", orderId, "update_status", { orderId, status });
  return getOrder(orderId);
}

export function addItem(
  orderId: string,
  item: { menuItemId?: string; name: string; quantity: number; unitPrice: number; modifiers?: any[]; notes?: string; stationId?: string }
) {
  const d = getStore();
  const itemId = id("oi");
  const mods = item.modifiers ?? [];
  const modTotal = mods.reduce((s: number, m: any) => s + (m.priceAdjustment ?? 0), 0);
  const count = (d.prepare("SELECT count(*) c FROM order_items WHERE order_id=?").get(orderId) as any).c;
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO order_items (id, order_id, menu_item_id, name, quantity, unit_price, total_price, modifiers, notes, station_id, kitchen_status, sort_order, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
    ).run(itemId, orderId, item.menuItemId ?? null, item.name, item.quantity, item.unitPrice,
      (item.unitPrice + modTotal) * item.quantity, JSON.stringify(mods), item.notes ?? null, item.stationId ?? null, count, now());
    recalc(orderId);
    logChange("item", orderId, "add_item", { orderId, item: { ...item, id: itemId } });
  });
  tx();
  return getOrder(orderId);
}

export function voidItem(orderId: string, itemId: string) {
  const d = getStore();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM order_items WHERE id=? AND order_id=?").run(itemId, orderId);
    recalc(orderId);
    logChange("item", orderId, "void_item", { orderId, itemId });
  });
  tx();
  return getOrder(orderId);
}

export function refundPayment(orderId: string, paymentId: string, reason?: string, managerPin?: string) {
  if (!managerPin || !verifyManagerPin(managerPin)) {
    return { ok: false, error: "invalid_manager_pin" as const };
  }
  const d = getStore();
  const tx = d.transaction(() => {
    d.prepare("UPDATE order_payments SET is_refunded=1, refunded_at=?, refund_reason=? WHERE id=? AND order_id=?")
      .run(now(), reason ?? null, paymentId, orderId);
    recalc(orderId);
    logChange("payment", orderId, "refund_payment", { orderId, paymentId, reason });
  });
  tx();
  return { ok: true as const, order: getOrder(orderId) };
}
