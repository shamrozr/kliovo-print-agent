package com.kliovo.printagent.transport

/**
 * Where in a delivery's lifecycle it failed — the ONLY thing that decides
 * whether a retry is safe.
 *
 * Mirrors the `connected` boundary in the desktop agent's tcp-sender.ts: retry
 * is allowed only when we can PROVE nothing reached the printer. Anything after
 * the connection is established may already be on the tape, and a retry there
 * prints a second ticket.
 */
sealed class SendOutcome {
    object Ok : SendOutcome()

    /** Provably zero bytes written — the socket never finished connecting. */
    data class ConnectFailed(val message: String) : SendOutcome() 

    /** Connected, then failed. Some bytes may have printed. Never retry. */
    data class WriteFailed(val message: String) : SendOutcome()

    /**
     * Unclassifiable. Treated as "may have printed" — never retried — matching
     * the conservative bias of the post-connect branch.
     */
    data class Unknown(val message: String) : SendOutcome()

    val isOk: Boolean get() = this is Ok
    val isRetryable: Boolean get() = this is ConnectFailed
    val message: String
        get() = when (this) {
            is Ok -> "ok"
            is ConnectFailed -> message
            is WriteFailed -> message
            is Unknown -> message
        }
}
