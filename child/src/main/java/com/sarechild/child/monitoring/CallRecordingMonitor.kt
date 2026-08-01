package com.sarechild.child.monitoring

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.CallRecordingType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.Executor

/**
 * Best-effort cellular call recording using native Android APIs (not Cordova).
 * Listens to phone state; on OFFHOOK starts [MediaRecorder] with the best audio source
 * the OS allows. On Android 10+ full uplink+downlink capture is often blocked — we still
 * log call events even when audio capture fails.
 */
class CallRecordingMonitor(
    private val context: Context,
    private val repo: ChildRepository,
    private val scope: CoroutineScope
) {
    private val telephony = context.getSystemService(TelephonyManager::class.java)
    private var recorder: MediaRecorder? = null
    private var recordingFile: File? = null
    private var audioSourceUsed: String? = null
    private var callStartMs = 0L
    private var incomingNumber: String? = null
    private var wasOffHook = false
    private var wasRinging = false
    private var lastState = TelephonyManager.CALL_STATE_IDLE

    @Suppress("DEPRECATION")
    private val legacyListener = object : PhoneStateListener() {
        override fun onCallStateChanged(state: Int, phoneNumber: String?) {
            handleStateChange(state, phoneNumber)
        }
    }

    private var telephonyCallback: TelephonyCallback? = null

    fun start() {
        if (!repo.callRecordingConsent || !repo.callRecordingEnabled) return
        if (!hasPhoneStatePermission()) return
        registerListener()
    }

    fun stop() {
        unregisterListener()
        scope.launch {
            stopRecording(upload = false)
        }
    }

    fun refresh() {
        stop()
        start()
    }

    private fun registerListener() {
        unregisterListener()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val executor = Executor { it.run() }
            val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) {
                    handleStateChange(state, null)
                }
            }
            telephonyCallback = callback
            telephony?.registerTelephonyCallback(executor, callback)
        } else {
            @Suppress("DEPRECATION")
            telephony?.listen(legacyListener, PhoneStateListener.LISTEN_CALL_STATE)
        }
    }

    private fun unregisterListener() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            telephonyCallback?.let { telephony?.unregisterTelephonyCallback(it) }
            telephonyCallback = null
        } else {
            @Suppress("DEPRECATION")
            telephony?.listen(legacyListener, PhoneStateListener.LISTEN_NONE)
        }
    }

    private fun handleStateChange(state: Int, phoneNumber: String?) {
        if (!phoneNumber.isNullOrBlank()) incomingNumber = phoneNumber
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> {
                wasRinging = true
                lastState = state
            }
            TelephonyManager.CALL_STATE_OFFHOOK -> {
                if (!wasOffHook) {
                    wasOffHook = true
                    callStartMs = System.currentTimeMillis()
                    scope.launch { startRecording() }
                }
                lastState = state
            }
            TelephonyManager.CALL_STATE_IDLE -> {
                if (wasRinging && !wasOffHook) {
                    scope.launch {
                        repo.postCallRecording(
                            callType = CallRecordingType.MISSED,
                            direction = "IN",
                            numberMasked = maskNumber(incomingNumber),
                            durationSec = 0,
                            audioUrl = null,
                            audioCaptured = false,
                            audioSourceNote = "missed_call_event"
                        )
                    }
                } else if (wasOffHook) {
                    scope.launch { finishCall() }
                }
                wasRinging = false
                wasOffHook = false
                incomingNumber = null
                lastState = state
            }
        }
    }

    private suspend fun startRecording() {
        if (!hasRecordAudioPermission()) {
            logEventOnly("mic_permission_denied")
            return
        }
        val file = File(context.cacheDir, "call_cell_${System.currentTimeMillis()}.m4a")
        recordingFile = file
        val (rec, source) = createRecorder(file) ?: run {
            logEventOnly("recorder_init_failed")
            return
        }
        recorder = rec
        audioSourceUsed = source
        try {
            rec.prepare()
            rec.start()
        } catch (e: Exception) {
            releaseRecorder()
            logEventOnly("recorder_start_failed:${e.message?.take(40)}")
        }
    }

    private suspend fun finishCall() {
        val file = recordingFile
        val durationSec = ((System.currentTimeMillis() - callStartMs) / 1000L).toInt().coerceAtLeast(0)
        val captured = stopRecording(upload = false)
        if (file != null && captured && file.exists() && file.length() > 512) {
            runCatching {
                val (_, url) = repo.uploadMedia(file, "callRecordings", "audio/mp4")
                repo.postCallRecording(
                    callType = CallRecordingType.CELLULAR,
                    direction = "UNKNOWN",
                    numberMasked = maskNumber(incomingNumber),
                    durationSec = durationSec,
                    audioUrl = url,
                    audioCaptured = true,
                    audioSourceNote = audioSourceUsed
                )
            }.onFailure {
                logEventOnly("upload_failed:${it.message?.take(40)}")
            }
            file.delete()
        } else {
            logEventOnly(audioSourceUsed ?: "no_audio_captured")
        }
        recordingFile = null
        audioSourceUsed = null
    }

    private suspend fun logEventOnly(note: String) {
        val durationSec = if (callStartMs > 0) {
            ((System.currentTimeMillis() - callStartMs) / 1000L).toInt().coerceAtLeast(0)
        } else 0
        repo.postCallRecording(
            callType = if (note.startsWith("missed")) CallRecordingType.MISSED else CallRecordingType.CELLULAR,
            direction = "UNKNOWN",
            numberMasked = maskNumber(incomingNumber),
            durationSec = durationSec,
            audioUrl = null,
            audioCaptured = false,
            audioSourceNote = note
        )
    }

    private fun createRecorder(file: File): Pair<MediaRecorder, String>? {
        val sources = buildList {
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
                add(MediaRecorder.AudioSource.VOICE_CALL to "voice_call")
            }
            add(MediaRecorder.AudioSource.VOICE_COMMUNICATION to "voice_communication")
            add(MediaRecorder.AudioSource.MIC to "mic_only")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                add(MediaRecorder.AudioSource.VOICE_RECOGNITION to "voice_recognition")
            }
        }
        for ((source, label) in sources) {
            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            try {
                rec.setAudioSource(source)
                rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                rec.setOutputFile(file.absolutePath)
                return rec to label
            } catch (_: Exception) {
                try {
                    rec.release()
                } catch (_: Exception) {
                }
            }
        }
        return null
    }

    private fun stopRecording(upload: Boolean): Boolean {
        var ok = false
        try {
            recorder?.stop()
            ok = true
        } catch (_: Exception) {
        }
        releaseRecorder()
        return ok
    }

    private fun releaseRecorder() {
        try {
            recorder?.release()
        } catch (_: Exception) {
        }
        recorder = null
    }

    private fun maskNumber(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val digits = raw.filter { it.isDigit() }
        if (digits.length <= 4) return "****"
        return "****${digits.takeLast(4)}"
    }

    private fun hasPhoneStatePermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasRecordAudioPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}
