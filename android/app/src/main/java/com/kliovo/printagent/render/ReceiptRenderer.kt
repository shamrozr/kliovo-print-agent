package com.kliovo.printagent.render

import com.kliovo.printagent.escpos.CP1256
import com.kliovo.printagent.escpos.ESCPOSBuilder
import com.kliovo.printagent.escpos.FormatPaisa

object ReceiptRenderer {

    private fun formatMoney(paisa: Long): String = FormatPaisa.format(paisa)

    fun render(input: ReceiptInput): ByteArray {
        val pw = if (input.paperWidth == 58) 58 else 80
        val width = if (pw == 80) 48 else 32

        val lc = input.layoutConfig
        val headerStyle = lc?.header
        val footerStyle = lc?.footer

        val b = ESCPOSBuilder().init().codePage(CP1256.CODE_PAGE)

        if (input.header.rasterLogo != null) {
            val logo = input.header.rasterLogo
            b.align("center").rasterImage(logo.bytes, logo.widthBytes, logo.heightDots).newline()
        }

        b.align(headerStyle?.align ?: "center")
        b.size(headerStyle?.nameSize ?: "large").bold(headerStyle?.bold ?: true)
            .line(input.header.tenantName).bold(false).size("normal")

        input.header.branchName?.let { b.line(it) }
        input.header.addressLines?.forEach { b.line(it) }
        input.header.phone?.let { b.line(it) }
        input.header.taxLines?.forEach { b.line(it) }

        b.rule(pw, "=").align("left")

        b.bold(true).line(input.referenceNumber).bold(false)
        b.row(input.date, input.time, pw)
        b.row("Type", input.orderType.uppercase(), pw)
        input.tableName?.let { b.row("Table", it, pw) }
        input.serverName?.let { b.row("Server", it, pw) }
        input.covers?.let { b.row("Covers", it.toString(), pw) }
        input.customer?.name?.let { b.row("Customer", it, pw) }
        input.customer?.phone?.let { b.row("Phone", it, pw) }
        input.deliveryAddress?.let { addr ->
            b.line("Address:")
            wrap(addr, width).forEach { b.line("  $it") }
        }
        input.specialRequests?.let { req ->
            b.line("Notes:")
            wrap(req, width).forEach { b.line("  $it") }
        }

        b.rule(pw)

        for (item in input.items) {
            val left = "${item.quantity} x ${item.name}"
            val right = formatMoney(item.totalPricePaisa)
            b.row(truncate(left, width - right.length - 1), right, pw)
            item.nameAlt?.let { b.line("  $it") }
            item.modifiers?.forEach { mod ->
                val mLeft = "  + ${mod.name}"
                val mRight = if (mod.pricePaisa > 0) formatMoney(mod.pricePaisa) else ""
                if (mRight.isNotEmpty()) b.row(mLeft, mRight, pw) else b.line(mLeft)
            }
            item.notes?.let { notes ->
                wrap(notes, width - 4).forEach { b.line("    $it") }
            }
        }

        b.rule(pw)

        b.row("Subtotal", formatMoney(input.subtotalPaisa), pw)
        input.discounts?.forEach { d ->
            val label = if (d.percentage != null) "${d.label} (${d.percentage}%)" else d.label
            b.row(label, "- ${formatMoney(d.amountPaisa)}", pw)
        }
        input.taxes?.forEach { t ->
            b.row("${t.label} (${t.rate}%)", formatMoney(t.amountPaisa), pw)
        }
        input.serviceChargePaisa?.let { b.row("Service", formatMoney(it), pw) }
        input.tipPaisa?.let { b.row("Tip", formatMoney(it), pw) }

        b.rule(pw, "=")
        b.size("large").bold(true).row("TOTAL", formatMoney(input.totalPaisa), pw).bold(false).size("normal")
        b.rule(pw, "=")

        for (p in input.payments) {
            val label = if (p.reference != null) "${p.method.uppercase()} (${p.reference})" else p.method.uppercase()
            b.row(label, formatMoney(p.amountPaisa), pw)
        }
        if (input.balanceDuePaisa > 0) {
            b.bold(true).row("BALANCE DUE", formatMoney(input.balanceDuePaisa), pw).bold(false)
        } else {
            b.row("PAID", formatMoney(input.paidPaisa), pw)
        }

        input.fbrInvoiceNumber?.let { fbr ->
            b.newline().align("center").bold(true).line("FBR # $fbr").bold(false)
            input.footer?.fbrVerifyUrl?.let { url ->
                b.qr(url, size = 5, ec = "M")
                b.line("Scan to verify with FBR")
            }
        }

        input.footer?.qrLink?.let { b.newline().qr(it, size = 5, ec = "M") }
        val footerLines = footerStyle?.lines ?: input.footer?.lines
        if (!footerLines.isNullOrEmpty()) {
            b.newline()
            for (ln in footerLines) {
                b.align(footerStyle?.align ?: "center").line(ln)
            }
        }
        b.newline().align("center").size("small").line("Powered by Kliovo Dine").size("normal")

        return b.feed(5).cut(true).build()
    }

    private fun wrap(s: String, width: Int): List<String> {
        val out = mutableListOf<String>()
        val words = s.split(Regex("\\s+"))
        var line = ""
        for (w in words) {
            if (("$line $w").trim().length > width) {
                if (line.isNotEmpty()) out.add(line)
                line = w
            } else {
                line = if (line.isEmpty()) w else "$line $w"
            }
        }
        if (line.isNotEmpty()) out.add(line)
        return if (out.isNotEmpty()) out else listOf(s.take(width))
    }

    private fun truncate(s: String, max: Int): String {
        return if (s.length > max) s.take(max - 1) + "…" else s
    }
}
