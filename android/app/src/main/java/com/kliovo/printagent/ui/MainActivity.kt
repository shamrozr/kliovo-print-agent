package com.kliovo.printagent.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.config.PrinterEntry
import com.kliovo.printagent.health.HealthTracker
import com.kliovo.printagent.service.PrintAgentService
import com.kliovo.printagent.transport.BlePrinterSender
import com.kliovo.printagent.transport.BluetoothPrinterSender
import com.kliovo.printagent.transport.Deliver
import com.kliovo.printagent.transport.PairedDevice
import com.kliovo.printagent.ui.theme.KliovoTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { KliovoTheme { AgentScreen() } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgentScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val config = remember { ConfigStore(context) }

    var serverUrl by remember { mutableStateOf(config.serverUrl) }
    var printers by remember { mutableStateOf(config.printers) }
    var editing by remember { mutableStateOf<PrinterEntry?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    val health by HealthTracker.perPrinter.collectAsState()

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* the picker re-reads state itself */ }

    fun requestBluetoothPermission() {
        val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        } else {
            // Below 31 a BLE scan counts as a location fix, and without it the
            // scan returns an empty list with no error — which reads as "no
            // printers exist".
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        permissionLauncher.launch(needed)
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Kliovo Print Agent") }) }
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Server", fontWeight = FontWeight.SemiBold)
                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        label = { Text("Dine address") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            config.serverUrl = serverUrl
                            serverUrl = config.serverUrl
                            PrintAgentService.start(context)
                            message = "Agent started"
                        }) { Text("Save & start") }
                        OutlinedButton(onClick = {
                            PrintAgentService.stop(context)
                            message = "Agent stopped"
                        }) { Text("Stop") }
                    }
                    // Without this the OEM battery manager kills the service
                    // overnight and the printer is silent when the shop opens.
                    TextButton(onClick = {
                        runCatching {
                            context.startActivity(
                                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                            )
                        }
                    }) { Text("Keep running in the background…") }
                }
            }

            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Printers", fontWeight = FontWeight.SemiBold)
                        Button(onClick = {
                            editing = PrinterEntry(
                                printerId = "", agentKey = "", name = "", connection = "bluetooth"
                            )
                        }) { Text("Add") }
                    }
                    if (printers.isEmpty()) {
                        Text(
                            "No printers yet. Add one with its ID and key from Dine → Settings → Printers.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    printers.forEach { p ->
                        val h = health[p.printerId]
                        ListItem(
                            headlineContent = { Text(p.name.ifBlank { p.printerId }) },
                            supportingContent = {
                                Text(
                                    buildString {
                                        append(if (p.isBluetooth) "Bluetooth · ${p.bluetoothAddress ?: "not selected"}" else "Network · ${p.host}:${p.port}")
                                        h?.lastError?.let { append("\nLast error: $it") }
                                    },
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            },
                            trailingContent = {
                                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    TextButton(onClick = {
                                        scope.launch {
                                            val outcome = Deliver.deliver(context, p, testTicket())
                                            message = if (outcome.isOk) {
                                                val via = BluetoothPrinterSender.lastConnectMethod
                                                "Test sent to ${p.name}" + if (p.isBluetooth && via != null) " (connected: $via)" else ""
                                            } else outcome.message
                                        }
                                    }) { Text("Test") }
                                    TextButton(onClick = { editing = p }) { Text("Edit") }
                                }
                            },
                        )
                        Divider()
                    }
                }
            }

            message?.let {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                    Text(it, Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    editing?.let { entry ->
        PrinterEditor(
            initial = entry,
            onRequestPermission = { requestBluetoothPermission() },
            onDismiss = { editing = null },
            onDelete = {
                config.removePrinter(entry.printerId)
                printers = config.printers
                editing = null
                PrintAgentService.start(context)
            },
            onSave = { saved ->
                config.upsertPrinter(saved)
                printers = config.printers
                editing = null
                // Restart so the new printer's poll loop starts immediately —
                // a printer that only works after a manual restart reads as
                // broken to whoever added it.
                PrintAgentService.start(context)
            },
        )
    }
}

/**
 * A tiny ESC/POS ticket built here on purpose — this is the ONE place the agent
 * emits bytes it made itself, and it is a hardware check, not a document. Real
 * tickets are always rendered by the server so the two platforms cannot drift.
 */
private fun testTicket(): ByteArray {
    val init = byteArrayOf(0x1B, 0x40)                       // ESC @
    val center = byteArrayOf(0x1B, 0x61, 0x01)               // ESC a 1
    val doubleOn = byteArrayOf(0x1D, 0x21, 0x11)             // GS ! double w+h
    val doubleOff = byteArrayOf(0x1D, 0x21, 0x00)
    val left = byteArrayOf(0x1B, 0x61, 0x00)
    // Feed past the tear bar BEFORE cutting. Without the feed a cutter-less
    // printer leaves the text inside the mechanism, which reads as "nothing
    // printed" even when every byte arrived.
    val feed = byteArrayOf(0x1B, 0x64, 0x04)                 // ESC d 4
    val cut = byteArrayOf(0x1D, 0x56, 0x00)                  // GS V 0 (ignored if no cutter)
    return init + center + doubleOn +
        "KLIOVO\n".toByteArray(Charsets.US_ASCII) + doubleOff +
        "Print agent test\n".toByteArray(Charsets.US_ASCII) + left +
        "--------------------------------\nIf you can read this, the printer\nis connected correctly.\n".toByteArray(Charsets.US_ASCII) +
        feed + cut
}

@Composable
private fun PrinterEditor(
    initial: PrinterEntry,
    onRequestPermission: () -> Unit,
    onDismiss: () -> Unit,
    onDelete: () -> Unit,
    onSave: (PrinterEntry) -> Unit,
) {
    val context = LocalContext.current
    var name by remember { mutableStateOf(initial.name) }
    var printerId by remember { mutableStateOf(initial.printerId) }
    var agentKey by remember { mutableStateOf(initial.agentKey) }
    var isBluetooth by remember { mutableStateOf(initial.isBluetooth) }
    var isBleDevice by remember { mutableStateOf(initial.isBle) }
    var address by remember { mutableStateOf(initial.bluetoothAddress.orEmpty()) }
    var host by remember { mutableStateOf(initial.host.orEmpty()) }
    var port by remember { mutableStateOf(initial.port.toString()) }
    // Paired (Classic) and nearby (BLE) are ONE list to the operator. They have
    // no way to know which radio their printer speaks, and the common complaint
    // — "it never shows up in Android's Bluetooth settings" — is precisely a
    // BLE printer, which cannot be paired at all and is only ever found by
    // scanning. A picker that showed only paired devices could never list it.
    var paired by remember { mutableStateOf<List<PairedDevice>>(emptyList()) }
    var nearby by remember { mutableStateOf<List<PairedDevice>>(emptyList()) }
    var scanning by remember { mutableStateOf(false) }
    var pickerNote by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun refreshPaired() {
        when {
            !BluetoothPrinterSender.hasPermission(context) -> {
                pickerNote = "Allow Bluetooth access to see printers."
                onRequestPermission()
            }
            !BluetoothPrinterSender.isEnabled(context) -> pickerNote = "Bluetooth is off — turn it on, then refresh."
            else -> {
                paired = BluetoothPrinterSender.listPairedDevices(context)
                pickerNote = null
            }
        }
    }

    fun scanNearby() {
        if (scanning) return
        if (!BlePrinterSender.hasPermissions(context)) {
            pickerNote = "Allow Bluetooth access to scan for printers."
            onRequestPermission()
            return
        }
        if (!BluetoothPrinterSender.isEnabled(context)) {
            pickerNote = "Bluetooth is off — turn it on, then scan."
            return
        }
        scanning = true
        pickerNote = "Scanning for nearby printers…"
        scope.launch {
            nearby = BlePrinterSender.scan(context)
            scanning = false
            pickerNote = if (paired.isEmpty() && nearby.isEmpty())
                "Nothing found. Switch the printer on and hold it close, then scan again."
            else null
        }
    }

    LaunchedEffect(isBluetooth) {
        if (isBluetooth) {
            refreshPaired()
            // Scan straight away: a BLE printer is invisible until we do, and
            // making the operator find a second button first is how they
            // conclude the app cannot see their printer.
            scanNearby()
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial.printerId.isBlank()) "Add printer" else "Edit printer") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true)
                OutlinedTextField(
                    printerId, { printerId = it },
                    label = { Text("Printer ID (from Dine)") }, singleLine = true,
                )
                OutlinedTextField(
                    agentKey, { agentKey = it },
                    label = { Text("Agent key (from Dine)") }, singleLine = true,
                )

                Row(verticalAlignment = Alignment.CenterVertically) {
                    FilterChip(selected = isBluetooth, onClick = { isBluetooth = true }, label = { Text("Bluetooth") })
                    Spacer(Modifier.width(8.dp))
                    FilterChip(selected = !isBluetooth, onClick = { isBluetooth = false }, label = { Text("Network") })
                }

                if (isBluetooth) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Printers", style = MaterialTheme.typography.labelLarge)
                        TextButton(enabled = !scanning, onClick = { refreshPaired(); scanNearby() }) {
                            Text(if (scanning) "Scanning…" else "Scan")
                        }
                    }
                    pickerNote?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

                    val pairedAddresses = paired.map { it.address.uppercase() }.toSet()
                    val rows = paired.map { it to "Paired" } +
                        nearby.filter { it.address.uppercase() !in pairedAddresses }.map { it to "Nearby" }

                    rows.forEach { (device, kind) ->
                        ListItem(
                            headlineContent = { Text(device.name) },
                            supportingContent = {
                                Text("$kind · ${device.address}", style = MaterialTheme.typography.bodySmall)
                            },
                            trailingContent = {
                                RadioButton(
                                    selected = address.equals(device.address, ignoreCase = true),
                                    onClick = {
                                        address = device.address
                                        if (name.isBlank()) name = device.name
                                        // Remember which radio found it, so the
                                        // send path does not have to re-derive
                                        // it against a printer that is switched
                                        // off at the time.
                                        isBleDevice = kind == "Nearby"
                                    },
                                )
                            },
                        )
                    }
                    OutlinedTextField(
                        address, { address = it },
                        label = { Text("Bluetooth address") }, singleLine = true,
                    )
                } else {
                    OutlinedTextField(host, { host = it }, label = { Text("IP address") }, singleLine = true)
                    OutlinedTextField(
                        port, { port = it.filter(Char::isDigit) },
                        label = { Text("Port") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = printerId.isNotBlank() && agentKey.isNotBlank() &&
                    (if (isBluetooth) address.isNotBlank() else host.isNotBlank()),
                onClick = {
                    onSave(
                        initial.copy(
                            printerId = printerId.trim(),
                            agentKey = agentKey.trim(),
                            name = name.trim().ifBlank { printerId.trim() },
                            connection = if (!isBluetooth) "network" else if (isBleDevice) "ble" else "bluetooth",
                            bluetoothAddress = address.trim().ifBlank { null },
                            host = host.trim().ifBlank { null },
                            port = port.toIntOrNull() ?: 9100,
                        )
                    )
                },
            ) { Text("Save") }
        },
        dismissButton = {
            Row {
                if (initial.printerId.isNotBlank()) {
                    TextButton(onClick = onDelete) { Text("Delete") }
                }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}
