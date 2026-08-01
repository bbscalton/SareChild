package com.sarechild.child.monitoring

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import androidx.core.content.ContextCompat
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.CallRecordingType
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Best-effort VoIP call handling via notification detection (native Android — not Cordova).
 * While a VoIP call notification is active, records mic-side audio only. Full two-way VoIP
 * recording is not reliably possible on modern Android without OEM/root hacks.
 */
object VoipCallRecordingHelper {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val activeSessions = ConcurrentHashMap<String, VoipSession>()

    private val VOIP_PACKAGES = setOf(
        SareChildConstants.WHATSAPP_PACKAGE,
        SareChildConstants.WHATSAPP_BUSINESS_PACKAGE,
        "org.telegram.messenger",
        "com.skype.raider",
        "us.zoom.videomeetings",
        "com.google.android.apps.meetings",
        "com.facebook.orca",
        "com.discord",
        "com.viber.voip",
        "com.google.android.apps.tachyon"
    )

    private val ACTIVE_CALL_PHRASES = listOf(
        "ongoing voice call",
        "ongoing video call",
        "voice call",
        "video call",
        "incoming call",
        "call in progress",
        "calling…",
        "calling..."
    )

    private val END_CALL_PHRASES = listOf(
        "missed voice call",
        "missed video call",
        "missed call",
        "call ended",
        "call declined"
    )

    data class VoipSession(
        val packageName: String,
        val contactLabel: String,
        val startMs: Long,
        var recorder: MediaRecorder? = null,
        var file: File? = null
    )

    fun isVoipPackage(packageName: String): Boolean = packageName in VOIP_PACKAGES

    fun handleNotification(
        context: Context,
        repo: ChildRepository,
        packageName: String,
        title: String,
        text: String,
        big: String
    ) {
        if (!repo.callRecordingConsent || !repo.callRecordingEnabled) return
        if (!isVoipPackage(packageName)) return
        val combined = listOf(title, text, big).joinToString(" ").lowercase()
        if (combined.isBlank()) return

        if (END_CALL_PHRASES.any { combined.contains(it) }) {
            endSession(context, repo, packageName)
            return
        }
        if (!ACTIVE_CALL_PHRASES.any { combined.contains(it) }) return

        val label = title.ifBlank { text.take(60) }
        if (activeSessions.containsKey(packageName)) return
        startSession(context, repo, packageName, label)
    }

    fun onNotificationRemoved(packageName: String) {
        val session = activeSessions[packageName] ?: return
        // Delay end slightly — notification may flicker during call
        scope.launch {
            kotlinx.coroutines.delay(3_000L)
            if (activeSessions[packageName] === session) {
                endSessionInternal(null, null, packageName)
            }
        }
    }

    private fun startSession(context: Context, repo: ChildRepository, packageName: String, label: String) {
        if (!hasRecordAudio(context)) {
            scope.launch {
                repo.postCallRecording(
                    callType = CallRecordingType.VOIP_PARTIAL,
                    direction = "UNKNOWN",
                    contactLabel = label,
                    packageName = packageName,
                    durationSec = 0,
                    audioUrl = null,
                    audioCaptured = false,
                    audioSourceNote = "mic_permission_denied"
                )
            }
            return
        }
        val file = File(context.cacheDir, "call_voip_${packageName}_${System.currentTimeMillis()}.m4a")
        val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        try {
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setOutputFile(file.absolutePath)
            rec.prepare()
            rec.start()
            activeSessions[packageName] = VoipSession(packageName, label, System.currentTimeMillis(), rec, file)
        } catch (e: Exception) {
            try {
                rec.release()
            } catch (_: Exception) {
            }
            scope.launch {
                repo.postCallRecording(
                    callType = CallRecordingType.VOIP_PARTIAL,
                    direction = "UNKNOWN",
                    contactLabel = label,
                    packageName = packageName,
                    durationSec = 0,
                    audioUrl = null,
                    audioCaptured = false,
                    audioSourceNote = "voip_recorder_failed:${e.message?.take(30)}"
                )
            }
        }
    }

    private fun endSession(context: Context?, repo: ChildRepository?, packageName: String) {
        endSessionInternal(context, repo, packageName)
    }

    private fun endSessionInternal(context: Context?, repo: ChildRepository?, packageName: String) {
        val session = activeSessions.remove(packageName) ?: return
        val durationSec = ((System.currentTimeMillis() - session.startMs) / 1000L).toInt().coerceAtLeast(0)
        var captured = false
        try {
            session.recorder?.stop()
            captured = true
        } catch (_: Exception) {
        }
        try {
            session.recorder?.release()
        } catch (_: Exception) {
        }
        val file = session.file
        scope.launch {
            val r = repo ?: context?.let { ChildRepository(it) } ?: return@launch
            if (captured && file != null && file.exists() && file.length() > 512) {
                runCatching {
                    val (_, url) = r.uploadMedia(file, "callRecordings", "audio/mp4")
                    r.postCallRecording(
                        callType = CallRecordingType.VOIP_PARTIAL,
                        direction = "UNKNOWN",
                        contactLabel = session.contactLabel,
                        packageName = packageName,
                        durationSec = durationSec,
                        audioUrl = url,
                        audioCaptured = true,
                        audioSourceNote = "mic_only_voip"
                    )
                }.onFailure {
                    r.postCallRecording(
                        callType = CallRecordingType.VOIP_PARTIAL,
                        direction = "UNKNOWN",
                        contactLabel = session.contactLabel,
                        packageName = packageName,
                        durationSec = durationSec,
                        audioUrl = null,
                        audioCaptured = false,
                        audioSourceNote = "upload_failed"
                    )
                }
                file.delete()
            } else {
                r.postCallRecording(
                    callType = CallRecordingType.VOIP_PARTIAL,
                    direction = "UNKNOWN",
                    contactLabel = session.contactLabel,
                    packageName = packageName,
                    durationSec = durationSec,
                    audioUrl = null,
                    audioCaptured = false,
                    audioSourceNote = "voip_event_no_audio"
                )
            }
        }
    }

    fun protectionStatusMap(
        consent: Boolean,
        enabled: Boolean,
        micPermission: Boolean,
        phoneStatePermission: Boolean,
        lastRecordingAtMs: Long
    ): Map<String, Any?> = mapOf(
        "consent" to consent,
        "enabled" to enabled,
        "micPermission" to micPermission,
        "phoneStatePermission" to phoneStatePermission,
        "lastRecordingAtMs" to lastRecordingAtMs,
        "updatedAtMs" to System.currentTimeMillis()
    )

    private fun hasRecordAudio(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}
