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

  db = conn;
  logger.info("[biometric] attendance store ready:", DB_PATH);
}

function getDb(): Database.Database {
  if (!db) throw new Error("[biometric] attendance store not initialised");
  return db;
}

export function queuePunch(punch: {
  deviceUserId: string;
  timestamp: string;
  direction?: string;
  deviceId: string;
}): void {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO punches (id, deviceUserId, timestamp, direction, deviceId)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, punch.deviceUserId, punch.timestamp, punch.direction ?? null, punch.deviceId);
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
