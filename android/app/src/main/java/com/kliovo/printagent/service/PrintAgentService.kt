package com.kliovo.printagent.service

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.kliovo.printagent.KliovoPrintApp
import com.kliovo.printagent.R
import com.kliovo.printagent.bridge.BridgeServer
import com.kliovo.printagent.cloud.PollLoop
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.ledger.PrintedJobsLedger
import com.kliovo.printagent.ui.MainActivity

/**
 * The agent itself: a foreground service holding the cloud poll loop and the
 * local bridge.
 *
 * Foreground is not decoration. A background process is frozen by Doze within
 * minutes and the poll simply stops — the printer goes quiet at 23:00 with no
 * error anywhere. The persistent notification is the price of a printer that
 * works during service.
 */
class PrintAgentService : LifecycleService() {

    private lateinit var config: ConfigStore
    private lateinit var ledger: PrintedJobsLedger
    private var pollLoop: PollLoop? = null
    private var bridge: BridgeServer? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        config = ConfigStore(this)
        ledger = PrintedJobsLedger(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        startForegroundCompat()
        runCatching { acquireWakeLock() }
        runCatching { restart() }
        // STICKY: if Android kills us for memory we want to come back. The
        // printer being reachable is the entire point of this app.
        return START_STICKY
    }

    /** Re-read config and restart both loops — called on settings changes. */
    fun restart() {
        pollLoop?.stop()
        val version = runCatching {
            packageManager.getPackageInfo(packageName, 0).versionName
        }.getOrNull() ?: "0.0.0"

        pollLoop = PollLoop(applicationContext, config, ledger, version).also { it.start(lifecycleScope) }

        if (bridge == null) {
            bridge = BridgeServer(applicationContext, config, ledger, version).also {
                runCatching { it.start(SOCKET_READ_TIMEOUT_MS, true) }
            }
        }
    }

    private fun startForegroundCompat() {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification: Notification = NotificationCompat.Builder(this, KliovoPrintApp.CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Connected to the print queue")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        // Android 14 refuses FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE unless
        // BLUETOOTH_CONNECT is granted at the moment of the call, and it does
        // that by THROWING — which kills whatever started the service. A user
        // who has not reached the Bluetooth prompt yet (or declined it) would
        // therefore crash the app simply by tapping Save.
        //
        // So: ask for both types, fall back to dataSync alone, then to no type
        // at all. A running agent with a weaker service type is worth far more
        // than a crash.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val attempts = listOf(
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
            var started = false
            for (type in attempts) {
                try {
                    startForeground(NOTIFICATION_ID, notification, type)
                    started = true
                    break
                } catch (e: Exception) {
                    logStartFailure(e)
                }
            }
            if (!started) {
                runCatching { startForeground(NOTIFICATION_ID, notification) }
                    .onFailure { logStartFailure(it) }
            }
        } else {
            runCatching { startForeground(NOTIFICATION_ID, notification) }
                .onFailure { logStartFailure(it) }
        }
    }

    /**
     * A partial wake lock on top of the foreground service. Belt and braces on
     * purpose: several OEM skins doze a foreground service's threads anyway,
     * and a held poll that never resumes is a ticket that never prints.
     */
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kliovo:print-agent").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    override fun onDestroy() {
        pollLoop?.stop()
        runCatching { bridge?.stop() }
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }

    private fun logStartFailure(e: Throwable) {
        android.util.Log.w("PrintAgentService", "startForeground refused: ${e.message}")
    }

    companion object {
        private const val NOTIFICATION_ID = 1001
        private const val SOCKET_READ_TIMEOUT_MS = 15_000

        /** Returns the failure instead of throwing — the caller is a Save button. */
        fun start(context: Context): String? = try {
            val intent = Intent(context, PrintAgentService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            null
        } catch (e: Exception) {
            e.message ?: e.javaClass.simpleName
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, PrintAgentService::class.java))
        }
    }
}
