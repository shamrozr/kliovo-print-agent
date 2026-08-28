package com.kliovo.printagent.config

import android.content.Context
import android.content.SharedPreferences

/**
 * Agent config, in SharedPreferences. Deliberately small: this agent holds no
 * order data and no database key — only the server URL and one scoped agent key
 * per printer, which is the same credential the desktop agent stores.
 */
class ConfigStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("kliovo-agent", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER, DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(value) = prefs.edit().putString(KEY_SERVER, normalizeServerUrl(value)).apply()

    var printers: List<PrinterEntry>
        get() = PrinterEntry.listFromJson(prefs.getString(KEY_PRINTERS, null))
        set(value) = prefs.edit().putString(KEY_PRINTERS, PrinterEntry.listToJson(value)).apply()

    /** Start the agent service automatically after a reboot. */
    var autoStart: Boolean
        get() = prefs.getBoolean(KEY_AUTOSTART, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTOSTART, value).apply()

    fun upsertPrinter(entry: PrinterEntry) {
        val next = printers.filter { it.printerId != entry.printerId } + entry
        printers = next
    }

    fun removePrinter(printerId: String) {
        printers = printers.filter { it.printerId != printerId }
    }

    fun findPrinter(printerId: String): PrinterEntry? = printers.firstOrNull { it.printerId == printerId }

    companion object {
        private const val KEY_SERVER = "serverUrl"
        private const val KEY_PRINTERS = "printers"
        private const val KEY_AUTOSTART = "autoStart"
        const val DEFAULT_SERVER = "https://dine.kliovo.com"

        /** Trailing slashes break `$serverUrl/api/...`; strip them once, here. */
        fun normalizeServerUrl(raw: String): String =
            raw.trim().trimEnd('/').ifBlank { DEFAULT_SERVER }
    }
}
