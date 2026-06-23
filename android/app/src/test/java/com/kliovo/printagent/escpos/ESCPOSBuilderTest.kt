package com.kliovo.printagent.escpos

import org.junit.Assert.*
import org.junit.Test

class ESCPOSBuilderTest {

    @Test
    fun `init emits ESC @ then code page`() {
        val bytes = ESCPOSBuilder().init().build()
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x40.toByte(), bytes[1])
        assertEquals(0x1B.toByte(), bytes[2])
        assertEquals(0x74.toByte(), bytes[3])
        assertEquals(CP1256.CODE_PAGE.toByte(), bytes[4])
    }

    @Test
    fun `text appends encoded bytes`() {
        val bytes = ESCPOSBuilder().init().text("Hi").build()
        val textStart = 5
        assertEquals('H'.code.toByte(), bytes[textStart])
        assertEquals('i'.code.toByte(), bytes[textStart + 1])
    }

    @Test
    fun `align center emits ESC a 1`() {
        val bytes = ESCPOSBuilder().align("center").build()
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x61.toByte(), bytes[1])
        assertEquals(0x01.toByte(), bytes[2])
    }

    @Test
    fun `bold on emits ESC E 1`() {
        val bytes = ESCPOSBuilder().bold(true).build()
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x45.toByte(), bytes[1])
        assertEquals(0x01.toByte(), bytes[2])
    }

    @Test
    fun `cut emits feed then GS V`() {
        val bytes = ESCPOSBuilder().cut(true).build()
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x64.toByte(), bytes[1])
        assertEquals(0x01.toByte(), bytes[2])
        assertEquals(0x1D.toByte(), bytes[3])
        assertEquals(0x56.toByte(), bytes[4])
        assertEquals(0x00.toByte(), bytes[5])
    }

    @Test
    fun `row pads with spaces to paper width`() {
        val bytes = ESCPOSBuilder().row("Total", "Rs 100", 80).build()
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.startsWith("Total"))
        assertTrue(text.endsWith("Rs 100\n"))
        assertEquals(49, bytes.size)
    }

    @Test
    fun `rule fills paper width`() {
        val bytes = ESCPOSBuilder().rule(80, "-").build()
        val text = String(bytes, Charsets.US_ASCII)
        assertEquals(48 + 1, text.length)
    }
}
