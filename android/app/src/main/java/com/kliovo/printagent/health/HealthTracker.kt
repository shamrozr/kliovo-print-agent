package com.kliovo.printagent.health

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

data class PrintResult(
    val printerId: String,
    val printerName: String,
    val kind: String,          // queued | raw | test
    val ok: Boolean,
    val error: String? = null,
    val at: Long = System.currentTimeMillis(),
)

data class PrinterHealth(
    val printerId: String,
    val printerName: String,
    val lastOkAt: Long? = null,
    val lastErrorAt: Long? = null,
    val lastError: String? = null,
    val okCount: Int = 0,
    val failCount: Int = 0,
) {
    val isHealthy: Boolean get() = lastErrorAt == null || (lastOkAt ?: 0) >= lastErrorAt
}

/**
 * What actually happened, so a manager can answer "did it print?" from the
 * tablet without reading a log. Kept in memory only — this is diagnostics, not
 * the dedup ledger, and it must never be confused with it.
 */
object HealthTracker {

    private const val RECENT_LIMIT = 30

    private val _recent = MutableStateFlow<List<PrintResult>>(emptyList())
    val recent: StateFlow<List<PrintResult>> = _recent

    private val _perPrinter = MutableStateFlow<Map<String, PrinterHealth>>(emptyMap())
    val perPrinter: StateFlow<Map<String, PrinterHealth>> = _perPrinter

    private val _lastPollAt = MutableStateFlow(0L)
    val lastPollAt: StateFlow<Long> = _lastPollAt

    fun recordPoll() {
        _lastPollAt.value = System.currentTimeMillis()
    }

    fun record(result: PrintResult) {
        _recent.value = (listOf(result) + _recent.value).take(RECENT_LIMIT)
        val prev = _perPrinter.value[result.printerId]
            ?: PrinterHealth(result.printerId, result.printerName)
        _perPrinter.value = _perPrinter.value + (result.printerId to
            if (result.ok) prev.copy(
                printerName = result.printerName,
                lastOkAt = result.at,
                okCount = prev.okCount + 1,
            ) else prev.copy(
                printerName = result.printerName,
                lastErrorAt = result.at,
                lastError = result.error,
                failCount = prev.failCount + 1,
            )
        )
    }
}
