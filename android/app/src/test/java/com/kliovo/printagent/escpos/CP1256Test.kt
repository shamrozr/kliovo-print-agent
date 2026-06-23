package com.kliovo.printagent.escpos

import org.junit.Assert.*
import org.junit.Test

class CP1256Test {

    @Test
    fun `ASCII maps to itself`() {
        val bytes = CP1256.encode("Hello")
        assertEquals(5, bytes.size)
        assertEquals('H'.code.toByte(), bytes[0])
        assertEquals('o'.code.toByte(), bytes[4])
    }

    @Test
    fun `unmapped Unicode falls back to question mark`() {
        val bytes = CP1256.encode("世")
        assertEquals(1, bytes.size)
        assertEquals(0x3F.toByte(), bytes[0])
    }

    @Test
    fun `Urdu pe maps to 0x81`() {
        val bytes = CP1256.encode("پ")
        assertEquals(1, bytes.size)
        assertEquals(0x81.toByte(), bytes[0])
    }

    @Test
    fun `Urdu ye maps to 0xFF`() {
        val bytes = CP1256.encode("ے")
        assertEquals(1, bytes.size)
        assertEquals(0xFF.toByte(), bytes[0])
    }
}
