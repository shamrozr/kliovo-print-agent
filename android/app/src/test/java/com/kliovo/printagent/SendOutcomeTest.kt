package com.kliovo.printagent

import com.kliovo.printagent.transport.SendOutcome
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SendOutcomeTest {

    @Test fun `only a provably pre-connect failure is retryable`() {
        // Everything after connect() may already be on the tape; retrying it
        // prints a second ticket.
        assertTrue(SendOutcome.ConnectFailed("no route").isRetryable)
        assertFalse(SendOutcome.WriteFailed("dropped mid-write").isRetryable)
        assertFalse(SendOutcome.Unknown("who knows").isRetryable)
        assertFalse(SendOutcome.Ok.isRetryable)
    }

    @Test fun `ok is the only success`() {
        assertTrue(SendOutcome.Ok.isOk)
        assertFalse(SendOutcome.ConnectFailed("x").isOk)
    }
}
