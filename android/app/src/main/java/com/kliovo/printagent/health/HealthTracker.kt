package com.kliovo.printagent.health

data class JobEvent(
    val ts: Long,
    val printerId: String,
    val printerName: String,
    val kind: String,
    val ok: Boolean,
    val error: String?
)

data class PrinterStatus(val printerId: String, val ok: Boolean)

data class HealthSnapshot(
    val status: String,
    val printers: List<PrinterStatus>,
    val recent: List<JobEvent>
)

class HealthTracker {

    private val events = mutableListOf<JobEvent>()
    private val lastResultByPrinter = mutableMapOf<String, Boolean>()
    private val recentWindowMs = 5 * 60_000L

    fun record(
        printerId: String,
        printerName: String,
        kind: String,
        ok: Boolean,
        error: String?
    ) {
        val evt = JobEvent(
            ts = System.currentTimeMillis(),
            printerId = printerId,
            printerName = printerName,
            kind = kind,
            ok = ok,
            error = error
        )
        events.add(0, evt)
        if (events.size > MAX_EVENTS) {
            events.removeAt(events.lastIndex)
        }
        lastResultByPrinter[printerId] = ok
    }

    fun snapshot(): HealthSnapshot {
        return HealthSnapshot(
            status = computeStatus(),
            printers = lastResultByPrinter.map { (id, ok) -> PrinterStatus(id, ok) },
            recent = events.take(10)
        )
    }

    fun computeStatus(): String {
        val states = lastResultByPrinter.values
        if (states.any { !it }) return "red"
        val now = System.currentTimeMillis()
        val recentFailure = events.any { !it.ok && now - it.ts < recentWindowMs }
        if (recentFailure) return "yellow"
        return "green"
    }

    companion object {
        private const val MAX_EVENTS = 25
    }
}
