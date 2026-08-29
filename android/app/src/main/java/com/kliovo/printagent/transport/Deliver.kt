package com.kliovo.printagent.transport

import android.content.Context
import com.kliovo.printagent.config.PrinterEntry
import kotlinx.coroutines.delay

/**
 * The single point of delivery for rendered ESC/POS bytes — callers never
 * branch on transport themselves. Same role as the desktop agent's deliver.ts.
 */
object Deliver {

    private const val MAX_ATTEMPTS = 3
    private val BACKOFF_MS = longArrayOf(300, 1_000)

    /**
     * Deliver once, retrying ONLY a provably pre-connect failure. A printer
     * that was reachable and then failed mid-write is never retried: those
     * bytes may already be on the tape.
     */
    suspend fun deliver(context: Context, printer: PrinterEntry, bytes: ByteArray): SendOutcome {
        var last: SendOutcome = SendOutcome.ConnectFailed("not attempted")
        for (attempt in 0 until MAX_ATTEMPTS) {
            last = sendOnce(context, printer, bytes)
            if (last.isOk || !last.isRetryable) return last
            if (attempt < BACKOFF_MS.size) delay(BACKOFF_MS[attempt])
        }
        return last
    }

    private suspend fun sendOnce(context: Context, printer: PrinterEntry, bytes: ByteArray): SendOutcome {
        if (!printer.isBluetooth) {
            return TcpPrinterSender.send(printer.host.orEmpty(), printer.port, bytes)
        }
        val address = printer.bluetoothAddress.orEmpty()

        // Which radio? Decided here rather than asked of the operator, who has
        // no way to know and should not have to: a printer that Android could
        // pair with is Classic, and one that could not is BLE. That is exactly
        // the distinction they see as "it never shows up in Bluetooth settings".
        val classic = !printer.isBle && BluetoothPrinterSender.isBonded(context, address)
        if (classic) {
            val outcome = BluetoothPrinterSender.send(
                context = context,
                address = address,
                bytes = bytes,
                chunkSizeBytes = printer.chunkSizeBytes ?: BluetoothPrinterSender.DEFAULT_CHUNK_SIZE_BYTES,
                interChunkDelayMs = printer.interChunkDelayMs ?: BluetoothPrinterSender.DEFAULT_INTER_CHUNK_DELAY_MS,
            )
            // Only a pre-connect failure may fall through to the other radio —
            // past that point bytes may be on the tape and a second attempt
            // prints twice.
            if (outcome.isOk || !outcome.isRetryable) return outcome
        }
        return BlePrinterSender.send(context, address, bytes)
    }
}
