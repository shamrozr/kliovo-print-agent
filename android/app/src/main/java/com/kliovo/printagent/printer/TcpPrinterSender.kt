package com.kliovo.printagent.printer

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

object TcpPrinterSender {

    private const val TIMEOUT_MS = 5000

    fun send(host: String, port: Int, bytes: ByteArray) {
        val socket = Socket()
        try {
            socket.connect(InetSocketAddress(host, port), TIMEOUT_MS)
            socket.soTimeout = TIMEOUT_MS
            socket.getOutputStream().use { out ->
                out.write(bytes)
                out.flush()
            }
        } catch (e: IOException) {
            throw IOException("TCP send to $host:$port failed: ${e.message}", e)
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }
}
