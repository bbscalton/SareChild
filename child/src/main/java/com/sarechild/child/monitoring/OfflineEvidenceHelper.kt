package com.sarechild.child.monitoring

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.sarechild.child.R
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.delay
import java.io.File

object OfflineEvidenceHelper {
    private const val EVIDENCE_DIR = "offline_evidence"
    private var recordingNow = false
    private var offlineCallAttemptsInSession = 0
    private var offlineSessionActive = false

    suspend fun maybeRecordAudioEvidence(context: Context, repo: ChildRepository, networkAvailable: Boolean) {
        if (networkAvailable || recordingNow) return
        if (!repo.micCheckConsent) return
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) return

        val prefs = context.getSharedPreferences(SareChildConstants.PREFS_NAME, Context.MODE_PRIVATE)
        val last = prefs.getLong(SareChildConstants.PREF_LAST_OFFLINE_EVIDENCE_MS, 0L)
        val now = System.currentTimeMillis()
        if (now - last < SareChildConstants.OFFLINE_EVIDENCE_MIN_INTERVAL_MS) return

        recordingNow = true
        ensureChannel(context)
        showRecordingNotification(context)
        try {
            val dir = File(context.filesDir, EVIDENCE_DIR).apply { mkdirs() }
            val file = File(dir, "offline_audio_${now}.m4a")
            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setOutputFile(file.absolutePath)
            rec.prepare()
            rec.start()
            delay(SareChildConstants.MIC_CHECK_SECONDS * 1000L)
            runCatching { rec.stop() }
            runCatching { rec.release() }
            prefs.edit().putLong(SareChildConstants.PREF_LAST_OFFLINE_EVIDENCE_MS, now).apply()
        } catch (_: Exception) {
        } finally {
            recordingNow = false
            context.getSystemService(NotificationManager::class.java)
                .cancel(SareChildConstants.SAFETY_NOTIFICATION_ID)
        }
    }

    suspend fun flushWhenOnline(context: Context, repo: ChildRepository, networkAvailable: Boolean) {
        if (!networkAvailable || recordingNow) return
        val dir = File(context.filesDir, EVIDENCE_DIR)
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".m4a") }?.toList().orEmpty()
        files.sortedBy { it.lastModified() }.forEach { file ->
            runCatching {
                val (_, url) = repo.uploadMedia(file, "offlineEvidence", "audio/mp4")
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.OFFLINE_EVIDENCE,
                        severity = AlertSeverity.HIGH,
                        title = "Offline evidence uploaded — ${repo.childName}",
                        snippet = "Captured while offline; uploaded when internet returned.",
                        mediaUrl = url
                    )
                )
                file.delete()
            }
        }
    }

    suspend fun maybeSendOfflineSmsFallback(
        context: Context,
        repo: ChildRepository,
        networkAvailable: Boolean,
        lat: Double,
        lng: Double
    ) {
        if (networkAvailable) return
        if (!repo.offlineSmsFallbackConsent) return
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) return
        val prefs = context.getSharedPreferences(SareChildConstants.PREFS_NAME, Context.MODE_PRIVATE)
        val last = prefs.getLong(SareChildConstants.PREF_LAST_OFFLINE_SMS_MS, 0L)
        val now = System.currentTimeMillis()
        if (now - last < SareChildConstants.OFFLINE_SMS_FALLBACK_INTERVAL_MS) return

        val contacts = repo.loadSosContacts()
        val numbers = contacts.mapNotNull { extractPhoneNumber(it.phoneNote) }.distinct()
        if (numbers.isEmpty()) return

        val maps = "https://maps.google.com/?q=$lat,$lng"
        val msg =
            "SareChild offline fallback: ${repo.childName} last known location $lat,$lng. " +
                "No internet right now. Map: $maps"
        val sms = SmsManager.getDefault()
        numbers.forEach { number ->
            runCatching { sms.sendTextMessage(number, null, msg, null, null) }
        }
        prefs.edit().putLong(SareChildConstants.PREF_LAST_OFFLINE_SMS_MS, now).apply()
        repo.postAlert(
            FamilyAlert(
                type = AlertType.OFFLINE_EVIDENCE,
                severity = AlertSeverity.HIGH,
                title = "Offline SMS fallback sent — ${repo.childName}",
                snippet = "Location SMS sent to ${numbers.size} emergency contact(s)."
            )
        )
    }

    suspend fun maybePlaceOfflineAutoCall(context: Context, repo: ChildRepository, networkAvailable: Boolean) {
        if (networkAvailable) {
            offlineSessionActive = false
            offlineCallAttemptsInSession = 0
            return
        }
        if (!offlineSessionActive) {
            offlineSessionActive = true
            offlineCallAttemptsInSession = 0
        }
        if (!repo.offlineAutoCallConsent) return
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) !=
            PackageManager.PERMISSION_GRANTED
        ) return
        val (enabled, numberRaw, maxAttempts) = repo.loadOfflineCallConfig()
        if (!enabled || maxAttempts <= 0) return
        if (offlineCallAttemptsInSession >= maxAttempts) return
        val number = extractPhoneNumber(numberRaw.orEmpty()) ?: return

        val prefs = context.getSharedPreferences(SareChildConstants.PREFS_NAME, Context.MODE_PRIVATE)
        val last = prefs.getLong(SareChildConstants.PREF_LAST_OFFLINE_CALL_MS, 0L)
        val now = System.currentTimeMillis()
        if (now - last < SareChildConstants.OFFLINE_CALL_FALLBACK_INTERVAL_MS) return

        runCatching {
            val callIntent = Intent(Intent.ACTION_CALL).apply {
                data = Uri.parse("tel:$number")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(callIntent)
            offlineCallAttemptsInSession += 1
            prefs.edit().putLong(SareChildConstants.PREF_LAST_OFFLINE_CALL_MS, now).apply()
            repo.postAlert(
                FamilyAlert(
                    type = AlertType.OFFLINE_EVIDENCE,
                    severity = AlertSeverity.HIGH,
                    title = "Offline auto-call attempt — ${repo.childName}",
                    snippet = "Attempt ${offlineCallAttemptsInSession} of $maxAttempts to $number"
                )
            )
        }
    }

    private fun showRecordingNotification(context: Context) {
        val n = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Offline evidence recording")
            .setContentText("SareChild is recording a short visible safety clip.")
            .setOngoing(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.SAFETY_NOTIFICATION_ID, n)
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                    "Visible safety checks",
                    NotificationManager.IMPORTANCE_HIGH
                )
            )
        }
    }

    private fun extractPhoneNumber(raw: String): String? {
        val cleaned = raw.filter { it.isDigit() || it == '+' }
        return if (cleaned.count { it.isDigit() } >= 7) cleaned else null
    }
}
