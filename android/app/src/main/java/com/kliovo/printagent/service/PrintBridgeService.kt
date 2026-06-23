package com.kliovo.printagent.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.kliovo.printagent.KliovoPrintApp
import com.kliovo.printagent.R
import com.kliovo.printagent.bridge.BridgeServer
import com.kliovo.printagent.config.ConfigStore
import com.kliovo.printagent.health.HealthTracker
import com.kliovo.printagent.ui.MainActivity

class PrintBridgeService : Service() {

    private var server: BridgeServer? = null

    companion object {
        private const val TAG = "PrintBridgeService"
        private const val NOTIFICATION_ID = 1
        val healthTracker = HealthTracker()
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())

        if (server == null) {
            try {
                val configStore = ConfigStore(applicationContext)
                val version = packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
                server = BridgeServer(configStore, healthTracker, version)
                server?.start()
                Log.i(TAG, "Bridge server started on port ${BridgeServer.PORT}")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start bridge server: ${e.message}")
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        Log.i(TAG, "Service destroyed, server stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, KliovoPrintApp.CHANNEL_ID)
            .setContentTitle("Kliovo Print Agent")
            .setContentText("Print bridge running on port ${BridgeServer.PORT}")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}
