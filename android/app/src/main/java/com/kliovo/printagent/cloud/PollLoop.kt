package com.kliovo.printagent.cloud

import android.content.Context
import android.util.Log
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.config.PrinterEntry
import com.kliovo.printagent.health.HealthTracker
import com.kliovo.printagent.health.PrintResult
import com.kliovo.printagent.ledger.PrintedJobsLedger
import com.kliovo.printagent.transport.Deliver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val TAG = "PollLoop"

/**
 * One coroutine per printer, each holding a long poll open and delivering what
 * comes back. The ordering inside `handleJob` is the exactly-once contract and
 * must not be rearranged — see the comments on each step.
 */
class PollLoop(
    private val context: Context,
    private val config: ConfigStore,
    private val ledger: PrintedJobsLedger,
    private val agentVersion: String,
) {

    private val jobs = mutableListOf<Job>()

    fun start(scope: CoroutineScope) {
        stop()
        val client = CloudClient(config.serverUrl, agentVersion)
        // A row that can never poll only burns requests and log noise.
        val pollable = config.printers.filter { it.isPollable }
        for (printer in pollable) {
            jobs += scope.launch { runPrinter(client, printer) }
        }
        jobs += scope.launch { flushPendingAcks(client) }
        Log.i(TAG, "started for ${pollable.size} printer(s)")
    }

    fun stop() {
        jobs.forEach { it.cancel() }
        jobs.clear()
    }

    private suspend fun runPrinter(client: CloudClient, printer: PrinterEntry) {
        var backoffMs = 0L
        while (currentCoroutineContext().isActive) {
            if (backoffMs > 0) delay(backoffMs)
            when (val result = client.poll(printer.printerId, printer.agentKey, ledger.isReady())) {
                is PollResult.Idle -> {
                    HealthTracker.recordPoll()
                    backoffMs = client.lastPollHintMs
                }
                is PollResult.Job -> {
                    HealthTracker.recordPoll()
                    handleJob(client, printer, result.job)
                    backoffMs = client.lastPollHintMs
                }
                is PollResult.Failed -> {
                    Log.w(TAG, "poll ${printer.printerId} failed: ${result.message}")
                    // Back off harder on a server/network problem than the
                    // pacing hint would, so a dead uplink doesn't hammer.
                    backoffMs = 10_000
                }
            }
        }
    }

    private suspend fun handleJob(client: CloudClient, printer: PrinterEntry, job: PendingJob) {
        // Redelivery of something we already printed — the server simply never
        // heard our ACK. Re-ACK and print NOTHING. This is the whole reason the
        // server is allowed to redeliver at all.
        if (ledger.hasPrinted(job.printJobId)) {
            Log.i(TAG, "job ${job.printJobId} already printed — re-acking, not reprinting")
            if (client.ack(job.printJobId, printer.agentKey) in 200..299) ledger.markAcked(job.printJobId)
            return
        }

        val outcome = Deliver.deliver(context, printer, job.bytes)
        if (!outcome.isOk) {
            HealthTracker.record(
                PrintResult(printer.printerId, printer.name, "queued", ok = false, error = outcome.message)
            )
            // NACK rather than leaving it: an uncleared `printing` job is
            // reclaimed as the OLDEST row on every later poll and head-of-line
            // blocks every newer ticket to this printer while it is down.
            client.nack(job.printJobId, printer.agentKey, outcome.message)
            Log.w(TAG, "delivery failed for ${job.printJobId}: ${outcome.message} — nacked")
            return
        }

        // Record BEFORE acking: the gap between paper coming out and the ledger
        // write is the only window a crash could duplicate, so keep it minimal.
        ledger.markPrinted(job.printJobId, printer.printerId, printer.agentKey)
        HealthTracker.record(PrintResult(printer.printerId, printer.name, "queued", ok = true))

        val status = client.ack(job.printJobId, printer.agentKey)
        if (status in 200..299) {
            ledger.markAcked(job.printJobId)
        } else if (PollPacing.isPermanentHttpFailure(status)) {
            // A definitive rejection (unknown job, revoked key) will never
            // succeed. Leaving it pending replays it on every tick forever —
            // thousands of dead ACKs compounded into a request storm that
            // pegged the production CPU on 2026-07-28.
            Log.w(TAG, "ack ${job.printJobId} rejected with $status — dropping")
            ledger.markAcked(job.printJobId)
        }
        // Anything else (network failure, 5xx, 429) stays pending and is retried
        // by flushPendingAcks below.
    }

    /**
     * Retry ACKs we printed but could not report. An un-acked row is a job the
     * server still believes is in flight, so it will be redelivered — and the
     * ledger is what makes that safe.
     */
    private suspend fun flushPendingAcks(client: CloudClient) {
        while (currentCoroutineContext().isActive) {
            delay(60_000)
            val pending = ledger.pendingAcks()
            if (pending.isEmpty()) {
                ledger.prune()
                continue
            }
            Log.i(TAG, "retrying ${pending.size} pending ack(s)")
            for (p in pending) {
                val status = client.ack(p.printJobId, p.agentKey)
                if (status in 200..299 || PollPacing.isPermanentHttpFailure(status)) {
                    ledger.markAcked(p.printJobId)
                }
            }
        }
    }
}
