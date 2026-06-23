package com.kliovo.printagent.bridge

class IdempotencyGuard(private val ttlMs: Long = 60_000L) {

    private val seen = mutableMapOf<String, Long>()

    fun seenRecently(key: String): Boolean {
        val now = System.currentTimeMillis()
        seen.entries.removeAll { now - it.value > ttlMs }
        if (seen.containsKey(key)) return true
        seen[key] = now
        return false
    }
}
