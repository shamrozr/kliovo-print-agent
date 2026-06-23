package com.kliovo.printagent.escpos

import org.junit.Assert.*
import org.junit.Test

class FormatPaisaTest {

    @Test
    fun `whole rupee amount`() {
        assertEquals("Rs 1,234", FormatPaisa.format(123400))
    }

    @Test
    fun `zero amount`() {
        assertEquals("Rs 0", FormatPaisa.format(0))
    }

    @Test
    fun `fractional paisa`() {
        assertEquals("Rs 0.50", FormatPaisa.format(50))
    }

    @Test
    fun `large amount with commas`() {
        assertEquals("Rs 100,000", FormatPaisa.format(10000000))
    }
}
