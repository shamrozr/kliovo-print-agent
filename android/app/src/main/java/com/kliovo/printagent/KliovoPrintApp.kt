package com.kliovo.printagent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import java.io.PrintWriter
import java.io.StringWriter

class KliovoPrintApp : Application() {

    override fun onCreate() {
        super.onCreate()
        installCrashRecorder()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                // LOW, not MIN: the notification must stay visible (it is what
                // keeps the service alive and tells staff the agent is running),
                // but it must not make a sound on every print.
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = getString(R.string.channel_desc) }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    /**
     * Keep the stack trace of a crash so the next launch can show it.
     *
     * A tablet on a counter has no logcat and nobody to read it. Without this,
     * "it keeps crashing" is all anyone can report, and the actual exception —
     * the one fact that identifies the bug — is lost the moment the process
     * dies. The default handler still runs, so behaviour is unchanged apart
     * from the record.
     */
    private fun installCrashRecorder() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
                getSharedPreferences(CRASH_PREFS, Context.MODE_PRIVATE).edit()
                    .putString(CRASH_KEY, "${error.javaClass.simpleName} on ${thread.name}\n\n$trace".take(8000))
                    .putLong(CRASH_AT_KEY, System.currentTimeMillis())
                    .commit() // commit, not apply — the process is about to die
            }
            previous?.uncaughtException(thread, error)
        }
    }

    companion object {
        const val CHANNEL_ID = "print-agent"
        const val CRASH_PREFS = "kliovo-crash"
        const val CRASH_KEY = "lastCrash"
        const val CRASH_AT_KEY = "lastCrashAt"

        fun lastCrash(context: Context): String? =
            context.getSharedPreferences(CRASH_PREFS, Context.MODE_PRIVATE).getString(CRASH_KEY, null)

        fun clearCrash(context: Context) {
            context.getSharedPreferences(CRASH_PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }
    }
}
