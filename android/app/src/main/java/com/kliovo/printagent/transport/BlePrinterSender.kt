package com.kliovo.printagent.transport

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * BLE (GATT) transport for thermal printers.
 *
 * WHY THIS EXISTS: a large share of cheap 58mm printers are BLE-only. They never
 * appear in Android's Bluetooth settings and cannot be paired there, so
 * `getBondedDevices()` — the whole basis of the Classic transport — returns
 * nothing for them and RFCOMM has no channel to open. That is exactly why every
 * third-party printer app scans for printers inside its own UI: with BLE there
 * is nothing to pair, only something to find.
 *
 * The write path is deliberately conservative, because BLE gives far less back
 * than a socket does:
 *
 *  - **Characteristic discovery is by property, not by a UUID whitelist.** These
 *    printers use at least four different service/characteristic pairs
 *    (18F0/2AF1, FFE0/FFE1, FF00/FF02, and vendor-specific ones). Known pairs are
 *    preferred, then ANY writable characteristic — a whitelist alone would fail
 *    on the next unbranded board.
 *  - **MTU is negotiated, then respected.** The default ATT payload is 20 bytes;
 *    writing more silently truncates. We ask for 512 and chunk to whatever we
 *    actually get, minus the 3-byte ATT header.
 *  - **Write-with-response is preferred when offered**, because its completion
 *    callback is real back-pressure. Without it we pace by delay, the same
 *    app-level back-pressure the Classic path uses for the same reason.
 */
object BlePrinterSender {

    /** Service/characteristic pairs common to cheap ESC/POS BLE boards. */
    private val KNOWN_WRITE_CHARACTERISTICS = listOf(
        UUID.fromString("0000ff02-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("00002af1-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("0000ffe1-0000-1000-8000-00805f9b34fb"),
        UUID.fromString("0000ffe3-0000-1000-8000-00805f9b34fb"),
    )

    private const val CONNECT_TIMEOUT_MS = 12_000L
    private const val DISCOVER_TIMEOUT_MS = 10_000L
    private const val WRITE_ACK_TIMEOUT_MS = 5_000L
    private const val SCAN_MS = 8_000L
    private const val DEFAULT_MTU = 23          // ATT default; 20 bytes of payload
    private const val ATT_HEADER = 3
    private const val NO_RESPONSE_PACING_MS = 18L

    /** Same rule as the Classic path: one writer per device at a time. */
    private val deviceLocks = ConcurrentHashMap<String, Mutex>()
    private fun lockFor(address: String): Mutex = deviceLocks.computeIfAbsent(address) { Mutex() }

    fun requiredPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            // Below 31 a BLE scan is treated by AOSP as a location fix.
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    fun hasPermissions(context: Context): Boolean = requiredPermissions().all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

    private fun adapter(context: Context) =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    /**
     * Find nearby BLE printers. There is no paired list to read — a BLE printer
     * is only ever discovered by scanning, which is the whole reason this exists.
     * Unnamed devices are dropped: an operator cannot pick "C4:2B:19:…" out of a
     * list of every fitness band in the building.
     */
    @SuppressLint("MissingPermission")
    suspend fun scan(context: Context, timeoutMs: Long = SCAN_MS): List<PairedDevice> =
        withContext(Dispatchers.IO) {
            if (!hasPermissions(context)) return@withContext emptyList()
            val scanner = adapter(context)?.takeIf { it.isEnabled }?.bluetoothLeScanner
                ?: return@withContext emptyList()

            val found = LinkedHashMap<String, PairedDevice>()
            val cb = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    val name = result.device?.name ?: result.scanRecord?.deviceName
                    val address = result.device?.address ?: return
                    if (!name.isNullOrBlank()) found.putIfAbsent(address, PairedDevice(address, name))
                }
            }
            val settings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
            runCatching { scanner.startScan(null, settings, cb) }
                .onFailure { return@withContext emptyList() }
            delay(timeoutMs)
            runCatching { scanner.stopScan(cb) }
            found.values.toList()
        }

    @SuppressLint("MissingPermission")
    suspend fun send(context: Context, address: String, bytes: ByteArray): SendOutcome =
        withContext(Dispatchers.IO) {
            if (!hasPermissions(context)) {
                return@withContext SendOutcome.ConnectFailed("Bluetooth permission not granted")
            }
            val adapter = adapter(context)
                ?: return@withContext SendOutcome.ConnectFailed("This device has no Bluetooth adapter")
            if (!adapter.isEnabled) return@withContext SendOutcome.ConnectFailed("Bluetooth is turned off")
            val device: BluetoothDevice = runCatching { adapter.getRemoteDevice(address) }.getOrElse {
                return@withContext SendOutcome.ConnectFailed("Invalid Bluetooth address: $address")
            }

            lockFor(address).withLock { writeOverGatt(context, device, address, bytes) }
        }

    @SuppressLint("MissingPermission")
    private suspend fun writeOverGatt(
        context: Context,
        device: BluetoothDevice,
        address: String,
        bytes: ByteArray,
    ): SendOutcome {
        val connected = CompletableDeferred<Boolean>()
        val discovered = CompletableDeferred<Boolean>()
        val mtuSettled = CompletableDeferred<Int>()
        @Volatile var writeAck: CompletableDeferred<Boolean>? = null
        var gatt: BluetoothGatt? = null
        // Only flips once a byte has actually been handed to the stack — the
        // same pre/post boundary the Classic and TCP transports use to decide
        // whether a retry could double-print.
        var wroteAnything = false

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    if (!connected.isCompleted) connected.complete(true)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    if (!connected.isCompleted) connected.complete(false)
                    if (!discovered.isCompleted) discovered.complete(false)
                }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                if (!discovered.isCompleted) discovered.complete(status == BluetoothGatt.GATT_SUCCESS)
            }

            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                if (!mtuSettled.isCompleted) {
                    mtuSettled.complete(if (status == BluetoothGatt.GATT_SUCCESS) mtu else DEFAULT_MTU)
                }
            }

            override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                writeAck?.takeIf { !it.isCompleted }?.complete(status == BluetoothGatt.GATT_SUCCESS)
            }
        }

        try {
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
                ?: return SendOutcome.ConnectFailed("Could not open a BLE connection to $address")

            if (withTimeoutOrNull(CONNECT_TIMEOUT_MS) { connected.await() } != true) {
                return SendOutcome.ConnectFailed("BLE connect timed out for $address")
            }
            if (!gatt.discoverServices()) {
                return SendOutcome.ConnectFailed("BLE service discovery could not be started for $address")
            }
            if (withTimeoutOrNull(DISCOVER_TIMEOUT_MS) { discovered.await() } != true) {
                return SendOutcome.ConnectFailed("BLE service discovery failed for $address")
            }

            val target = pickWriteCharacteristic(gatt)
                ?: return SendOutcome.ConnectFailed(
                    "No writable characteristic on $address — this device does not look like a BLE printer"
                )

            // Ask for a bigger payload; 20 bytes a packet makes a receipt crawl.
            runCatching { gatt.requestMtu(512) }
            val mtu = withTimeoutOrNull(3_000L) { mtuSettled.await() } ?: DEFAULT_MTU
            val chunkSize = (mtu - ATT_HEADER).coerceIn(20, 509)

            val withResponse = target.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0
            target.writeType =
                if (withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE

            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(offset + chunkSize, bytes.size)
                val slice = bytes.copyOfRange(offset, end)
                val ack = CompletableDeferred<Boolean>()
                writeAck = ack

                val queued = writeChunk(gatt, target, slice)
                if (!queued) {
                    return if (wroteAnything) {
                        SendOutcome.WriteFailed("BLE write rejected after $offset/${bytes.size} bytes")
                    } else {
                        SendOutcome.ConnectFailed("BLE write could not be queued for $address")
                    }
                }
                wroteAnything = true

                if (withResponse) {
                    // A real completion callback is real back-pressure — far
                    // better than guessing a delay.
                    if (withTimeoutOrNull(WRITE_ACK_TIMEOUT_MS) { ack.await() } != true) {
                        return SendOutcome.WriteFailed("BLE write stalled after $offset/${bytes.size} bytes")
                    }
                } else {
                    // No callback exists for write-without-response, so pace it.
                    delay(NO_RESPONSE_PACING_MS)
                }
                offset = end
            }

            // Same reason as the Classic path: tearing the link down while the
            // controller still holds bytes loses the tail of the ticket, or a
            // short ticket entirely.
            delay(600)
            return SendOutcome.Ok
        } catch (e: Exception) {
            val reason = e.message ?: e.javaClass.simpleName
            return if (wroteAnything) SendOutcome.Unknown("BLE failure after partial write to $address — $reason")
            else SendOutcome.ConnectFailed("BLE failure before any write to $address — $reason")
        } finally {
            runCatching { gatt?.disconnect() }
            runCatching { gatt?.close() }
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun writeChunk(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        slice: ByteArray,
    ): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeCharacteristic(characteristic, slice, characteristic.writeType) ==
                BluetoothGatt.GATT_SUCCESS
        } else {
            characteristic.value = slice
            gatt.writeCharacteristic(characteristic)
        }

    /**
     * Known printer characteristics first, then any writable one. The whitelist
     * alone is not enough — these boards are unbranded and the next one will use
     * a UUID nobody has seen — and "any writable" alone would pick a config
     * characteristic on a device that happens to expose one.
     */
    private fun pickWriteCharacteristic(gatt: BluetoothGatt): BluetoothGattCharacteristic? {
        val writable = gatt.services.orEmpty()
            .flatMap { it.characteristics.orEmpty() }
            .filter {
                it.properties and (BluetoothGattCharacteristic.PROPERTY_WRITE or
                    BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
            }
        return writable.firstOrNull { it.uuid in KNOWN_WRITE_CHARACTERISTICS } ?: writable.firstOrNull()
    }
}
