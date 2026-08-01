package com.sarechild.child.monitoring

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.SareChildConstants
import com.sarechild.shared.WhatsAppEvent
import com.sarechild.shared.WhatsAppEventType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Watches the shared-storage MediaStore (not raw files) for new images/video/audio that live
 * under a WhatsApp media folder, so images, voice notes, and videos shared over WhatsApp show
 * up in the parent's WhatsApp timeline even though the chat database itself is unreadable.
 *
 * Deliberately uses `ContentObserver` on `MediaStore.Images/Video/Audio` — not a raw
 * `FileObserver`/recursive directory walk — because:
 *  - It is event-driven (near-zero battery cost while idle; no polling loop).
 *  - It works within Android 10+ scoped storage without requesting the sensitive
 *    MANAGE_EXTERNAL_STORAGE ("all files access") permission, which Play Store restricts to
 *    file-manager-class apps and would likely get a parental-control app rejected.
 *  - WhatsApp's own media (images/video/audio, including voice notes) is auto-indexed into
 *    MediaStore by the OS media scanner even on scoped storage, so this reaches the same files
 *    without extra permission surface.
 *
 * Known, documented limitation: plain **documents** (PDF, docx, etc.) shared over WhatsApp are
 * not indexed into MediaStore, so they cannot be detected this way — only their *notification*
 * (handled by [WhatsAppMonitor], classified as [WhatsAppEventType.DOCUMENT] from the
 * notification text) is recorded. This mirrors a real Android/Play Store constraint, not a
 * shortcut we took.
 */
class WhatsAppMediaObserver(
    private val context: Context,
    private val repo: ChildRepository
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val handlerThread = HandlerThread("sarechild-wa-media").apply { start() }
    private val handler = Handler(handlerThread.looper)
    private val observers = mutableListOf<ContentObserver>()
    private val processedIds = ConcurrentHashMap<Long, Long>()
    private val startedAtMs = System.currentTimeMillis()

    fun start() {
        if (!repo.whatsappMonitorConsent) return
        if (hasImageVideoPermission()) {
            register(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image")
            register(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "video")
        }
        if (hasAudioPermission()) {
            register(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, "audio")
        }
    }

    fun stop() {
        observers.forEach { runCatching { context.contentResolver.unregisterContentObserver(it) } }
        observers.clear()
        scope.cancel()
        handlerThread.quitSafely()
    }

    private fun register(uri: Uri, kindHint: String) {
        var debounced = false
        val observer = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                if (debounced) return
                debounced = true
                // Coalesce bursts (e.g. multiple photos shared at once) into a single scan.
                handler.postDelayed({
                    debounced = false
                    scope.launch { runCatching { scanRecent(uri, kindHint) } }
                }, 3_000L)
            }
        }
        context.contentResolver.registerContentObserver(uri, true, observer)
        observers += observer
    }

    private suspend fun scanRecent(uri: Uri, kindHint: String) {
        if (!repo.whatsappMonitorConsent) return
        val projection = mutableListOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DATA,
            MediaStore.MediaColumns.DATE_ADDED,
            MediaStore.MediaColumns.DISPLAY_NAME
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            projection += MediaStore.MediaColumns.RELATIVE_PATH
        }
        val sort = "${MediaStore.MediaColumns.DATE_ADDED} DESC"
        runCatching {
            context.contentResolver.query(uri, projection.toTypedArray(), null, null, sort)
        }.getOrNull()?.use { cursor ->
            val idIdx = cursor.getColumnIndex(MediaStore.MediaColumns._ID)
            val dataIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DATA)
            val dateIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DATE_ADDED)
            val nameIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
            val relIdx = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
            } else {
                -1
            }
            var checked = 0
            while (cursor.moveToNext() && checked < 8) {
                checked++
                val id = if (idIdx >= 0) cursor.getLong(idIdx) else continue
                val dateAddedSec = if (dateIdx >= 0) cursor.getLong(dateIdx) else 0L
                // Rows are sorted newest-first; once we hit something older than when this
                // observer started (minus a small buffer), nothing further can be new.
                if (dateAddedSec > 0 && dateAddedSec * 1000L < startedAtMs - 60_000L) break
                val data = (if (dataIdx >= 0) cursor.getString(dataIdx) else null).orEmpty()
                val relPath = (if (relIdx >= 0) cursor.getString(relIdx) else null).orEmpty()
                val name = (if (nameIdx >= 0) cursor.getString(nameIdx) else null).orEmpty()
                if (!"$data $relPath".contains("whatsapp", ignoreCase = true)) continue
                if (processedIds.putIfAbsent(id, System.currentTimeMillis()) != null) continue
                trimProcessed()
                handleMediaFile(id, uri, name, kindHint, data, relPath)
            }
        }
    }

    private suspend fun handleMediaFile(
        id: Long,
        baseUri: Uri,
        displayName: String,
        kindHint: String,
        dataPath: String,
        relPath: String
    ) {
        val eventType = classifyFile(displayName, kindHint)
        val contactLabel = WhatsAppMonitor.recentContactLabel(SareChildConstants.WHATSAPP_PACKAGE)
            ?: WhatsAppMonitor.recentContactLabel(SareChildConstants.WHATSAPP_BUSINESS_PACKAGE)
            ?: "Unknown contact"
        val normalized = WhatsAppMonitor.normalizeIdentifier(contactLabel)
        val safe = WhatsAppMonitor.isKnownSafe(repo, normalized)

        val pathCombined = "$dataPath $relPath"
        val direction = when {
            WhatsAppMonitor.isSentMediaPath(pathCombined) -> "OUT"
            WhatsAppMonitor.wasRecentOutgoingContact(contactLabel) -> "OUT"
            else -> "IN"
        }

        var mediaUrl: String? = null
        runCatching {
            val itemUri = ContentUris.withAppendedId(baseUri, id)
            val safeName = displayName.ifBlank { "wa_$id" }.replace(Regex("[^A-Za-z0-9_.\\-]"), "_")
            val tmp = File(context.cacheDir, "wa_${id}_$safeName")
            context.contentResolver.openInputStream(itemUri)?.use { input ->
                tmp.outputStream().use { output -> input.copyTo(output) }
            }
            if (tmp.exists() && tmp.length() > 0) {
                val contentType = when (eventType) {
                    WhatsAppEventType.IMAGE -> "image/jpeg"
                    WhatsAppEventType.VIDEO -> "video/mp4"
                    else -> "audio/ogg"
                }
                val (_, url) = repo.uploadMedia(tmp, "whatsappMedia", contentType)
                mediaUrl = url
            }
            tmp.delete()
        }

        repo.postWhatsAppEvent(
            WhatsAppEvent(
                eventType = eventType,
                contactLabel = contactLabel,
                contactSafe = safe,
                direction = direction,
                mediaUrl = mediaUrl,
                mediaType = kindHint,
                riskFlag = !safe,
                source = "media_scan"
            )
        )
        if (!safe) {
            runCatching { WhatsAppMonitor.maybeAlertMedia(repo, eventType, contactLabel, mediaUrl) }
        }
    }

    private fun classifyFile(name: String, kindHint: String): WhatsAppEventType {
        val upper = name.uppercase()
        return when (kindHint) {
            "image" -> WhatsAppEventType.IMAGE
            "video" -> WhatsAppEventType.VIDEO
            "audio" -> if (upper.startsWith("PTT-") || upper.contains("VOICE")) {
                WhatsAppEventType.VOICE_NOTE
            } else {
                WhatsAppEventType.DOCUMENT
            }
            else -> WhatsAppEventType.DOCUMENT
        }
    }

    private fun trimProcessed() {
        if (processedIds.size <= 300) return
        val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        processedIds.entries.removeIf { it.value < cutoff }
    }

    private fun hasImageVideoPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            hasPerm(Manifest.permission.READ_MEDIA_IMAGES) || hasPerm(Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            hasPerm(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun hasAudioPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            hasPerm(Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            hasPerm(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun hasPerm(perm: String) =
        ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
}
