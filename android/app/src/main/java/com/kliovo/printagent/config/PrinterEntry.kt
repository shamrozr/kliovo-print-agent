package com.kliovo.printagent.config

import org.json.JSONArray
import org.json.JSONObject

/**
 * How to reach one printer, and how to authenticate its cloud queue.
 *
 * Mirrors PrinterEntry in the desktop agent (src/config.ts). `printerId` +
 * `agentKey` come from Dine > Settings > Printers and are what the poll and the
 * ACK authenticate with; a row missing either can never poll and is skipped
 * rather than retried forever.
 */
data class PrinterEntry(
    val printerId: String,
    val agentKey: String,
    val name: String,
    /** "bluetooth" — paired SPP printer · "network" — raw TCP, port 9100. */
    val connection: String,
    /** Bluetooth only: the paired device MAC, e.g. "AA:BB:CC:DD:EE:FF". */
    val bluetoothAddress: String? = null,
    /** Network only. */
    val host: String? = null,
    val port: Int = 9100,
    /**
     * Per-printer overrides of the chunking defaults. Cheap boards vary wildly
     * in buffer size, so these exist to tune a printer that garbles long
     * receipts without slowing every other printer down.
     */
    val chunkSizeBytes: Int? = null,
    val interChunkDelayMs: Long? = null,
) {
    val isBluetooth: Boolean get() = connection == "bluetooth"

    /** A row that can actually be polled — anything else only burns requests. */
    val isPollable: Boolean get() = printerId.isNotBlank() && agentKey.isNotBlank()

    /** A row that can actually be delivered to. */
    val isAddressable: Boolean
        get() = if (isBluetooth) !bluetoothAddress.isNullOrBlank() else !host.isNullOrBlank()

    fun toJson(): JSONObject = JSONObject().apply {
        put("printerId", printerId)
        put("agentKey", agentKey)
        put("name", name)
        put("connection", connection)
        put("bluetoothAddress", bluetoothAddress ?: JSONObject.NULL)
        put("host", host ?: JSONObject.NULL)
        put("port", port)
        put("chunkSizeBytes", chunkSizeBytes ?: JSONObject.NULL)
        put("interChunkDelayMs", interChunkDelayMs ?: JSONObject.NULL)
    }

    companion object {
        fun fromJson(o: JSONObject): PrinterEntry = PrinterEntry(
            printerId = o.optString("printerId"),
            agentKey = o.optString("agentKey"),
            name = o.optString("name").ifBlank { o.optString("printerId") },
            connection = o.optString("connection").ifBlank { "network" },
            bluetoothAddress = o.optString("bluetoothAddress").ifBlank { null },
            host = o.optString("host").ifBlank { null },
            port = if (o.has("port") && o.optInt("port") > 0) o.optInt("port") else 9100,
            chunkSizeBytes = if (o.optInt("chunkSizeBytes", 0) > 0) o.optInt("chunkSizeBytes") else null,
            interChunkDelayMs = if (o.optLong("interChunkDelayMs", -1) >= 0) o.optLong("interChunkDelayMs") else null,
        )

        fun listFromJson(raw: String?): List<PrinterEntry> {
            if (raw.isNullOrBlank()) return emptyList()
            return runCatching {
                val arr = JSONArray(raw)
                (0 until arr.length()).map { fromJson(arr.getJSONObject(it)) }
            }.getOrElse { emptyList() }
        }

        fun listToJson(printers: List<PrinterEntry>): String =
            JSONArray().apply { printers.forEach { put(it.toJson()) } }.toString()
    }
}
