package com.kliovo.printagent.transport

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** A printer the tablet is already paired with. */
data class PairedDevice(val address: String, val name: String)

/**
 * Classic Bluetooth (RFCOMM/SPP) transport for 58mm/80mm ESC/POS printers.
 *
 * Ported from spikes/02-bluetooth-escpos, minus the Capacitor wrapper. Four
 * things here are load-bearing and were reasoned about before any code:
 *
 * 1. **Bonded devices only.** Printers are paired in Android's own Bluetooth
 *    settings, exactly as every cheap POS app does it. That keeps us off the
 *    BLE-style discovery flow and its heavier SCAN permission dance.
 *
 * 2. **Our own connect timeout.** BluetoothSocket#connect() takes no timeout
 *    and can hang indefinitely on some stacks. Cancelling the coroutine does
 *    NOT unblock it — closing the socket does, which is why the timeout branch
 *    closes explicitly.
 *
 * 3. **Chunked writes with a delay.** Cheap boards carry a tiny receive buffer
 *    behind a slow serial-to-Bluetooth bridge, and when overrun they drop
 *    trailing bytes SILENTLY rather than throwing. The chunk size and delay are
 *    app-level back-pressure, and they are heuristics — hence the per-printer
 *    overrides.
 *
 * 4. **One mutex per device.** A KOT and a receipt fired milliseconds apart
 *    must queue, not interleave; two writers on one printer produce garbage on
 *    the tape.
 */
object BluetoothPrinterSender {

    /** Serial Port Profile — every classic-BT ESC/POS printer speaks this. */
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    const val DEFAULT_CHUNK_SIZE_BYTES = 244
    const val DEFAULT_INTER_CHUNK_DELAY_MS = 20L
    private const val CONNECT_TIMEOUT_MS = 8_000L
    private const val WRITE_TIMEOUT_MS = 20_000L

    /**
     * How long to wait after the final byte before closing the socket. Closing
     * discards anything still buffered in the radio, so without this a short
     * ticket can be written "successfully" and never reach paper.
     */
    private const val CLOSE_SETTLE_MS = 400L

    private class OpenedSocket(val socket: BluetoothSocket?, val error: String?, val method: String?)

    /**
     * Which rung of the ladder last worked, for the settings screen. On site,
     * "it connects but only the insecure way" is the single most useful fact
     * about a printer, and it is invisible from anywhere else.
     */
    @Volatile
    var lastConnectMethod: String? = null
        private set

    /**
     * Open an RFCOMM channel, trying the three ways real printers actually
     * accept, in order. Every cheap-printer app on the store does some version
     * of this ladder, and skipping it is why a printer that works everywhere
     * else fails here:
     *
     *  1. **Secure SPP** — correct, and what a well-behaved printer wants.
     *  2. **Insecure SPP** — many cheap boards implement no SSP/pairing dance
     *     and refuse the secure channel outright ("read failed, socket might
     *     closed or timeout, read ret: -1"). This is the most common fix.
     *  3. **Reflected `createRfcommSocket(1)`** — the last-resort hack for
     *     firmware whose SDP record is missing or wrong, so neither UUID lookup
     *     resolves. Channel 1 is where these boards always sit.
     *
     * Every rung is PRE-connect, so falling through them cannot double-print:
     * a rung that fails wrote nothing by definition.
     */
    @SuppressLint("MissingPermission")
    private fun openSocket(device: BluetoothDevice, address: String): OpenedSocket {
        val failures = mutableListOf<String>()

        val attempts: List<Pair<String, () -> BluetoothSocket>> = listOf(
            "secure" to { device.createRfcommSocketToServiceRecord(SPP_UUID) },
            "insecure" to { device.createInsecureRfcommSocketToServiceRecord(SPP_UUID) },
            "channel1" to {
                val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                m.invoke(device, 1) as BluetoothSocket
            },
        )

        for ((name, open) in attempts) {
            var candidate: BluetoothSocket? = null
            try {
                candidate = open()
                candidate.connect()
                lastConnectMethod = name
                return OpenedSocket(candidate, null, name)
            } catch (e: Exception) {
                runCatching { candidate?.close() }
                failures += "$name: ${e.message ?: e.javaClass.simpleName}"
            }
        }
        return OpenedSocket(null, "Bluetooth connect failed to $address — ${failures.joinToString(" | ")}", null)
    }

    private val deviceLocks = ConcurrentHashMap<String, Mutex>()
    private fun lockFor(address: String): Mutex = deviceLocks.computeIfAbsent(address) { Mutex() }

    /** The runtime permission that actually gates us, per API level. */
    fun requiredPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Manifest.permission.BLUETOOTH_CONNECT
        // Below 31 any Bluetooth enumeration is treated by AOSP as location.
        else Manifest.permission.ACCESS_FINE_LOCATION

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, requiredPermission()) == PackageManager.PERMISSION_GRANTED

    private fun adapter(context: Context): BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    fun isEnabled(context: Context): Boolean = adapter(context)?.isEnabled == true

    /**
     * Printers this tablet is paired with, for the settings picker. Returns an
     * empty list rather than throwing when Bluetooth is off or the permission
     * is missing — the caller decides how to explain it, and the picker must
     * never crash the settings screen.
     */
    @SuppressLint("MissingPermission") // guarded by hasPermission()
    fun listPairedDevices(context: Context): List<PairedDevice> {
        if (!hasPermission(context)) return emptyList()
        val adapter = adapter(context) ?: return emptyList()
        if (!adapter.isEnabled) return emptyList()
        return runCatching {
            adapter.bondedDevices.orEmpty().map { device: BluetoothDevice ->
                PairedDevice(address = device.address, name = device.name ?: device.address)
            }.sortedBy { it.name.lowercase() }
        }.getOrDefault(emptyList())
    }

    @SuppressLint("MissingPermission")
    suspend fun send(
        context: Context,
        address: String,
        bytes: ByteArray,
        chunkSizeBytes: Int = DEFAULT_CHUNK_SIZE_BYTES,
        interChunkDelayMs: Long = DEFAULT_INTER_CHUNK_DELAY_MS,
    ): SendOutcome = withContext(Dispatchers.IO) {
        if (address.isBlank()) return@withContext SendOutcome.ConnectFailed("No Bluetooth printer selected")
        if (!hasPermission(context)) {
            return@withContext SendOutcome.ConnectFailed("Bluetooth permission not granted")
        }
        val adapter = adapter(context)
            ?: return@withContext SendOutcome.ConnectFailed("This device has no Bluetooth adapter")
        if (!adapter.isEnabled) return@withContext SendOutcome.ConnectFailed("Bluetooth is turned off")

        val device = runCatching { adapter.getRemoteDevice(address) }.getOrElse {
            return@withContext SendOutcome.ConnectFailed("Invalid Bluetooth address: $address")
        }

        lockFor(address).withLock {
            var socket: BluetoothSocket? = null
            // Flips true only once connect() returns. Everything after that
            // point may have put bytes on the wire.
            var connected = false
            try {
                // An in-progress system discovery starves connect(); we never
                // scan ourselves, but something else on the tablet might.
                runCatching { adapter.cancelDiscovery() }

                val opened = openSocket(device, address)
                socket = opened.socket
                if (socket == null) {
                    return@withLock SendOutcome.ConnectFailed(opened.error ?: "Bluetooth connect failed to $address")
                }
                connected = true

                val out: OutputStream = socket.outputStream
                val chunk = if (chunkSizeBytes > 0) chunkSizeBytes else DEFAULT_CHUNK_SIZE_BYTES
                var offset = 0
                while (offset < bytes.size) {
                    val end = minOf(offset + chunk, bytes.size)
                    try {
                        withTimeout(WRITE_TIMEOUT_MS) {
                            out.write(bytes, offset, end - offset)
                            out.flush()
                        }
                    } catch (e: Exception) {
                        val reason = e.message ?: e.javaClass.simpleName
                        return@withLock SendOutcome.WriteFailed(
                            "Write failed after $offset/${bytes.size} bytes to $address — $reason"
                        )
                    }
                    offset = end
                    if (offset < bytes.size && interChunkDelayMs > 0) delay(interChunkDelayMs)
                }
                // Let the last chunk drain before the socket closes. Closing an
                // RFCOMM socket discards whatever the radio has not yet pushed,
                // and on a slow bridge chip that is the tail of the ticket — or,
                // for a short one, the WHOLE ticket. This is why a job can look
                // perfectly successful here and produce no paper at all.
                delay(CLOSE_SETTLE_MS)
                SendOutcome.Ok
            } catch (e: Exception) {
                val reason = e.message ?: e.javaClass.simpleName
                if (!connected) SendOutcome.ConnectFailed("Unexpected pre-connect failure to $address — $reason")
                else SendOutcome.Unknown("Unexpected post-connect failure to $address — $reason")
            } finally {
                runCatching { socket?.close() } as? IOException
            }
        }
    }
}
