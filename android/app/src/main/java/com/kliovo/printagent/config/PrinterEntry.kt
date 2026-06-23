package com.kliovo.printagent.config

data class PrinterEntry(
    val printerId: String,
    val agentKey: String = "",
    val host: String = "",
    val port: Int = 9100,
    val name: String = "",
    val paperWidth: Int = 80
)

data class AgentConfig(
    val serverUrl: String = "https://dine.kliovo.com",
    val printers: List<PrinterEntry> = emptyList()
)
