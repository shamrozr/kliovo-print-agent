import Database from "better-sqlite3-multiple-ciphers";
import { app } from "electron";
import fs from "fs";
import path from "path";
import { logger } from "../logger";
import { getOrCreateDbKey } from "./keychain";
import { SCHEMA_SQL } from "./schema";

let db: Database.Database | null = null;

const DB_DIR = path.join(app.getPath("userData"), "offline");
const DB_PATH = path.join(DB_DIR, "dine-offline.db");
const ONLINE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

function applySchema(conn: Database.Database): void {
  // Run each DDL statement individually (the schema has no semicolons inside
  // statements, so splitting on ";" is safe here).
  for (const raw of SCHEMA_SQL.split(";")) {
    const stmt = raw.trim();
    if (stmt) conn.prepare(stmt).run();
  }
}

/** Open (or create) the encrypted local DB. Safe to call once on app ready. */
export function initStore(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });

  const key = getOrCreateDbKey();
  const conn = new Database(DB_PATH);
  conn.pragma("cipher='sqlcipher'");
  conn.pragma(`key='${key.replace(/'/g, "''")}'`);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");

  // First real statement — throws "file is not a database" if the key is wrong,
  // surfacing a corrupt/replaced key file immediately instead of silently.
  applySchema(conn);

  db = conn;
  logger.info("[store] encrypted DB ready:", DB_PATH);
  return db;
}

export function getStore(): Database.Database {
  if (!db) throw new Error("[store] not initialised — call initStore() on app ready");
  return db;
}

export function closeStore(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Prune rules (Plan A):
 *   - drop online rows older than 2 days
 *   - drop offline rows already synced
 *   - NEVER drop unsynced offline rows (synced_at IS NULL), at any age
 * Child rows (order_items/payments, drawer/counts) cascade with their parent.
 */
export function prune(now: number = Date.now()): {
  orders: number;
  shifts: number;
  changeLog: number;
} {
  const d = getStore();
  const cutoff = now - ONLINE_RETENTION_MS;

  const run = d.transaction(() => {
    const prunable =
      "((origin = 'online' AND created_at < @cutoff) OR (origin = 'offline' AND synced_at IS NOT NULL))";
    const orders = d.prepare(`DELETE FROM orders WHERE ${prunable}`).run({ cutoff });
    const shifts = d.prepare(`DELETE FROM shifts WHERE ${prunable}`).run({ cutoff });
    // Outbox entries are pruned only once synced.
    const changeLog = d.prepare(`DELETE FROM change_log WHERE synced_at IS NOT NULL`).run();
    return {
      orders: orders.changes,
      shifts: shifts.changes,
      changeLog: changeLog.changes,
    };
  });

  const result = run();
  logger.info("[store] prune:", result);
  return result;
}

export { DB_PATH };
