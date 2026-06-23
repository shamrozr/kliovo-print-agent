package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder

object LabelRenderer {

    fun render(input: LabelInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        b.align("center").size("large").bold(true).line(input.referenceNumber).bold(false).size("normal")

        if (input.bagIndex != null && input.bagTotal != null) {
            b.align("center").bold(true).line("Bag ${input.bagIndex} of ${input.bagTotal}").bold(false)
        }

        b.align("center").barcode(input.referenceNumber, type = "CODE128", height = 60, hriPosition = 0)
        b.rule(pw)

        b.align("left")
        input.orderType?.let { b.row("Type", it.uppercase(), pw) }
        input.scheduledFor?.let { b.row("For", it, pw) }
        input.customerName?.let { b.row("Name", it, pw) }
        input.customerPhone?.let { b.row("Phone", it, pw) }
        input.deliveryAddress?.let {
            b.line("Address:")
            b.line(it)
        }
        input.itemSummary?.let {
            b.rule(pw)
            b.line(it)
        }
        input.handlingNote?.let {
            b.bold(true).line("! $it").bold(false)
        }

        return b.feed(1).cut(false).build()
    }
}
