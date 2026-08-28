package com.kliovo.printagent

import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.config.PrinterEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrinterEntryTest {

    private fun bt(address: String? = "AA:BB:CC:DD:EE:FF") = PrinterEntry(
        printerId = "p1", agentKey = "k1", name = "Counter", connection = "bluetooth",
        bluetoothAddress = address,
    )

    @Test fun `round-trips through json`() {
        val list = listOf(bt(), PrinterEntry("p2", "k2", "Kitchen", "network", host = "192.168.1.50", port = 9100))
        val back = PrinterEntry.listFromJson(PrinterEntry.listToJson(list))
        assertEquals(list, back)
    }

    @Test fun `garbage json yields no printers rather than a crash`() {
        assertTrue(PrinterEntry.listFromJson("{not json").isEmpty())
        assertTrue(PrinterEntry.listFromJson(null).isEmpty())
    }

    @Test fun `a row missing its key can never poll`() {
        assertFalse(bt().copy(agentKey = "").isPollable)
        assertFalse(bt().copy(printerId = "").isPollable)
        assertTrue(bt().isPollable)
    }

    @Test fun `a bluetooth row with no address is not addressable`() {
        assertFalse(bt(address = null).isAddressable)
        assertTrue(bt().isAddressable)
    }

    @Test fun `server url loses its trailing slash once, here`() {
        assertEquals("https://dine.kliovo.com", ConfigStore.normalizeServerUrl("https://dine.kliovo.com/"))
        assertEquals("https://dine.kliovo.com", ConfigStore.normalizeServerUrl("  https://dine.kliovo.com//  "))
        assertEquals(ConfigStore.DEFAULT_SERVER, ConfigStore.normalizeServerUrl("   "))
    }
}
