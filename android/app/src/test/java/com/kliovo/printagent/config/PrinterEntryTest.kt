package com.kliovo.printagent.config

import com.google.gson.Gson
import org.junit.Assert.*
import org.junit.Test

class PrinterEntryTest {

    private val gson = Gson()

    @Test
    fun `serialize and deserialize PrinterEntry`() {
        val entry = PrinterEntry(
            printerId = "printer-1",
            agentKey = "ak_123",
            host = "192.168.1.100",
            port = 9100,
            name = "Kitchen",
            paperWidth = 80
        )
        val json = gson.toJson(entry)
        val restored = gson.fromJson(json, PrinterEntry::class.java)
        assertEquals(entry.printerId, restored.printerId)
        assertEquals(entry.host, restored.host)
        assertEquals(entry.port, restored.port)
        assertEquals(entry.paperWidth, restored.paperWidth)
    }

    @Test
    fun `default port is 9100`() {
        val entry = PrinterEntry(
            printerId = "p1",
            agentKey = "ak",
            host = "10.0.0.1",
            name = "Test"
        )
        assertEquals(9100, entry.port)
        assertEquals(80, entry.paperWidth)
    }

    @Test
    fun `AgentConfig defaults`() {
        val config = AgentConfig()
        assertEquals("https://dine.kliovo.com", config.serverUrl)
        assertTrue(config.printers.isEmpty())
    }
}
