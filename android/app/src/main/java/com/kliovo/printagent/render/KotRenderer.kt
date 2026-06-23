package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder

object KotRenderer {

    fun render(input: KotInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        if (input.isRecall) {
            b.align("center").invert(true).size("large").bold(true)
                .line(" * * RECALL * * ").bold(false).size("normal").invert(false)
        }
        if (input.isUrgent) {
            b.align("center").invert(true).bold(true)
                .line(" URGENT ${input.urgencyLabel ?: ""} ").bold(false).invert(false)
        }

        b.align("center").size("xlarge").bold(true)
        val emoji = if (input.stationEmoji != null) "${input.stationEmoji} " else ""
        b.line("$emoji${input.stationName.uppercase()}")
        b.bold(false).size("normal").rule(pw, "=")

        b.align("left")
        b.size("large").bold(true).line(input.referenceNumber).bold(false).size("normal")
        input.tableName?.let { b.row("Table", it, pw) }
        input.guestName?.let { b.row("Guest", it, pw) }
        input.serverName?.let { b.row("Server", it, pw) }
        input.orderType?.let { b.row("Type", it.uppercase(), pw) }
        val firedValue = "${input.fireDate?.let { "$it " } ?: ""}${input.fireTime}"
        b.row("Fired", firedValue, pw)

        b.rule(pw)

        for (item in input.items) {
            b.size("large").bold(true)
            b.line("${item.quantity} x ${item.name}")
            b.bold(false).size("normal")
            item.nameAlt?.let { b.line("  $it") }
            item.course?.let { b.line("  [$it]") }
            item.modifiers?.forEach { b.line("  + ${it.name}") }
            item.notes?.let { b.bold(true).line("  ! $it").bold(false) }
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
