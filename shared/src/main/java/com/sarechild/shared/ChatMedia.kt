package com.sarechild.shared

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Lightweight remote-media helpers shared by both apps' chat bubble adapters — deliberately
 * dependency-free (no Glide/Coil) so a photo/video note renders inline without pulling in an
 * image-loading library just for chat thumbnails.
 */
object ChatMedia {
    /** Downloads and downsamples a remote image to a bitmap suitable for a chat bubble thumbnail. */
    suspend fun loadImageThumb(url: String, maxDimenPx: Int = 480): Bitmap? = withContext(Dispatchers.IO) {
        runCatching {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8_000
                readTimeout = 15_000
            }
            val bytes = conn.inputStream.use { it.readBytes() }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (bounds.outWidth / sample > maxDimenPx || bounds.outHeight / sample > maxDimenPx) sample *= 2
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        }.getOrNull()
    }

    /** Grabs the first frame of a remote video as a poster thumbnail (no download needed). */
    suspend fun loadVideoThumb(url: String): Bitmap? = withContext(Dispatchers.IO) {
        runCatching {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(url, HashMap())
                retriever.getFrameAtTime(0)
            } finally {
                retriever.release()
            }
        }.getOrNull()
    }
}

/**
 * One-at-a-time voice/video-note player for chat bubbles — starting a new note stops whatever
 * was already playing, matching the "one voice note at a time" behavior of typical chat apps.
 * Callers own the lifecycle and must call [release] (e.g. in onDestroy).
 */
class ChatNotePlayer {
    private var player: MediaPlayer? = null
    private var currentUrl: String? = null

    fun isPlaying(url: String): Boolean = currentUrl == url && player?.isPlaying == true

    /** Toggles play/pause for [url]; switching to a different [url] stops the previous one first. */
    fun toggle(url: String, onStateChanged: (playing: Boolean) -> Unit, onCompleted: () -> Unit) {
        val existing = player
        if (currentUrl == url && existing != null) {
            if (existing.isPlaying) {
                existing.pause()
                onStateChanged(false)
            } else {
                existing.start()
                onStateChanged(true)
            }
            return
        }
        release()
        currentUrl = url
        val fresh = MediaPlayer()
        player = fresh
        runCatching {
            fresh.setDataSource(url)
            fresh.setOnPreparedListener {
                it.start()
                onStateChanged(true)
            }
            fresh.setOnCompletionListener {
                onStateChanged(false)
                onCompleted()
            }
            fresh.setOnErrorListener { _, _, _ ->
                onStateChanged(false)
                true
            }
            fresh.prepareAsync()
        }.onFailure {
            release()
            onStateChanged(false)
        }
    }

    fun release() {
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
        currentUrl = null
    }
}
