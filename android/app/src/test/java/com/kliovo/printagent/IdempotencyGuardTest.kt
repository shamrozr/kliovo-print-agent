package com.kliovo.printagent

import com.kliovo.printagent.bridge.IdempotencyGuard
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IdempotencyGuardTest {

    @Test fun `a resent job inside the window is recognised`() {
        val g = IdempotencyGuard(ttlMs = 1_000)
        assertFalse(g.seenRecently("job-1", now = 0))
        assertTrue(g.seenRecently("job-1", now = 500))
    }

    @Test fun `the same key after the window is a new job`() {
        val g = IdempotencyGuard(ttlMs = 1_000)
        assertFalse(g.seenRecently("job-1", now = 0))
        assertFalse(g.seenRecently("job-1", now = 2_000))
    }

    @Test fun `different jobs never collide`() {
        val g = IdempotencyGuard()
        assertFalse(g.seenRecently("a"))
        assertFalse(g.seenRecently("b"))
    }
}
