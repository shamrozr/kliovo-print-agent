package com.kliovo.printagent.escpos

import java.text.NumberFormat
import java.util.Locale

object FormatPaisa {

    private val wholeFormatter = NumberFormat.getIntegerInstance(Locale("en", "PK"))
    private val fracFormatter = NumberFormat.getInstance(Locale("en", "PK")).apply {
        minimumFractionDigits = 2
        maximumFractionDigits = 2
    }

    fun format(amountPaisa: Long): String {
        val rupees = amountPaisa / 100.0
        return if (amountPaisa % 100 == 0L) {
            "Rs ${wholeFormatter.format(amountPaisa / 100)}"
        } else {
            "Rs ${fracFormatter.format(rupees)}"
        }
    }
}
