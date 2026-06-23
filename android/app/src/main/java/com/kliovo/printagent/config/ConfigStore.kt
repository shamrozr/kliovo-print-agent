package com.kliovo.printagent.config

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson

class ConfigStore(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("agent_config", Context.MODE_PRIVATE)
    private val gson = Gson()

    fun load(): AgentConfig {
        val json = prefs.getString(KEY_CONFIG, null) ?: return AgentConfig()
        return try {
            gson.fromJson(json, AgentConfig::class.java) ?: AgentConfig()
        } catch (_: Exception) {
            AgentConfig()
        }
    }

    fun save(config: AgentConfig) {
        prefs.edit()
            .putString(KEY_CONFIG, gson.toJson(config))
            .apply()
    }

    companion object {
        private const val KEY_CONFIG = "config_json"
    }
}
