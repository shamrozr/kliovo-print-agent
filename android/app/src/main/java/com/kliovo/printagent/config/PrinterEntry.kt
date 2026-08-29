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
    /**
     * "bluetooth" — Classic SPP, paired in Android's settings
     * "ble"       — BLE/GATT, discovered by scanning and never paired
     * "network"   — raw TCP, port 9100
     */
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
    val isBle: Boolean get() = connection == "ble"

    /** Either radio — both address a printer by MAC rather than by host. */
    val isBluetooth: Boolean get() = connection == "bluetooth" || isBle

    /** A row that can actually be polled — anything else only burns requests. */
    val isPollable: Boolean get() = printerId.isNotBlank() && agentKey.isNotBlank()

    /** A row that can actually be delivered to. */
    val isAddressable: Boolean
        get() = if (isBluetooth) !bluetoothAddress.isNullOrBlank() else !host.isNullOrBlank()

    /**
     * Absent keys, never JSONObject.NULL. Android's `optString` renders the NULL
     * sentinel as the literal string "null", so a Bluetooth printer would read
     * back with host = "null" — a value that looks set, passes an isNullOrBlank
     * check, and sends the agent to a hostname that does not exist.
     */
    fun toJson(): JSONObject = JSONObject().apply {
        put("printerId", printerId)
        put("agentKey", agentKey)
        put("name", name)
        put("connection", connection)
        bluetoothAddress?.let { put("bluetoothAddress", it) }
        host?.let { put("host", it) }
        put("port", port)
        chunkSizeBytes?.let { put("chunkSizeBytes", it) }
        interChunkDelayMs?.let { put("interChunkDelayMs", it) }
    }

    companion object {
        /** Reads a key as a real null when it is absent OR the NULL sentinel. */
        private fun JSONObject.optStringOrNull(key: String): String? =
            if (isNull(key)) null else optString(key).trim().ifBlank { null }

        fun fromJson(o: JSONObject): PrinterEntry = PrinterEntry(
            printerId = o.optStringOrNull("printerId").orEmpty(),
            agentKey = o.optStringOrNull("agentKey").orEmpty(),
            name = o.optStringOrNull("name") ?: o.optStringOrNull("printerId").orEmpty(),
            connection = o.optStringOrNull("connection") ?: "network",
            bluetoothAddress = o.optStringOrNull("bluetoothAddress"),
            host = o.optStringOrNull("host"),
            port = if (o.optInt("port") > 0) o.optInt("port") else 9100,
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
