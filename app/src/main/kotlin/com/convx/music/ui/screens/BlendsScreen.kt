/**
 * Convx Project (C) 2026
 * Licensed under GPL-3.0 | See git history for contributors
 */

package com.convx.music.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.convx.music.LocalPlayerAwareWindowInsets
import com.convx.music.LocalPlayerConnection
import com.convx.music.R
import com.convx.music.config.RemoteVersionConfigProvider
import com.convx.music.extensions.toMediaItem
import com.convx.music.listentogether.ListenTogetherServers
import com.convx.music.listentogether.TrackInfo
import com.convx.music.models.MediaMetadata
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

private data class BlendTrackRow(
    val track: TrackInfo,
    val score: Int,
    val submittedBy: List<String>,
)

private data class BlendSnapshot(
    val code: String,
    val members: List<String>,
    val tracks: List<BlendTrackRow>,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BlendsScreen(navController: NavController) {
    val playerConnection = LocalPlayerConnection.current ?: return
    val currentMetadata by playerConnection.mediaMetadata.collectAsState()
    val scope = rememberCoroutineScope()
    val api = remember { BlendsApi() }

    var username by remember { mutableStateOf("") }
    var roomCode by remember { mutableStateOf("") }
    var blend by remember { mutableStateOf<BlendSnapshot?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun runRequest(request: suspend () -> BlendSnapshot) {
        if (username.isBlank()) {
            error = "Enter a username first"
            return
        }
        loading = true
        error = null
        scope.launch {
            try {
                val snapshot = request()
                blend = snapshot
                roomCode = snapshot.code
            } catch (exception: Exception) {
                error = exception.message ?: "Blends request failed"
            }
            loading = false
        }
    }

    LaunchedEffect(blend?.code) {
        val code = blend?.code ?: return@LaunchedEffect
        while (true) {
            kotlinx.coroutines.delay(15_000)
            try {
                blend = api.get(code)
            } catch (_: Exception) {
                // Keep the last successful snapshot while the device is
                // offline; the next refresh will retry automatically.
            }
        }
    }

    Scaffold(
        contentWindowInsets = LocalPlayerAwareWindowInsets.current,
        topBar = {
            TopAppBar(
                title = { Text("Blends") },
                navigationIcon = {
                    IconButton(onClick = navController::navigateUp) {
                        Icon(painterResource(R.drawable.arrow_back), contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item {
                Text(
                    "Build a shared queue with friends. Duplicate songs are ranked by the number of people who submit them.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            item {
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it.take(120) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Your name") },
                    singleLine = true
                )
            }
            item {
                Row(modifier = Modifier.fillMaxWidth()) {
                    OutlinedTextField(
                        value = roomCode,
                        onValueChange = { roomCode = it.uppercase().take(12) },
                        modifier = Modifier.weight(1f),
                        label = { Text("Blend code") },
                        singleLine = true
                    )
                    Spacer(Modifier.width(8.dp))
                    Button(
                        enabled = !loading && roomCode.isNotBlank(),
                        onClick = { runRequest { api.join(roomCode, username.trim()) } }
                    ) {
                        Text("Join")
                    }
                }
            }
            item {
                OutlinedButton(
                    enabled = !loading,
                    onClick = { runRequest { api.create(username.trim()) } }
                ) {
                    Text("Create a blend")
                }
            }
            if (loading) {
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center
                    ) {
                        CircularProgressIndicator()
                    }
                }
            }
            error?.let { message ->
                item {
                    Text(message, color = MaterialTheme.colorScheme.error)
                }
            }
            blend?.let { snapshot ->
                item {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Blend ${snapshot.code}", style = MaterialTheme.typography.titleMedium)
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "${snapshot.members.size} participant${if (snapshot.members.size == 1) "" else "s"}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(Modifier.height(12.dp))
                            Button(
                                enabled = currentMetadata != null && !loading,
                                onClick = {
                                    val track = currentMetadata?.toTrackInfo(username.trim()) ?: return@Button
                                    loading = true
                                    scope.launch {
                                        runCatching { api.addTrack(snapshot.code, username.trim(), track) }
                                            .onSuccess { blend = it }
                                            .onFailure { error = it.message ?: "Could not add track" }
                                        loading = false
                                    }
                                }
                            ) {
                                Text("Add currently playing")
                            }
                        }
                    }
                }
                if (snapshot.tracks.isEmpty()) {
                    item {
                        Text(
                            "No songs yet. Add the song currently playing to start the blend.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                } else {
                    items(snapshot.tracks, key = { it.track.id }) { row ->
                        BlendTrackCard(row) {
                            val mediaMetadata = row.toMediaMetadata()
                            playerConnection.allowInternalSync = true
                            playerConnection.playNext(mediaMetadata.toMediaItem())
                            playerConnection.allowInternalSync = false
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BlendTrackCard(row: BlendTrackRow, onPlay: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(row.track.title, style = MaterialTheme.typography.titleSmall)
                Text(
                    row.track.artist,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    "${row.score} vote${if (row.score == 1) "" else "s"}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary
                )
            }
            OutlinedButton(onClick = onPlay) {
                Text("Play next")
            }
        }
    }
}

private class BlendsApi {
    private val baseUrl: String
        get() {
            val configured = RemoteVersionConfigProvider.cached()?.blendsApiUrl
            return (configured ?: ListenTogetherServers.defaultServerUrl)
                .replaceFirst(Regex("^wss://"), "https://")
                .replaceFirst(Regex("^ws://"), "http://")
                .trimEnd('/')
        }

    suspend fun create(username: String): BlendSnapshot =
        request("POST", "/api/blends", JSONObject().put("username", username))

    suspend fun join(code: String, username: String): BlendSnapshot =
        request("POST", "/api/blends/${code.trim()}/join", JSONObject().put("username", username))

    suspend fun addTrack(code: String, username: String, track: TrackInfo): BlendSnapshot =
        request(
            "POST",
            "/api/blends/${code.trim()}/tracks",
            JSONObject().put("username", username).put("track", track.toJson())
        )

    suspend fun get(code: String): BlendSnapshot = request("GET", "/api/blends/${code.trim()}", null)

    private suspend fun request(method: String, path: String, body: JSONObject?): BlendSnapshot =
        withContext(Dispatchers.IO) {
            val connection = (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("Accept", "application/json")
                RemoteVersionConfigProvider.apiKey()?.let { setRequestProperty("X-API-Key", it) }
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    outputStream.use { it.write(body.toString().toByteArray()) }
                }
            }
            try {
                val responseText = (if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader()?.use { it.readText() }.orEmpty()
                if (connection.responseCode !in 200..299) {
                    val reason = runCatching { JSONObject(responseText).optString("error") }.getOrNull()
                    throw IOException(reason?.takeIf { it.isNotBlank() } ?: "HTTP ${connection.responseCode}")
                }
                parseSnapshot(JSONObject(responseText))
            } finally {
                connection.disconnect()
            }
        }
}

private fun parseSnapshot(json: JSONObject): BlendSnapshot {
    val tracks = buildList {
        val array = json.optJSONArray("tracks") ?: JSONArray()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optString("id").takeIf { it.isNotBlank() } ?: continue
            add(
                BlendTrackRow(
                    track = TrackInfo(
                        id = id,
                        title = item.optString("title"),
                        artist = item.optString("artist"),
                        album = item.optString("album").takeIf { it.isNotBlank() },
                        duration = item.optLong("duration", 0L),
                        thumbnail = item.optString("thumbnail").takeIf { it.isNotBlank() },
                        suggestedBy = item.optString("suggested_by").takeIf { it.isNotBlank() }
                    ),
                    score = item.optInt("score", 1),
                    submittedBy = item.optJSONArray("submitted_by").toStringList()
                )
            )
        }
    }
    return BlendSnapshot(
        code = json.optString("code", json.optString("blend_code")),
        members = json.optJSONArray("members").toStringList(),
        tracks = tracks
    )
}

private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) optString(index).takeIf { it.isNotBlank() }?.let(::add)
    }
}

private fun MediaMetadata.toTrackInfo(username: String): TrackInfo =
    TrackInfo(
        id = id,
        title = title,
        artist = artists.joinToString { it.name },
        album = album?.title,
        duration = duration.coerceAtLeast(0).toLong(),
        thumbnail = thumbnailUrl,
        suggestedBy = username
    )

private fun TrackInfo.toJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("title", title)
    .put("artist", artist)
    .put("album", album)
    .put("duration", duration)
    .put("thumbnail", thumbnail)
    .put("suggested_by", suggestedBy)

private fun BlendTrackRow.toMediaMetadata(): MediaMetadata =
    MediaMetadata(
        id = track.id,
        title = track.title,
        artists = track.artist.split(",").map { MediaMetadata.Artist(null, it.trim()) }.filter { it.name.isNotBlank() },
        duration = track.duration.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
        thumbnailUrl = track.thumbnail,
        album = track.album?.let { MediaMetadata.Album(track.id, it) },
        suggestedBy = track.suggestedBy
    )