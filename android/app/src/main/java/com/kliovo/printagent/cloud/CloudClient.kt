package com.kliovo.printagent.cloud

import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** A job the server handed us, already rendered by the server. */
class PendingJob(val printJobId: String, val bytes: ByteArray)

sealed class PollResult {
    /** 204 — nothing queued. Body-less by contract; never parsed. */
    object Idle : PollResult()
    data class Job(val job: PendingJob) : PollResult()
    data class Failed(val status: Int, val message: String) : PollResult()
}

/**
 * The Dine print queue, over HTTP. A thin mirror of the desktop agent's
 * polling.ts — the header set below is a contract, and each rule has an
 * incident behind it (see docs/ANDROID-AGENT-PLAN.md).
 *
 * THE AGENT NEVER RENDERS. The server sends finished ESC/POS bytes; a second
 * renderer here would drift from the TypeScript one and the same ticket would
 * print differently depending on which agent collected it.
 *
 * OkHttp rather than HttpURLConnection for one concrete reason: the ACK is a
 * real `PATCH` and the route accepts nothing else, while HttpURLConnection
 * cannot issue PATCH at all.
 */
class CloudClient(
    private val serverUrl: String,
    private val agentVersion: String,
    client: OkHttpClient? = null,
) {

    private val http: OkHttpClient = client ?: OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // Must stay comfortably above the advertised hold — aborting a poll the
        // server is still holding strands the ticket it was about to hand us.
        .readTimeout(PollPacing.POLL_TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** Set by the last poll from `X-Next-Poll-Ms`; the loop paces itself off it. */
    @Volatile
    var lastPollHintMs: Long = PollPacing.DEFAULT_INTERVAL_MS
        private set

    fun poll(printerId: String, agentKey: String, dedupReady: Boolean): PollResult {
        val req = Request.Builder()
            .url("$serverUrl/api/print/pending?printerId=${enc(printerId)}")
            .header("Authorization", "Bearer $agentKey")
            // Lets the server record a heartbeat (lastSeenAt + version) so the
            // web shows this agent connected even when nothing is printing.
            .header("X-Agent-Version", agentVersion)
            .header("X-Agent-Wait", PollPacing.EXTENDED_WAIT_SECONDS.toString())
            .apply {
                // A capability claim, not a version claim: sent only while the
                // ledger can actually refuse a duplicate. The server redelivers
                // only to agents that send it, and redelivering to one that
                // cannot dedup turns a lost ticket into a double print.
                if (dedupReady) header("X-Agent-Dedup", "1")
            }
            .get()
            .build()

        return try {
            http.newCall(req).execute().use { res ->
                lastPollHintMs = PollPacing.nextDelayMs(res.header("X-Next-Poll-Ms"))
                when {
                    res.code == 204 -> PollResult.Idle
                    res.isSuccessful -> {
                        val body = res.body?.string().orEmpty()
                        val json = JSONObject(body)
                        val id = json.optString("printJobId")
                        val b64 = json.optString("bytesBase64")
                        if (id.isBlank() || b64.isBlank()) PollResult.Failed(res.code, "Malformed job payload")
                        else PollResult.Job(PendingJob(id, Base64.decode(b64, Base64.DEFAULT)))
                    }
                    else -> PollResult.Failed(res.code, "HTTP ${res.code}")
                }
            }
        } catch (e: Exception) {
            PollResult.Failed(0, e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * ACK a printed job. The Bearer header is not optional: without it the route
     * falls through to session auth and 401s, which is how 23,918 jobs once sat
     * at `printing` forever with a printed ticket indistinguishable from a lost
     * one. Returns the HTTP status; 0 means the request never completed.
     */
    fun ack(printJobId: String, agentKey: String): Int =
        patch(printJobId, agentKey, JSONObject().put("action", "ack"))

    /**
     * NACK a job we could not deliver. This is what kills head-of-line blocking:
     * a job left `printing` on a dead printer is reclaimed as the OLDEST row on
     * every later poll and blocks every newer ticket to that printer.
     */
    fun nack(printJobId: String, agentKey: String, error: String): Int =
        patch(printJobId, agentKey, JSONObject().put("action", "nack").put("error", error.take(500)))

    private fun patch(printJobId: String, agentKey: String, body: JSONObject): Int {
        val req = Request.Builder()
            .url("$serverUrl/api/print/${enc(printJobId)}")
            .header("Authorization", "Bearer $agentKey")
            .header("X-Agent-Version", agentVersion)
            .patch(body.toString().toRequestBody(JSON))
            .build()
        return try {
            // ACKs are never held open, so they get their own short budget.
            http.newBuilder()
                .readTimeout(PollPacing.ACK_TIMEOUT_MS.toLong(), TimeUnit.MILLISECONDS)
                .build()
                .newCall(req)
                .execute()
                .use { it.code }
        } catch (e: Exception) {
            0
        }
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
