package com.kliovo.printagent.bridge

/**
 * Short-window dedup for the LOCAL bridge only — a POS that re-sends a job on a
 * flaky reconnect must not print it twice. This is not the cloud dedup ledger:
 * that one is durable and governs redelivery. Keeping them separate is
 * deliberate; conflating them would let a browser retry evict a real ledger row.
 */
class IdempotencyGuard(private val ttlMs: Long = 60_000) {

    private val seen = LinkedHashMap<String, Long>()

    @Synchronized
    fun seenRecently(key: String, now: Long = System.currentTimeMillis()): Boolean {
        val it = seen.entries.iterator()
        while (it.hasNext()) {
            if (now - it.next().value > ttlMs) it.remove() else break
        }
        if (seen.containsKey(key)) return true
        seen[key] = now
        return false
    }
}
