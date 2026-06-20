import fs from "fs";
import { getStore, prune, DB_PATH } from "./db";

// ── sync_state helpers ───────────────────────────────────────
export function getState(key: string): string | null {
  const row = getStore().prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  getStore()
    .prepare(
      "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

/**
 * Localhost shared secret the web must present to read/write the store.
 * The secret is PROVISIONED BY THE WEB (see setPairingSecret) — the agent never
 * generates or exposes it unauthenticated, so it can't leak to a random page.
 * Returns null until the web has paired.
 */
export function getPairingSecret(): string | null {
  return getState("pairing_secret");
}

/** Provision the pairing secret (bootstrap). Idempotent if the same secret is
 *  re-sent; refuses a different secret once paired (requires an explicit unpair). */
export function setPairingSecret(secret: string): { paired: boolean; error?: string } {
  if (!secret || secret.length < 16) return { paired: false, error: "weak_or_missing_secret" };
  const existing = getState("pairing_secret");
  if (existing && existing !== secret) return { paired: false, error: "already_paired" };
  if (!existing) setState("pairing_secret", secret);
  return { paired: true };
}

/** Clear pairing (re-pair a machine). */
export function unpair(): void {
  setState("pairing_secret", "");
}

// ── Mirror ingest ────────────────────────────────────────────
// Tables the web is allowed to warm, with their primary key. (Whitelisted so a
// caller can never name an arbitrary table.)
const MIRROR_TABLES: Record<string, string> = {
  branch: "id",
  users: "id",
  terminals: "id",
  menu_categories: "id",
  menu_items: "id",
  tables: "id",
  customers: "id",
  ingredients: "id",
  recipes: "id",
  settings: "key",
  orders: "id",
  order_items: "id",
  order_payments: "id",
  combos: "id",
  combo_groups: "id",
  combo_group_items: "id",
};

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/** Upsert a batch of rows for one whitelisted table (column-aware, FK-safe). */
export function mirrorUpsert(table: string, rows: Record<string, unknown>[]): number {
  const pk = MIRROR_TABLES[table];
  // Forward-compat: a newer server snapshot may include tables this agent
  // version doesn't know yet. Skip them instead of throwing so the rest of the
  // snapshot (menu, orders, staff, settings) still applies.
  if (!pk) return 0;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const d = getStore();
  let n = 0;
  const tx = d.transaction((batch: Record<string, unknown>[]) => {
    for (const row of batch) {
      const cols = Object.keys(row).filter((c) => IDENT.test(c));
      if (!cols.includes(pk)) continue;
      const colList = cols.map((c) => `"${c}"`).join(", ");
      const valList = cols.map((c) => `@${c}`).join(", ");
      const setList = cols
        .filter((c) => c !== pk)
        .map((c) => `"${c}" = excluded."${c}"`)
        .join(", ");
      const sql =
        `INSERT INTO "${table}" (${colList}) VALUES (${valList}) ` +
        (setList
          ? `ON CONFLICT("${pk}") DO UPDATE SET ${setList}`
          : `ON CONFLICT("${pk}") DO NOTHING`);
      d.prepare(sql).run(row as Record<string, never>);
      n++;
    }
  });
  tx(rows);
  return n;
}

export function applyMirror(batches: { table: string; rows: Record<string, unknown>[] }[]): number {
  let total = 0;
  for (const b of batches) {
    // One bad batch must not abort the whole snapshot.
    try {
      total += mirrorUpsert(b.table, b.rows);
    } catch {
      /* skip this batch, keep applying the rest */
    }
  }
  setState("last_mirror_at", String(Date.now()));
  return total;
}

// ── Status ───────────────────────────────────────────────────
export function getStatus() {
  const d = getStore();
  const lastMirror = getState("last_mirror_at");
  const entitled = getState("entitled") === "true";
  const orders = (d.prepare("SELECT count(*) c FROM orders").get() as { c: number }).c;
  const unsyncedOrders = (
    d.prepare("SELECT count(*) c FROM orders WHERE origin = 'offline' AND synced_at IS NULL").get() as { c: number }
  ).c;
  const unsyncedChanges = (
    d.prepare("SELECT count(*) c FROM change_log WHERE synced_at IS NULL").get() as { c: number }
  ).c;
  return {
    warm: !!lastMirror,
    lastMirrorAt: lastMirror ? Number(lastMirror) : null,
    entitled,
    counts: { orders, unsyncedOrders, unsyncedChanges },
  };
}

/**
 * Rich snapshot for the agent's "Offline POS" settings tab. Read-only and
 * NEVER returns password/PIN hashes — only who is cached + what's stored, so an
 * operator can confirm offline logins are primed without exposing secrets.
 */
export function getOfflineOverview() {
  const d = getStore();
  const lastMirror = getState("last_mirror_at");
  const entitled = getState("entitled") === "true";
  const paired = !!getState("pairing_secret");

  const users = d
    .prepare(
      `SELECT id, name, email, role, is_active,
              (pin_hash IS NOT NULL AND pin_hash <> '') AS has_pin
       FROM users ORDER BY is_active DESC, role, name`
    )
    .all() as Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    is_active: number;
    has_pin: number;
  }>;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const c = d
    .prepare(
      `SELECT
         count(*) AS total,
         sum(CASE WHEN created_at >= @start THEN 1 ELSE 0 END) AS today,
         sum(CASE WHEN origin = 'offline' THEN 1 ELSE 0 END) AS offline,
         sum(CASE WHEN origin = 'offline' AND synced_at IS NULL THEN 1 ELSE 0 END) AS unsynced
       FROM orders`
    )
    .get({ start: startOfDay.getTime() }) as Record<string, number | null>;
  const unsyncedChanges = (
    d.prepare("SELECT count(*) c FROM change_log WHERE synced_at IS NULL").get() as { c: number }
  ).c;
  const countOf = (table: string): number => {
    try {
      return (d.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
    } catch {
      return 0;
    }
  };
  const menuItems = countOf("menu_items");
  const combos = countOf("combos");

  const recentOrders = d
    .prepare(
      `SELECT reference, status, payment_status, total_amount, origin, synced_at, created_at
       FROM orders ORDER BY created_at DESC LIMIT 15`
    )
    .all();

  const seqRows = d
    .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'seq:%'")
    .all() as Array<{ key: string; value: string }>;
  const terminals = seqRows.map((r) => ({ code: r.key.slice(4), nextSeq: Number(r.value) + 1 }));

  let dbBytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      dbBytes += fs.statSync(DB_PATH + suffix).size;
    } catch {
      /* file may not exist (e.g. no WAL yet) */
    }
  }

  return {
    entitled,
    paired,
    lastMirrorAt: lastMirror ? Number(lastMirror) : null,
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      isActive: !!u.is_active,
      hasPin: !!u.has_pin,
    })),
    counts: {
      orders: c.total ?? 0,
      ordersToday: c.today ?? 0,
      offlineOrders: c.offline ?? 0,
      unsyncedOrders: c.unsynced ?? 0,
      unsyncedChanges,
      menuItems,
      combos,
    },
    storage: { dbPath: DB_PATH, dbBytes, retentionDays: 2 },
    terminals,
    recentOrders,
  };
}

// ── Reconciliation read ──────────────────────────────────────
export function getUnsynced() {
  const d = getStore();
  const changes = d
    .prepare("SELECT * FROM change_log WHERE synced_at IS NULL ORDER BY created_at ASC")
    .all();
  const orders = d
    .prepare("SELECT * FROM orders WHERE origin = 'offline' AND synced_at IS NULL ORDER BY created_at ASC")
    .all() as Array<{ id: string }>;
  const items = d.prepare("SELECT * FROM order_items WHERE order_id = ?");
  const pays = d.prepare("SELECT * FROM order_payments WHERE order_id = ?");
  const ordersFull = orders.map((o) => ({
    ...o,
    items: items.all(o.id),
    payments: pays.all(o.id),
  }));
  return { changes, orders: ordersFull };
}

// ── Mark synced + prune ──────────────────────────────────────
// The web calls this AFTER it has written the records to the cloud.
export function markSynced(changeLogIds: string[]): { marked: number } {
  if (!Array.isArray(changeLogIds) || changeLogIds.length === 0) return { marked: 0 };
  const d = getStore();
  const now = Date.now();
  const tx = d.transaction((ids: string[]) => {
    const ph = ids.map(() => "?").join(", ");
    const rows = d
      .prepare(`SELECT id, entity_type, entity_id FROM change_log WHERE id IN (${ph})`)
      .all(...ids) as Array<{ id: string; entity_type: string; entity_id: string }>;
    d.prepare(`UPDATE change_log SET synced_at = ? WHERE id IN (${ph})`).run(now, ...ids);
    const orderIds = rows.filter((r) => r.entity_type === "order").map((r) => r.entity_id);
    const shiftIds = rows.filter((r) => r.entity_type === "shift").map((r) => r.entity_id);
    if (orderIds.length) {
      d.prepare(
        `UPDATE orders SET synced_at = ? WHERE id IN (${orderIds.map(() => "?").join(", ")})`
      ).run(now, ...orderIds);
    }
    if (shiftIds.length) {
      d.prepare(
        `UPDATE shifts SET synced_at = ? WHERE id IN (${shiftIds.map(() => "?").join(", ")})`
      ).run(now, ...shiftIds);
    }
    return rows.length;
  });
  const marked = tx(changeLogIds);
  prune();
  return { marked };
}

// ── Agent → cloud push of offline orders ─────────────────────────────────────
// Build the reconciliation payloads for every offline order not yet handed to
// the cloud. Amounts are rupees; we derive tax/service-charge RATES from the
// stored amounts so the server can reproduce the exact offline totals.
interface PushOrderPayload {
  offlineRef: string;
  capturedAt: string;
  source?: string;
  status?: string;
  tableId?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  covers?: number | null;
  taxRate?: number;
  serviceChargeRate?: number;
  discountAmount?: number;
  items: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  totals: { totalAmount: number; paidAmount: number };
}

export function getOfflineOrdersForPush(): { orderId: string; payload: PushOrderPayload }[] {
  const d = getStore();
  const orders = d
    .prepare(
      "SELECT * FROM orders WHERE origin = 'offline' AND synced_at IS NULL ORDER BY created_at ASC"
    )
    .all() as Array<Record<string, any>>;
  const itemsStmt = d.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order ASC");
  const paysStmt = d.prepare("SELECT * FROM order_payments WHERE order_id = ?");

  return orders.map((o) => {
    const items = itemsStmt.all(o.id) as Array<Record<string, any>>;
    const pays = paysStmt.all(o.id) as Array<Record<string, any>>;
    const subtotal = Number(o.subtotal) || 0;
    const taxRate = subtotal > 0 ? (Number(o.tax_amount) / subtotal) * 100 : 0;
    const scRate = subtotal > 0 ? (Number(o.service_charge_amount) / subtotal) * 100 : 0;

    const payload: PushOrderPayload = {
      offlineRef: o.reference,
      capturedAt: new Date(Number(o.created_at) || Date.now()).toISOString(),
      source: o.source ?? "pos",
      status: o.status ?? "completed",
      tableId: o.table_id ?? null,
      guestName: o.guest_name ?? null,
      guestPhone: o.guest_phone ?? null,
      covers: o.covers ?? null,
      taxRate,
      serviceChargeRate: scRate,
      discountAmount: Number(o.discount_amount) || 0,
      items: items.map((it) => ({
        menuItemId: it.menu_item_id ?? null,
        variantId: it.variant_id ?? null,
        name: it.name,
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unit_price) || 0,
        modifiers: safeParse(it.modifiers),
        notes: it.notes ?? null,
        course: it.course ?? null,
        stationId: it.station_id ?? null,
      })),
      payments: pays
        .filter((p) => !p.is_refunded)
        .map((p) => ({
          method: p.method,
          amount: Number(p.amount) || 0,
          tip: Number(p.tip) || 0,
          note: p.note ?? null,
        })),
      totals: { totalAmount: Number(o.total_amount) || 0, paidAmount: Number(o.paid_amount) || 0 },
    };
    return { orderId: o.id, payload };
  });
}

// Mark offline orders as handed to the cloud (so they're not re-pushed). The
// server's staging queue is now the source of truth for reconciliation.
export function markOrdersPushed(orderIds: string[]): { marked: number } {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return { marked: 0 };
  const d = getStore();
  const ph = orderIds.map(() => "?").join(", ");
  const info = d
    .prepare(`UPDATE orders SET synced_at = ? WHERE id IN (${ph})`)
    .run(Date.now(), ...orderIds);
  return { marked: info.changes };
}

function safeParse(s: unknown): unknown {
  if (typeof s !== "string") return Array.isArray(s) ? s : [];
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}
