package com.kliovo.printagent.bridge

import org.junit.Assert.*
import org.junit.Test

class IdempotencyGuardTest {

    @Test
    fun `first key returns false`() {
        val guard = IdempotencyGuard()
        assertFalse(guard.seenRecently("key-1"))
    }

    @Test
    fun `same key returns true`() {
        val guard = IdempotencyGuard()
        guard.seenRecently("key-1")
        assertTrue(guard.seenRecently("key-1"))
    }

    @Test
    fun `different keys are independent`() {
        val guard = IdempotencyGuard()
        guard.seenRecently("key-1")
        assertFalse(guard.seenRecently("key-2"))
    }
}
