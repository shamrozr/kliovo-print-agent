package com.kliovo.printagent.transport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Raw ESC/POS over TCP 9100 — network printers.
 *
 * The pre/post-connect split is the whole point: `connected` flips only after
 * connect() returns, so a failure before it is provably a zero-byte failure and
 * safe to retry, while anything after it is not. Same contract as the desktop
 * agent's tcp-sender.ts.
 */
object TcpPrinterSender {

    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val WRITE_TIMEOUT_MS = 20_000

    suspend fun send(host: String, port: Int, bytes: ByteArray): SendOutcome =
        withContext(Dispatchers.IO) {
            if (host.isBlank()) return@withContext SendOutcome.ConnectFailed("No host configured")
            var connected = false
            var socket: Socket? = null
            try {
                socket = Socket()
                socket.soTimeout = WRITE_TIMEOUT_MS
                socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
                connected = true
                socket.getOutputStream().use { out ->
                    out.write(bytes)
                    out.flush()
                }
                SendOutcome.Ok
            } catch (e: Exception) {
                val reason = e.message ?: e.javaClass.simpleName
                if (!connected) SendOutcome.ConnectFailed("TCP connect failed to $host:$port — $reason")
                else SendOutcome.WriteFailed("Write failed to $host:$port — $reason")
            } finally {
                runCatching { socket?.close() }
            }
        }
}
