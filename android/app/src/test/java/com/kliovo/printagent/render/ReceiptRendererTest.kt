package com.kliovo.printagent.render

import org.junit.Assert.*
import org.junit.Test

class ReceiptRendererTest {

    @Test
    fun `renders minimal receipt without crashing`() {
        val input = ReceiptInput(
            header = ReceiptHeader(tenantName = "Test Cafe"),
            referenceNumber = "ORD-001",
            date = "2026-06-24",
            time = "14:30",
            orderType = "dine_in",
            items = listOf(
                ReceiptItem(name = "Burger", quantity = 2, unitPricePaisa = 50000, totalPricePaisa = 100000)
            ),
            subtotalPaisa = 100000,
            totalPaisa = 100000,
            paidPaisa = 100000,
            balanceDuePaisa = 0,
            payments = listOf(ReceiptPayment(method = "cash", amountPaisa = 100000))
        )
        val bytes = ReceiptRenderer.render(input)
        assertTrue(bytes.isNotEmpty())
        assertEquals(0x1B.toByte(), bytes[0])
        assertEquals(0x40.toByte(), bytes[1])
    }

    @Test
    fun `receipt contains tenant name`() {
        val input = ReceiptInput(
            header = ReceiptHeader(tenantName = "BurgerLub"),
            referenceNumber = "ORD-002",
            date = "2026-06-24",
            time = "15:00",
            orderType = "takeaway",
            items = listOf(
                ReceiptItem(name = "Fries", quantity = 1, unitPricePaisa = 20000, totalPricePaisa = 20000)
            ),
            subtotalPaisa = 20000,
            totalPaisa = 20000,
            paidPaisa = 20000,
            balanceDuePaisa = 0,
            payments = listOf(ReceiptPayment(method = "cash", amountPaisa = 20000))
        )
        val bytes = ReceiptRenderer.render(input)
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.contains("BurgerLub"))
    }
}
