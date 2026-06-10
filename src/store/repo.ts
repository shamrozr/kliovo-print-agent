import { getStore, prune } from "./db";

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
};

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/** Upsert a batch of rows for one whitelisted table (column-aware, FK-safe). */
export function mirrorUpsert(table: string, rows: Record<string, unknown>[]): number {
  const pk = MIRROR_TABLES[table];
  if (!pk) throw new Error(`mirror: table not allowed: ${table}`);
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
  for (const b of batches) total += mirrorUpsert(b.table, b.rows);
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
