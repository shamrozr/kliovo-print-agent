package com.kliovo.printagent.ledger

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** One job we printed but have not yet successfully told the server about. */
data class PendingAck(val printJobId: String, val printerId: String, val agentKey: String)

/**
 * The dedup ledger — the half of the exactly-once contract that lives on this
 * device.
 *
 * The server delivers AT LEAST once: it treats a claim as a lease and redelivers
 * any job it never heard an ACK for (bounded to one redelivery since 2026-08-28).
 * That is only safe because the agent is idempotent — a job listed here has hit
 * paper and must be re-ACKed, never reprinted.
 *
 * `acked` tracks whether the server was told. An un-acked row is retried on a
 * later tick, so an ACK lost to a blip cannot become a phantom reprint: the job
 * comes back, we recognise it, and we only re-ACK.
 *
 * Mirrors src/store/print-ledger.ts in the desktop agent.
 */
class PrintedJobsLedger(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS printed_jobs (
              print_job_id TEXT PRIMARY KEY,
              printer_id   TEXT,
              agent_key    TEXT,
              printed_at   INTEGER NOT NULL,
              acked        INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_printed_jobs_ack ON printed_jobs(acked, printed_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Nothing to migrate yet. Never DROP: losing the ledger turns the
        // server's redelivery into a reprint of everything still un-acked.
    }

    /**
     * Whether the ledger is usable RIGHT NOW. This gates the `X-Agent-Dedup`
     * header, and the distinction matters: the header is a capability claim,
     * not a version claim. An agent on the right version with a broken database
     * must not invite redelivery it cannot refuse.
     */
    fun isReady(): Boolean = runCatching {
        readableDatabase.rawQuery("SELECT 1 FROM printed_jobs LIMIT 1", null).use { true }
    }.getOrDefault(false)

    fun hasPrinted(printJobId: String): Boolean = runCatching {
        readableDatabase.rawQuery(
            "SELECT 1 FROM printed_jobs WHERE print_job_id = ? LIMIT 1",
            arrayOf(printJobId)
        ).use { it.moveToFirst() }
    }.getOrDefault(false)

    /** Record BEFORE acking — that ordering bounds the crash window. */
    fun markPrinted(printJobId: String, printerId: String, agentKey: String) {
        runCatching {
            writableDatabase.insertWithOnConflict(
                "printed_jobs",
                null,
                ContentValues().apply {
                    put("print_job_id", printJobId)
                    put("printer_id", printerId)
                    put("agent_key", agentKey)
                    put("printed_at", System.currentTimeMillis())
                    put("acked", 0)
                },
                SQLiteDatabase.CONFLICT_IGNORE
            )
        }
    }

    fun markAcked(printJobId: String) {
        runCatching {
            writableDatabase.execSQL(
                "UPDATE printed_jobs SET acked = 1 WHERE print_job_id = ?",
                arrayOf(printJobId)
            )
        }
    }

    fun pendingAcks(limit: Int = 25): List<PendingAck> = runCatching {
        readableDatabase.rawQuery(
            "SELECT print_job_id, printer_id, agent_key FROM printed_jobs WHERE acked = 0 ORDER BY printed_at ASC LIMIT ?",
            arrayOf(limit.toString())
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(PendingAck(c.getString(0), c.getString(1) ?: "", c.getString(2) ?: ""))
                }
            }
        }
    }.getOrDefault(emptyList())

    /**
     * Drop rows older than the retention window. Only ACKED rows are pruned: an
     * un-acked row is still owed to the server, and dropping it would let a
     * later redelivery reprint a ticket that already came out.
     */
    fun prune(olderThanMs: Long = RETENTION_MS) {
        runCatching {
            writableDatabase.execSQL(
                "DELETE FROM printed_jobs WHERE acked = 1 AND printed_at < ?",
                arrayOf((System.currentTimeMillis() - olderThanMs).toString())
            )
        }
    }

    companion object {
        private const val DB_NAME = "print-ledger.db"
        private const val DB_VERSION = 1
        /** Two days, matching the desktop agent's online-row retention. */
        const val RETENTION_MS = 2L * 24 * 60 * 60 * 1000
    }
}
