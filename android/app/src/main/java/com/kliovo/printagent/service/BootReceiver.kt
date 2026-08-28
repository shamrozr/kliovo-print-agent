package com.kliovo.printagent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.kliovo.printagent.config.ConfigStore

/**
 * Bring the agent back after a reboot or an app update. A tablet that reboots
 * overnight and comes back with a dead agent looks exactly like a broken
 * printer to whoever opens the restaurant.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val config = ConfigStore(context)
        if (!config.autoStart) return
        if (config.printers.none { it.isPollable }) return
        PrintAgentService.start(context)
    }
}
