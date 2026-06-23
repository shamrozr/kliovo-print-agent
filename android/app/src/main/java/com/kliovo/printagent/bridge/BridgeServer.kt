package com.kliovo.printagent.bridge

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.health.HealthTracker
import com.kliovo.printagent.printer.TcpPrinterSender
import com.kliovo.printagent.render.*
import fi.iki.elonen.NanoHTTPD

class BridgeServer(
    private val configStore: ConfigStore,
    private val healthTracker: HealthTracker,
    private val appVersion: String
) : NanoHTTPD("127.0.0.1", PORT) {

    private val gson = Gson()
    private val idempotency = IdempotencyGuard()

    companion object {
        const val PORT = 6310
        private const val TAG = "BridgeServer"
    }

    private val corsHeaders = mapOf(
        "Access-Control-Allow-Origin" to "*",
        "Access-Control-Allow-Methods" to "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers" to "Content-Type, X-Agent-Secret, X-Aster-Token",
        "Access-Control-Allow-Private-Network" to "true"
    )

    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.OPTIONS) {
            return newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_PLAINTEXT, "").also {
                corsHeaders.forEach { (k, v) -> it.addHeader(k, v) }
            }
        }

        val resp = when {
            session.method == Method.GET && session.uri == "/ping" -> handlePing()
            session.method == Method.GET && session.uri == "/status" -> handleStatus()
            session.method == Method.POST && session.uri == "/print" -> handlePrint(session)
            session.method == Method.POST && session.uri == "/render-print" -> handleRenderPrint(session)
            else -> jsonResponse(Response.Status.NOT_FOUND, mapOf("ok" to false, "error" to "Not found"))
        }

        corsHeaders.forEach { (k, v) -> resp.addHeader(k, v) }
        return resp
    }

    private fun handlePing(): Response {
        val config = configStore.load()
        return jsonResponse(
            Response.Status.OK,
            mapOf(
                "ok" to true,
                "version" to appVersion,
                "printers" to config.printers.map { it.printerId }
            )
        )
    }

    private fun handleStatus(): Response {
        val snap = healthTracker.snapshot()
        return jsonResponse(
            Response.Status.OK,
            mapOf(
                "ok" to true,
                "version" to appVersion,
                "status" to snap.status,
                "printers" to snap.printers,
                "recent" to snap.recent
            )
        )
    }

    private fun handlePrint(session: IHTTPSession): Response {
        val body = readBody(session)
        return try {
            val json = JsonParser.parseString(body).asJsonObject
            val printJobId = json.get("printJobId")?.asString
            val printerId = json.get("printerId")?.asString ?: return errorResponse("printerId required")
            val bytesBase64 = json.get("bytesBase64")?.asString ?: return errorResponse("bytesBase64 required")

            val config = configStore.load()
            val pc = config.printers.find { it.printerId == printerId }
                ?: return jsonResponse(Response.Status.NOT_FOUND, mapOf("ok" to false, "error" to "Printer $printerId not in config"))

            Log.i(TAG, "received raw job ${printJobId ?: "?"} for $printerId")
            val bytes = android.util.Base64.decode(bytesBase64, android.util.Base64.DEFAULT)
            TcpPrinterSender.send(pc.host, pc.port, bytes)
            healthTracker.record(printerId, pc.name, "raw", true, null)
            jsonResponse(Response.Status.OK, mapOf("ok" to true))
        } catch (e: Exception) {
            Log.e(TAG, "print error: ${e.message}")
            val printerId = try { JsonParser.parseString(body).asJsonObject.get("printerId")?.asString } catch (_: Exception) { null }
            if (printerId != null) {
                healthTracker.record(printerId, printerId, "raw", false, e.message)
            }
            jsonResponse(Response.Status.INTERNAL_ERROR, mapOf("ok" to false, "error" to (e.message ?: "unknown")))
        }
    }

    private fun handleRenderPrint(session: IHTTPSession): Response {
        val body = readBody(session)
        return try {
            val json = JsonParser.parseString(body).asJsonObject
            val printJobId = json.get("printJobId")?.asString
            val printerId = json.get("printerId")?.asString ?: return errorResponse("printerId required")
            val idempotencyKey = json.get("idempotencyKey")?.asString
            val jobObj = json.getAsJsonObject("job") ?: return errorResponse("job required")
            val kind = jobObj.get("kind")?.asString ?: return errorResponse("job.kind required")

            val dedupKey = idempotencyKey ?: printJobId
            if (dedupKey != null && idempotency.seenRecently(dedupKey)) {
                Log.i(TAG, "dedup — skipped duplicate job $dedupKey")
                return jsonResponse(Response.Status.OK, mapOf("ok" to true, "deduped" to true))
            }

            val config = configStore.load()
            val pc = config.printers.find { it.printerId == printerId }
                ?: return jsonResponse(Response.Status.NOT_FOUND, mapOf("ok" to false, "error" to "Printer $printerId not in config"))

            Log.i(TAG, "received $kind job ${printJobId ?: dedupKey ?: "?"} for $printerId")
            val inputObj = jobObj.getAsJsonObject("input")
            val paperWidth = pc.paperWidth

            val bytes = renderJob(kind, inputObj, paperWidth)
            TcpPrinterSender.send(pc.host, pc.port, bytes)
            healthTracker.record(printerId, pc.name, kind, true, null)
            jsonResponse(Response.Status.OK, mapOf("ok" to true, "rendered" to true))
        } catch (e: Exception) {
            Log.e(TAG, "render-print error: ${e.message}")
            val printerId = try { JsonParser.parseString(body).asJsonObject.get("printerId")?.asString } catch (_: Exception) { null }
            val kind = try { JsonParser.parseString(body).asJsonObject.getAsJsonObject("job")?.get("kind")?.asString } catch (_: Exception) { null }
            if (printerId != null) {
                healthTracker.record(printerId, printerId, kind ?: "unknown", false, e.message)
            }
            jsonResponse(Response.Status.INTERNAL_ERROR, mapOf("ok" to false, "error" to (e.message ?: "unknown")))
        }
    }

    private fun renderJob(kind: String, input: JsonObject, paperWidth: Int): ByteArray {
        return when (kind) {
            "receipt" -> {
                val ri = gson.fromJson(input, ReceiptInput::class.java).copy(paperWidth = paperWidth)
                ReceiptRenderer.render(ri)
            }
            "kot" -> {
                val ki = gson.fromJson(input, KotInput::class.java).copy(paperWidth = paperWidth)
                KotRenderer.render(ki)
            }
            "master_kot" -> {
                val mi = gson.fromJson(input, MasterKotInput::class.java).copy(paperWidth = paperWidth)
                MasterKotRenderer.render(mi)
            }
            "void_kot" -> {
                val vi = gson.fromJson(input, VoidKotInput::class.java).copy(paperWidth = paperWidth)
                VoidKotRenderer.render(vi)
            }
            "label" -> {
                val li = gson.fromJson(input, LabelInput::class.java).copy(paperWidth = paperWidth)
                LabelRenderer.render(li)
            }
            else -> throw IllegalArgumentException("Unknown print job kind: $kind")
        }
    }

    private fun readBody(session: IHTTPSession): String {
        val files = mutableMapOf<String, String>()
        session.parseBody(files)
        return files["postData"] ?: ""
    }

    private fun jsonResponse(status: Response.Status, data: Any): Response {
        return newFixedLengthResponse(status, "application/json", gson.toJson(data))
    }

    private fun errorResponse(msg: String): Response {
        return jsonResponse(Response.Status.BAD_REQUEST, mapOf("ok" to false, "error" to msg))
    }
}
