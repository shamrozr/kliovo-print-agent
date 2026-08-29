package com.kliovo.printagent.bridge

import android.content.Context
import android.util.Base64
import android.util.Log
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.health.HealthTracker
import com.kliovo.printagent.health.PrintResult
import com.kliovo.printagent.ledger.PrintedJobsLedger
import com.kliovo.printagent.transport.BlePrinterSender
import com.kliovo.printagent.transport.BluetoothPrinterSender
import com.kliovo.printagent.transport.Deliver
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "BridgeServer"

/**
 * The local bridge — same contract as the desktop agent's bridge-server.ts, so
 * Dine running in Chrome ON THIS TABLET can push a job or discover printers
 * without knowing which platform the agent is.
 *
 * Bound to 127.0.0.1 only. Chrome treats `http://127.0.0.1` as a secure origin,
 * which is what lets `https://dine.kliovo.com` call it without a mixed-content
 * block — the same mechanism the desktop agent has relied on in production for
 * a year. `Access-Control-Allow-Private-Network` is required for Chrome's
 * private-network-access preflight; without it the browser refuses before the
 * request is ever made.
 */
class BridgeServer(
    private val context: Context,
    private val config: ConfigStore,
    private val ledger: PrintedJobsLedger,
    private val agentVersion: String,
) : NanoHTTPD("127.0.0.1", PORT) {

    private val guard = IdempotencyGuard()

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        if (session.method == Method.OPTIONS) return cors(newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_JSON, ""))

        return try {
            when {
                session.method == Method.GET && uri == "/ping" -> json(
                    JSONObject()
                        .put("ok", true)
                        .put("version", agentVersion)
                        .put("platform", "android")
                        .put("printers", JSONArray(config.printers.map { it.printerId }))
                )

                session.method == Method.GET && uri == "/status" -> json(
                    JSONObject()
                        .put("ok", true)
                        .put("version", agentVersion)
                        .put("platform", "android")
                        .put("lastPollAt", HealthTracker.lastPollAt.value)
                        .put("printers", JSONArray(HealthTracker.perPrinter.value.values.map { h ->
                            JSONObject()
                                .put("printerId", h.printerId)
                                .put("name", h.printerName)
                                .put("healthy", h.isHealthy)
                                .put("okCount", h.okCount)
                                .put("failCount", h.failCount)
                                .put("lastError", h.lastError ?: JSONObject.NULL)
                        }))
                )

                // Paired Bluetooth printers on THIS tablet. Dine's printer form
                // calls this so an admin picks a printer by name instead of
                // typing a MAC address off the back of the device.
                session.method == Method.GET && uri == "/bluetooth/devices" -> {
                    // Paired (Classic) AND nearby (BLE). A BLE printer can never
                    // be paired, so a paired-only list would hide exactly the
                    // printers people cannot find in Android's settings either.
                    val paired = BluetoothPrinterSender.listPairedDevices(context)
                        .map { JSONObject().put("address", it.address).put("name", it.name).put("kind", "paired") }
                    val pairedAddresses = paired.map { it.getString("address").uppercase() }.toSet()
                    val nearby = runBlocking { BlePrinterSender.scan(context) }
                        .filter { it.address.uppercase() !in pairedAddresses }
                        .map { JSONObject().put("address", it.address).put("name", it.name).put("kind", "ble") }
                    json(
                        JSONObject()
                            .put("ok", true)
                            .put("permissionGranted", BluetoothPrinterSender.hasPermission(context))
                            .put("bluetoothEnabled", BluetoothPrinterSender.isEnabled(context))
                            .put("devices", JSONArray(paired + nearby))
                    )
                }

                session.method == Method.POST && uri == "/print" -> handlePrint(session)

                else -> json(JSONObject().put("ok", false).put("error", "Not found"), Response.Status.NOT_FOUND)
            }
        } catch (e: Exception) {
            Log.e(TAG, "serve $uri failed", e)
            json(JSONObject().put("ok", false).put("error", e.message ?: "error"), Response.Status.INTERNAL_ERROR)
        }
    }

    private fun handlePrint(session: IHTTPSession): Response {
        val body = readBody(session)
        val req = JSONObject(body)
        val printJobId = req.optString("printJobId").ifBlank { null }
        val printerId = req.optString("printerId")
        val bytesBase64 = req.optString("bytesBase64")

        val printer = config.findPrinter(printerId)
            ?: return json(
                JSONObject().put("ok", false).put("error", "Printer $printerId not in config"),
                Response.Status.NOT_FOUND
            )

        // The durable ledger first: a redelivered push must not print twice.
        if (printJobId != null && ledger.hasPrinted(printJobId)) {
            return json(JSONObject().put("ok", true).put("deduped", true))
        }
        // Then the short-window guard, which catches a browser retry that
        // carries no job id at all.
        val key = printJobId ?: "${printerId}:${bytesBase64.hashCode()}"
        if (guard.seenRecently(key)) {
            return json(JSONObject().put("ok", true).put("deduped", true))
        }

        val bytes = Base64.decode(bytesBase64, Base64.DEFAULT)
        val outcome = runBlocking { Deliver.deliver(context, printer, bytes) }
        HealthTracker.record(
            PrintResult(printer.printerId, printer.name, "raw", outcome.isOk, outcome.message.takeIf { !outcome.isOk })
        )
        return if (outcome.isOk) {
            if (printJobId != null) ledger.markPrinted(printJobId, printer.printerId, printer.agentKey)
            json(JSONObject().put("ok", true))
        } else {
            json(JSONObject().put("ok", false).put("error", outcome.message), Response.Status.INTERNAL_ERROR)
        }
    }

    private fun readBody(session: IHTTPSession): String {
        val files = HashMap<String, String>()
        session.parseBody(files)
        return files["postData"] ?: "{}"
    }

    private fun json(obj: JSONObject, status: Response.IStatus = Response.Status.OK): Response =
        cors(newFixedLengthResponse(status, MIME_JSON, obj.toString()))

    private fun cors(res: Response): Response = res.apply {
        addHeader("Access-Control-Allow-Origin", "*")
        addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        addHeader("Access-Control-Allow-Headers", "Content-Type, X-Agent-Secret, X-Aster-Token")
        // Chrome's private-network-access preflight refuses before the request
        // is made without this.
        addHeader("Access-Control-Allow-Private-Network", "true")
    }

    companion object {
        const val PORT = 6310
        private const val MIME_JSON = "application/json"
    }
}
