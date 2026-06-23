package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder

object VoidKotRenderer {

    fun render(input: VoidKotInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        b.align("center").invert(true).size("xlarge").bold(true)
        b.line("  V O I D  ")
        b.bold(false).size("normal").invert(false)
        b.rule(pw, "=")

        b.align("left").bold(true).line(input.referenceNumber).bold(false)
        input.stationName?.let { b.row("Station", it, pw) }
        input.tableName?.let { b.row("Table", it, pw) }
        input.serverName?.let { b.row("Server", it, pw) }
        input.authorisedBy?.let { b.row("Authorised", it, pw) }
        val voidedValue = "${input.voidDate?.let { "$it " } ?: ""}${input.voidTime}"
        b.row("Voided", voidedValue, pw)

        b.rule(pw)
        b.bold(true).line("PULL THESE ITEMS:").bold(false)
        for (item in input.items) {
            b.size("large").bold(true).line("${item.quantity} x ${item.name}").bold(false).size("normal")
            item.modifiers?.forEach { b.line("  + ${it.name}") }
        }

        input.reason?.let {
            b.rule(pw)
            b.bold(true).line("Reason:").bold(false)
            b.line(it)
        }

        b.rule(pw, "=")
        b.align("center").size("small")
            .line("─────────────────────")
            .line("Powered by Kliovo Dine").size("normal")

        return b.feed(2).cut(false).build()
    }
}
