package com.kliovo.printagent

import com.kliovo.printagent.cloud.PollPacing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PollPacingTest {

    @Test fun `absent header keeps the pre-2_10 cadence`() {
        assertEquals(PollPacing.DEFAULT_INTERVAL_MS, PollPacing.nextDelayMs(null))
    }

    @Test fun `garbage header does not hot-loop the radio`() {
        assertEquals(PollPacing.DEFAULT_INTERVAL_MS, PollPacing.nextDelayMs("soon"))
        assertEquals(PollPacing.DEFAULT_INTERVAL_MS, PollPacing.nextDelayMs(""))
    }

    @Test fun `clamped both ways so a bad header cannot silence a printer`() {
        assertEquals(PollPacing.MIN_MS, PollPacing.nextDelayMs("0"))
        assertEquals(PollPacing.MIN_MS, PollPacing.nextDelayMs("-5000"))
        assertEquals(PollPacing.MAX_MS, PollPacing.nextDelayMs("3600000"))
    }

    @Test fun `honours a sane server hint`() {
        assertEquals(500L, PollPacing.nextDelayMs("500"))
        assertEquals(5_000L, PollPacing.nextDelayMs(" 5000 "))
    }

    @Test fun `the poll timeout stays above the advertised hold`() {
        // Aborting a poll the server is still holding strands the ticket it was
        // about to hand us. The margin is the whole safety property.
        assertTrue(PollPacing.POLL_TIMEOUT_MS > PollPacing.EXTENDED_WAIT_SECONDS * 1000)
    }

    @Test fun `only 408 and 429 are worth retrying among 4xx`() {
        assertTrue(PollPacing.isPermanentHttpFailure(400))
        assertTrue(PollPacing.isPermanentHttpFailure(401))
        assertTrue(PollPacing.isPermanentHttpFailure(404))
        assertFalse(PollPacing.isPermanentHttpFailure(408))
        assertFalse(PollPacing.isPermanentHttpFailure(429))
        assertFalse(PollPacing.isPermanentHttpFailure(500))
        assertFalse(PollPacing.isPermanentHttpFailure(0))
    }
}
