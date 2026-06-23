package com.kliovo.printagent.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kliovo.printagent.config.AgentConfig
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.config.PrinterEntry
import com.kliovo.printagent.health.HealthSnapshot
import com.kliovo.printagent.printer.TcpPrinterSender
import com.kliovo.printagent.service.PrintBridgeService
import com.kliovo.printagent.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : ComponentActivity() {

    private lateinit var configStore: ConfigStore

    private val notifPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configStore = ConfigStore(applicationContext)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        requestBatteryOptimizationExemption()
        startBridgeService()

        setContent {
            KliovoPrintAgentTheme {
                PrintAgentApp(configStore)
            }
        }
    }

    private fun startBridgeService() {
        val intent = Intent(this, PrintBridgeService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun requestBatteryOptimizationExemption() {
        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            try { startActivity(intent) } catch (_: Exception) {}
        }
    }
}

@Composable
fun PrintAgentApp(configStore: ConfigStore) {
    var config by remember { mutableStateOf(configStore.load()) }
    var editingIndex by remember { mutableIntStateOf(-1) }
    var showForm by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    var healthSnapshot by remember { mutableStateOf<HealthSnapshot?>(null) }
    LaunchedEffect(Unit) {
        while (true) {
            healthSnapshot = PrintBridgeService.healthTracker.snapshot()
            delay(2000)
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = KliovoBg
    ) {
        if (showForm) {
            val existing = if (editingIndex >= 0) config.printers[editingIndex] else null
            PrinterFormScreen(
                existing = existing,
                onSave = { entry ->
                    val printers = config.printers.toMutableList()
                    if (editingIndex >= 0) printers[editingIndex] = entry
                    else printers.add(entry)
                    config = config.copy(printers = printers)
                    configStore.save(config)
                    showForm = false
                    editingIndex = -1
                },
                onDelete = if (editingIndex >= 0) {
                    {
                        val printers = config.printers.toMutableList()
                        printers.removeAt(editingIndex)
                        config = config.copy(printers = printers)
                        configStore.save(config)
                        showForm = false
                        editingIndex = -1
                    }
                } else null,
                onCancel = {
                    showForm = false
                    editingIndex = -1
                },
                onTestPrint = { entry ->
                    scope.launch {
                        statusMessage = "Sending test print..."
                        try {
                            val ESC = 0x1B.toByte()
                            val GS = 0x1D.toByte()
                            val bytes = byteArrayOf(
                                ESC, 0x40,
                                ESC, 0x61, 0x01,
                                ESC, 0x21, 0x30
                            ) + "Kliovo\n".toByteArray() + byteArrayOf(
                                ESC, 0x21, 0x00
                            ) + "Test Print\n".toByteArray() +
                                "${entry.host}:${entry.port}\n".toByteArray() +
                                "${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())}\n".toByteArray() +
                                byteArrayOf(GS, 0x56, 0x42, 0x00)

                            TcpPrinterSender.send(entry.host, entry.port, bytes)
                            PrintBridgeService.healthTracker.record(entry.printerId, entry.name, "test", true, null)
                            statusMessage = "Test print sent!"
                        } catch (e: Exception) {
                            PrintBridgeService.healthTracker.record(entry.printerId, entry.name, "test", false, e.message)
                            statusMessage = "Failed: ${e.message}"
                        }
                    }
                },
                statusMessage = statusMessage
            )
        } else {
            HomeScreen(
                config = config,
                healthSnapshot = healthSnapshot,
                onServerUrlChange = { url ->
                    config = config.copy(serverUrl = url)
                    configStore.save(config)
                },
                onAddPrinter = { showForm = true },
                onEditPrinter = { idx ->
                    editingIndex = idx
                    showForm = true
                }
            )
        }
    }
}

@Composable
fun HomeScreen(
    config: AgentConfig,
    healthSnapshot: HealthSnapshot?,
    onServerUrlChange: (String) -> Unit,
    onAddPrinter: () -> Unit,
    onEditPrinter: (Int) -> Unit
) {
    var serverUrl by remember(config.serverUrl) { mutableStateOf(config.serverUrl) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text(
                "Kliovo Print Agent",
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
                color = KliovoDark
            )
            Spacer(Modifier.height(4.dp))
        }

        item {
            Card(
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = KliovoWhite)
            ) {
                Column(Modifier.padding(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val dotColor = when (healthSnapshot?.status) {
                            "green" -> KliovoGreen
                            "yellow" -> KliovoYellow
                            "red" -> KliovoRed
                            else -> KliovoMuted
                        }
                        Box(
                            Modifier
                                .size(10.dp)
                                .clip(CircleShape)
                                .background(dotColor)
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            when (healthSnapshot?.status) {
                                "green" -> "Printing OK"
                                "yellow" -> "Recent print issues"
                                "red" -> "Print FAILING"
                                else -> "Loading..."
                            },
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.sp
                        )
                    }

                    if (healthSnapshot != null && healthSnapshot.recent.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
                        for (evt in healthSnapshot.recent.take(5)) {
                            Text(
                                "${timeFormat.format(Date(evt.ts))}  ${if (evt.ok) "✓" else "✗"} ${evt.kind} → ${evt.printerName}",
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                color = KliovoMuted
                            )
                        }
                    }
                }
            }
        }

        item {
            SectionLabel("Server URL")
            OutlinedTextField(
                value = serverUrl,
                onValueChange = {
                    serverUrl = it
                    onServerUrlChange(it)
                },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                textStyle = LocalTextStyle.current.copy(fontSize = 13.sp),
                shape = RoundedCornerShape(8.dp)
            )
        }

        item { SectionLabel("Printers") }

        if (config.printers.isEmpty()) {
            item {
                Text("No printers configured", color = KliovoMuted, fontSize = 12.sp)
            }
        } else {
            items(config.printers.size) { idx ->
                val p = config.printers[idx]
                Card(
                    onClick = { onEditPrinter(idx) },
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = KliovoWhite)
                ) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(p.name.ifEmpty { p.printerId }, fontWeight = FontWeight.Medium, fontSize = 13.sp)
                            Text("${p.host}:${p.port} • ${p.paperWidth}mm", color = KliovoMuted, fontSize = 11.sp)
                        }
                    }
                }
            }
        }

        item {
            OutlinedButton(
                onClick = onAddPrinter,
                shape = RoundedCornerShape(8.dp)
            ) {
                Text("+ Add Printer", fontSize = 12.sp)
            }
        }
    }
}

@Composable
fun PrinterFormScreen(
    existing: PrinterEntry?,
    onSave: (PrinterEntry) -> Unit,
    onDelete: (() -> Unit)?,
    onCancel: () -> Unit,
    onTestPrint: (PrinterEntry) -> Unit,
    statusMessage: String
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var printerId by remember { mutableStateOf(existing?.printerId ?: "printer-${System.currentTimeMillis() % 10000}") }
    var host by remember { mutableStateOf(existing?.host ?: "") }
    var port by remember { mutableStateOf(existing?.port?.toString() ?: "9100") }
    var paperWidth by remember { mutableIntStateOf(existing?.paperWidth ?: 80) }

    fun buildEntry() = PrinterEntry(
        printerId = printerId,
        host = host,
        port = port.toIntOrNull() ?: 9100,
        name = name,
        paperWidth = paperWidth
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            if (existing != null) "Edit Printer" else "Add Printer",
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )

        FormField("Printer Name", name) { name = it }
        FormField("Printer ID", printerId) { printerId = it }
        FormField("IP Address", host) { host = it }
        FormField("Port", port, KeyboardType.Number) { port = it }

        SectionLabel("Paper Width")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = paperWidth == 80,
                onClick = { paperWidth = 80 },
                label = { Text("80mm") }
            )
            FilterChip(
                selected = paperWidth == 58,
                onClick = { paperWidth = 58 },
                label = { Text("58mm") }
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(8.dp)) {
                Text("Cancel")
            }
            if (host.isNotEmpty()) {
                OutlinedButton(onClick = { onTestPrint(buildEntry()) }, shape = RoundedCornerShape(8.dp)) {
                    Text("Test Print")
                }
            }
            Button(
                onClick = { onSave(buildEntry()) },
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = KliovoGreen)
            ) {
                Text("Save")
            }
        }

        if (onDelete != null) {
            Button(
                onClick = onDelete,
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = KliovoRed)
            ) {
                Text("Delete Printer")
            }
        }

        if (statusMessage.isNotEmpty()) {
            Text(statusMessage, fontSize = 12.sp, color = KliovoMuted)
        }
    }
}

@Composable
fun FormField(label: String, value: String, keyboardType: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
    Column {
        SectionLabel(label)
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontSize = 13.sp),
            shape = RoundedCornerShape(8.dp),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType)
        )
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        color = KliovoMuted,
        letterSpacing = 0.5.sp
    )
}
