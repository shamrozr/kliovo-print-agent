import Database from "better-sqlite3-multiple-ciphers";
import { app } from "electron";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { logger } from "../logger";
import type { PunchQueueItem } from "./types";

let db: Database.Database | null = null;

const DB_DIR = app.getPath("userData");
const DB_PATH = path.join(DB_DIR, "biometric-punches.db");

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS punches (
  id TEXT PRIMARY KEY,
  deviceUserId TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  direction TEXT,
  deviceId TEXT NOT NULL,
  synced INTEGER DEFAULT 0,
  syncedAt TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
)`;

export function initAttendanceStore(): void {
  if (db) return;
  fs.mkdirSync(DB_DIR, { recursive: true });

  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("busy_timeout = 5000");
  conn.prepare(CREATE_TABLE_SQL).run();

  // Identity dedup: (deviceUserId, timestamp, deviceId) uniquely identifies a
  // physical punch. With this in place the poller can queue the device's whole
  // recent log every cycle and INSERT OR IGNORE silently drops anything already
  // captured — so a new punch is ALWAYS queued, and we never depend on a
  // fragile local high-water cursor that a single bad-dated record can wedge.
  // Existing installs may already hold duplicate rows from the old logic, which
  // would make the UNIQUE index creation fail — collapse them first.
  try {
    conn
      .prepare(
        `DELETE FROM punches WHERE rowid NOT IN (
           SELECT MIN(rowid) FROM punches GROUP BY deviceUserId, timestamp, deviceId
         )`
      )
      .run();
    conn
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_identity
           ON punches(deviceUserId, timestamp, deviceId)`
      )
      .run();
  } catch (e) {
    logger.warn("[biometric] could not create punch-identity index:", e);
  }

  db = conn;
  logger.info("[biometric] attendance store ready:", DB_PATH);
}

function getDb(): Database.Database {
  if (!db) throw new Error("[biometric] attendance store not initialised");
  return db;
}

/**
 * Queue a punch. INSERT OR IGNORE against the (deviceUserId, timestamp,
 * deviceId) identity index — re-reading the device's log and re-queuing a punch
 * we already have is a silent no-op. Returns true only when a genuinely new row
 * was inserted, so callers can count how many fresh punches this poll found.
 */
export function queuePunch(punch: {
  deviceUserId: string;
  timestamp: string;
  direction?: string;
  deviceId: string;
}): boolean {
  const id = crypto.randomUUID();
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO punches (id, deviceUserId, timestamp, direction, deviceId)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, punch.deviceUserId, punch.timestamp, punch.direction ?? null, punch.deviceId);
  return info.changes > 0;
}

export function getUnsyncedPunches(limit = 50): PunchQueueItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, deviceUserId, timestamp, direction, deviceId, synced, syncedAt, createdAt
       FROM punches WHERE synced = 0 ORDER BY createdAt ASC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as string,
    deviceUserId: r.deviceUserId as string,
    timestamp: r.timestamp as string,
    direction: (r.direction as string) ?? undefined,
    deviceId: r.deviceId as string,
    synced: r.synced === 1,
    syncedAt: (r.syncedAt as string) ?? undefined,
    createdAt: r.createdAt as string,
  }));
}

export function markSynced(ids: string[]): void {
  if (ids.length === 0) return;
  const d = getDb();
  const stmt = d.prepare(
    `UPDATE punches SET synced = 1, syncedAt = datetime('now') WHERE id = ?`
  );
  const tx = d.transaction(() => {
    for (const id of ids) stmt.run(id);
  });
  tx();
}

export function pruneOldPunches(): void {
  const result = getDb()
    .prepare(
      `DELETE FROM punches WHERE synced = 1 AND createdAt < datetime('now', '-7 days')`
    )
    .run();
  if (result.changes > 0) {
    logger.info(`[biometric] pruned ${result.changes} old synced punches`);
  }
}

export function getQueueDepth(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM punches WHERE synced = 0`)
    .get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}
