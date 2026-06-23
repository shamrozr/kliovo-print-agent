package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder

object MasterKotRenderer {

    fun render(input: MasterKotInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        b.align("center").size("xlarge").bold(true).line("MASTER KOT").bold(false).size("normal")
        b.rule(pw, "=")

        b.align("left").size("large").bold(true).line(input.referenceNumber).bold(false).size("normal")
        input.tableName?.let { b.row("Table", it, pw) }
        input.guestName?.let { b.row("Guest", it, pw) }
        input.serverName?.let { b.row("Server", it, pw) }
        input.covers?.let { b.row("Covers", it.toString(), pw) }
        input.orderType?.let { b.row("Type", it.uppercase(), pw) }
        input.courseLabel?.let { b.row("Course", it, pw) }
        val firedValue = "${input.fireDate?.let { "$it " } ?: ""}${input.fireTime}"
        b.row("Fired", firedValue, pw)

        b.rule(pw)

        for (group in input.groups) {
            val emoji = if (group.stationEmoji != null) "${group.stationEmoji} " else ""
            b.bold(true).line("-- $emoji${group.stationName.uppercase()} --").bold(false)
            for (item in group.items) {
                b.size("large").bold(true).line("${item.quantity} x ${item.name}").bold(false).size("normal")
                item.nameAlt?.let { b.line("  $it") }
                item.modifiers?.forEach { b.line("  + ${it.name}") }
                item.notes?.let { b.bold(true).line("  ! $it").bold(false) }
            }
            b.newline()
        }

        b.rule(pw, "=")
        input.version?.takeIf { it > 1 }?.let {
            b.align("center").bold(true).line("** REPRINT v$it **").bold(false)
        }

        b.align("center").size("small")
            .line("─────────────────────")
            .line("Powered by Kliovo Dine").size("normal")

        return b.feed(2).cut(false).build()
    }
}
