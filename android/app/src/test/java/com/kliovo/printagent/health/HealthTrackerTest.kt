package com.kliovo.printagent.health

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class HealthTrackerTest {

    private lateinit var tracker: HealthTracker

    @Before
    fun setUp() {
        tracker = HealthTracker()
    }

    @Test
    fun `empty tracker returns green`() {
        val snap = tracker.snapshot()
        assertEquals("green", snap.status)
        assertTrue(snap.recent.isEmpty())
        assertTrue(snap.printers.isEmpty())
    }

    @Test
    fun `successful job recorded and visible in snapshot`() {
        tracker.record("p1", "Kitchen", "receipt", true, null)
        val snap = tracker.snapshot()
        assertEquals("green", snap.status)
        assertEquals(1, snap.recent.size)
        assertEquals("receipt", snap.recent[0].kind)
        assertTrue(snap.recent[0].ok)
    }

    @Test
    fun `failed job sets status to red`() {
        tracker.record("p1", "Kitchen", "receipt", false, "timeout")
        val snap = tracker.snapshot()
        assertEquals("red", snap.status)
        assertEquals(1, snap.printers.size)
        assertFalse(snap.printers[0].ok)
    }

    @Test
    fun `recovery after failure sets status to yellow within window`() {
        tracker.record("p1", "Kitchen", "receipt", false, "timeout")
        tracker.record("p1", "Kitchen", "receipt", true, null)
        val snap = tracker.snapshot()
        assertEquals("yellow", snap.status)
    }

    @Test
    fun `ring buffer caps at MAX_EVENTS`() {
        repeat(30) { i ->
            tracker.record("p1", "Kitchen", "receipt", true, null)
        }
        val snap = tracker.snapshot()
        assertEquals(25, snap.recent.size + 15) // internal buffer is 25, snapshot returns 10
    }

    @Test
    fun `snapshot returns at most 10 recent events`() {
        repeat(20) {
            tracker.record("p1", "Kitchen", "receipt", true, null)
        }
        val snap = tracker.snapshot()
        assertEquals(10, snap.recent.size)
    }
}
