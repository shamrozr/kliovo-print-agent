package com.kliovo.printagent.escpos

import java.io.ByteArrayOutputStream

class ESCPOSBuilder {

    private val out = ByteArrayOutputStream()
    private var currentCodePage = CP1256.CODE_PAGE

    private companion object {
        const val ESC: Byte = 0x1B
        const val GS: Byte = 0x1D
        const val LF: Byte = 0x0A
    }

    fun init(): ESCPOSBuilder {
        out.write(byteArrayOf(ESC, 0x40))
        return codePage(CP1256.CODE_PAGE)
    }

    fun codePage(cp: Int): ESCPOSBuilder {
        currentCodePage = cp
        out.write(byteArrayOf(ESC, 0x74, cp.toByte()))
        return this
    }

    fun text(s: String): ESCPOSBuilder {
        if (s.isEmpty()) return this
        out.write(encodeText(s))
        return this
    }

    fun line(s: String = ""): ESCPOSBuilder {
        return text(s).newline()
    }

    fun newline(count: Int = 1): ESCPOSBuilder {
        if (count <= 0) return this
        repeat(count) { out.write(LF.toInt()) }
        return this
    }

    fun feed(lines: Int): ESCPOSBuilder {
        if (lines <= 0) return this
        out.write(byteArrayOf(ESC, 0x64, lines.coerceAtMost(255).toByte()))
        return this
    }

    fun align(a: String): ESCPOSBuilder {
        val n: Byte = when (a) {
            "left" -> 0
            "center" -> 1
            "right" -> 2
            else -> 0
        }
        out.write(byteArrayOf(ESC, 0x61, n))
        return this
    }

    fun bold(on: Boolean): ESCPOSBuilder {
        out.write(byteArrayOf(ESC, 0x45, if (on) 1 else 0))
        return this
    }

    fun underline(level: Int = 1): ESCPOSBuilder {
        out.write(byteArrayOf(ESC, 0x2D, level.toByte()))
        return this
    }

    fun invert(on: Boolean): ESCPOSBuilder {
        out.write(byteArrayOf(GS, 0x42, if (on) 1 else 0))
        return this
    }

    fun size(size: String): ESCPOSBuilder {
        val n: Byte = when (size) {
            "small" -> 0x00
            "normal" -> 0x00
            "large" -> 0x11
            "xlarge" -> 0x22
            else -> 0x00
        }
        out.write(byteArrayOf(GS, 0x21, n))
        out.write(byteArrayOf(ESC, 0x4D, if (size == "small") 0x01 else 0x00))
        return this
    }

    fun rule(paperWidth: Int = 80, char: String = "-"): ESCPOSBuilder {
        val width = if (paperWidth == 80) 48 else 32
        return line(char.repeat(width))
    }

    fun row(label: String, value: String, paperWidth: Int = 80): ESCPOSBuilder {
        val width = if (paperWidth == 80) 48 else 32
        val gap = (width - label.length - value.length).coerceAtLeast(1)
        return line(label + " ".repeat(gap) + value)
    }

    fun qr(data: String, model: Int = 2, size: Int = 6, ec: String = "M"): ESCPOSBuilder {
        val moduleSize = size.coerceIn(1, 16)
        val ecMap = mapOf("L" to 48, "M" to 49, "Q" to 50, "H" to 51)
        val ecByte = (ecMap[ec] ?: 49).toByte()

        out.write(byteArrayOf(GS, 0x28, 0x6B, 4, 0, 49, 65, (model + 49).toByte(), 0))
        out.write(byteArrayOf(GS, 0x28, 0x6B, 3, 0, 49, 67, moduleSize.toByte()))
        out.write(byteArrayOf(GS, 0x28, 0x6B, 3, 0, 49, 69, ecByte))

        val dataBuf = data.toByteArray(Charsets.UTF_8)
        val len = dataBuf.size + 3
        val pL = (len and 0xFF).toByte()
        val pH = ((len shr 8) and 0xFF).toByte()
        out.write(byteArrayOf(GS, 0x28, 0x6B, pL, pH, 49, 80, 48))
        out.write(dataBuf)

        out.write(byteArrayOf(GS, 0x28, 0x6B, 3, 0, 49, 81, 48))
        return this
    }

    fun barcode(
        data: String,
        type: String = "CODE128",
        height: Int = 80,
        width: Int = 3,
        hriPosition: Int = 2
    ): ESCPOSBuilder {
        val typeMap = mapOf(
            "UPC-A" to 65, "UPC-E" to 66, "EAN13" to 67, "EAN8" to 68,
            "CODE39" to 69, "ITF" to 70, "CODE93" to 72, "CODE128" to 73
        )
        val t = (typeMap[type] ?: 73).toByte()
        val h = height.coerceIn(1, 255).toByte()
        val w = width.coerceIn(2, 6).toByte()
        val hri = hriPosition.toByte()

        out.write(byteArrayOf(GS, 0x68, h))
        out.write(byteArrayOf(GS, 0x77, w))
        out.write(byteArrayOf(GS, 0x48, hri))

        val dataBuf = data.toByteArray(Charsets.US_ASCII)
        out.write(byteArrayOf(GS, 0x6B, t, dataBuf.size.toByte()))
        out.write(dataBuf)
        return this
    }

    fun rasterImage(rasterBytes: ByteArray, widthBytes: Int, heightDots: Int): ESCPOSBuilder {
        val m: Byte = 0
        val xL = (widthBytes and 0xFF).toByte()
        val xH = ((widthBytes shr 8) and 0xFF).toByte()
        val yL = (heightDots and 0xFF).toByte()
        val yH = ((heightDots shr 8) and 0xFF).toByte()
        out.write(byteArrayOf(GS, 0x76, 0x30, m, xL, xH, yL, yH))
        out.write(rasterBytes)
        return this
    }

    fun drawerKick(pin: Int = 0): ESCPOSBuilder {
        out.write(byteArrayOf(ESC, 0x70, pin.toByte(), 0x32, 0x78))
        return this
    }

    fun cut(full: Boolean = true): ESCPOSBuilder {
        feed(1)
        out.write(byteArrayOf(GS, 0x56, if (full) 0x00 else 0x01))
        return this
    }

    fun build(): ByteArray = out.toByteArray()

    fun toBase64(): String = android.util.Base64.encodeToString(build(), android.util.Base64.NO_WRAP)

    private fun encodeText(s: String): ByteArray {
        return if (currentCodePage == CP1256.CODE_PAGE) {
            CP1256.encode(s)
        } else {
            s.toByteArray(Charsets.ISO_8859_1)
        }
    }
}
