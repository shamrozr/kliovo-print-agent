package com.kliovo.printagent.transport

/**
 * Where in a delivery's lifecycle it failed — the ONLY thing that decides
 * whether a retry is safe.
 *
 * Mirrors the `connected` boundary in the desktop agent's tcp-sender.ts: retry
 * is allowed only when we can PROVE nothing reached the printer. Anything after
 * the connection is established may already be on the tape, and a retry there
 * prints a second ticket.
 *
 * `message` is a constructor property on the base class rather than a computed
 * one, so the subclasses cannot each redeclare it.
 */
sealed class SendOutcome(val message: String) {

    object Ok : SendOutcome("ok")

    /** Provably zero bytes written — the socket never finished connecting. */
    class ConnectFailed(message: String) : SendOutcome(message)

    /** Connected, then failed. Some bytes may have printed. Never retry. */
    class WriteFailed(message: String) : SendOutcome(message)

    /**
     * Unclassifiable. Treated as "may have printed" — never retried — matching
     * the conservative bias of the post-connect branch.
     */
    class Unknown(message: String) : SendOutcome(message)

    val isOk: Boolean get() = this is Ok
    val isRetryable: Boolean get() = this is ConnectFailed
}
