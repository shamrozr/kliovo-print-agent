package com.kliovo.printagent.cloud

/**
 * Server-driven pacing. `X-Next-Poll-Ms` on every /api/print/pending response
 * says when this printer should poll next: short after a job (drain the burst),
 * short after a held 204 (re-arm the long poll), long while the queue is paused.
 *
 * Pure so it can be unit-tested without a device.
 */
object PollPacing {

    /** Pre-2.10 cadence, used when the server sends no hint. */
    const val DEFAULT_INTERVAL_MS = 2_000L

    /**
     * Clamped both ways on purpose: a bad or hostile header must be able to
     * neither hot-loop the tablet's radio nor silence a printer for an hour.
     */
    const val MIN_MS = 250L
    const val MAX_MS = 60_000L

    /** Long-poll hold we advertise via `X-Agent-Wait`. Server caps at 25s. */
    const val EXTENDED_WAIT_SECONDS = 25

    /**
     * Must stay comfortably ABOVE the advertised wait — aborting a poll the
     * server is still holding strands the ticket it was about to hand us.
     */
    const val POLL_TIMEOUT_MS = (EXTENDED_WAIT_SECONDS + 10) * 1_000

    /** ACKs are never held, so they keep a short budget of their own. */
    const val ACK_TIMEOUT_MS = 8_000

    fun nextDelayMs(header: String?): Long {
        val parsed = header?.trim()?.toLongOrNull() ?: return DEFAULT_INTERVAL_MS
        return parsed.coerceIn(MIN_MS, MAX_MS)
    }

    /**
     * A 4xx that will never succeed on retry. Replaying those forever is what
     * turned dead ACKs into a request storm that pegged the production CPU on
     * 2026-07-28 — 408 and 429 are the only ones worth trying again.
     */
    fun isPermanentHttpFailure(status: Int): Boolean =
        status in 400..499 && status != 408 && status != 429
}
