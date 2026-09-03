package com.convx.music.config

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import timber.log.Timber
import java.net.URL

data class RemoteVersionConfig(
    val version: String?,
    val tag: String?,
    val apiUrl: String?,
    val apiKey: String?,
    val listenTogetherWsUrl: String?,
    val blendsApiUrl: String?,
)

object RemoteVersionConfigProvider {
    private const val UPDATE_REPO = "ogtanmay/Convx"
    const val VERSION_JSON_URL = "https://raw.githubusercontent.com/$UPDATE_REPO/main/version.json"

    @Volatile
    private var cached: RemoteVersionConfig? = null

    fun cached(): RemoteVersionConfig? = cached

    suspend fun refresh(): RemoteVersionConfig? = withContext(Dispatchers.IO) {
        runCatching {
            val jsonText = URL(VERSION_JSON_URL).openStream().bufferedReader().use { it.readText() }
            val obj = JSONObject(jsonText)
            RemoteVersionConfig(
                version = obj.optString("version").takeIf { it.isNotBlank() },
                tag = obj.optString("tag").takeIf { it.isNotBlank() },
                apiUrl = obj.optString("api_url").takeIf { it.isNotBlank() },
                apiKey = obj.optString("api_key").takeIf { it.isNotBlank() },
                listenTogetherWsUrl = obj.optString("listen_together_ws_url").takeIf { it.isNotBlank() },
                blendsApiUrl = obj.optString("blends_api_url").takeIf { it.isNotBlank() },
            )
        }.onSuccess {
            cached = it
        }.onFailure { e ->
            Timber.tag("RemoteVersionConfig").w("Failed to refresh version.json config: ${e.message}")
        }.getOrNull()
    }
}

