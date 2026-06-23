package com.kliovo.printagent.render

import org.junit.Assert.*
import org.junit.Test

class LabelRendererTest {

    @Test
    fun `renders label with reference number`() {
        val input = LabelInput(
            referenceNumber = "ORD-100",
            customerName = "Ali",
            orderType = "delivery"
        )
        val bytes = LabelRenderer.render(input)
        assertTrue(bytes.isNotEmpty())
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.contains("ORD-100"))
        assertTrue(text.contains("Ali"))
    }
}
