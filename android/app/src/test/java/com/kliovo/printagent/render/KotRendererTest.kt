package com.kliovo.printagent.render

import org.junit.Assert.*
import org.junit.Test

class KotRendererTest {

    @Test
    fun `renders basic KOT`() {
        val input = KotInput(
            referenceNumber = "ORD-001",
            stationName = "Grill",
            fireTime = "14:30",
            items = listOf(
                KotItem(name = "Burger", quantity = 2)
            )
        )
        val bytes = KotRenderer.render(input)
        assertTrue(bytes.isNotEmpty())
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.contains("GRILL"))
        assertTrue(text.contains("2 x Burger"))
    }

    @Test
    fun `urgent KOT contains URGENT banner`() {
        val input = KotInput(
            referenceNumber = "ORD-002",
            stationName = "Fry",
            fireTime = "14:35",
            isUrgent = true,
            urgencyLabel = "12 min overdue",
            items = listOf(KotItem(name = "Fries", quantity = 1))
        )
        val bytes = KotRenderer.render(input)
        val text = String(bytes, Charsets.US_ASCII)
        assertTrue(text.contains("URGENT"))
    }
}
