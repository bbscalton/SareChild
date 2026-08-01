package com.sarechild.child.monitoring

import android.app.Notification
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilySafetySettings
import com.sarechild.shared.KeywordMatcher
import com.sarechild.shared.RiskClassifier
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class NotificationMonitorService : NotificationListenerService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var repo: ChildRepository
    @Volatile private var classifier: RiskClassifier = RiskClassifier()
    private val recentHashes = ConcurrentHashMap<String, Long>()
    @Volatile private var cachedSettings: FamilySafetySettings = FamilySafetySettings()
    @Volatile private var cachedSettingsAtMs: Long = 0L

    override fun onCreate() {
        super.onCreate()
        repo = ChildRepository(this)
        scope.launch {
            runCatching {
                val matcher = repo.loadKeywordMatcher()
                classifier = RiskClassifier(matcher)
            }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        if (sbn.packageName == packageName) return
        val extras = sbn.notification.extras ?: return
        val title = notificationTitle(extras)
        val text = notificationBody(extras)
        val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
        val combined = listOf(title, text, big).filter { it.isNotBlank() }.joinToString(" — ")
        if (combined.isBlank()) return

        val dedupeKey = "${sbn.packageName}|${combined.hashCode()}"
        val now = System.currentTimeMillis()
        val last = recentHashes[dedupeKey]
        if (last != null && now - last < 60_000L) return
        recentHashes[dedupeKey] = now
        recentHashes.entries.removeIf { now - it.value > 10 * 60_000L }

        val assessment = classifier.assess(combined)

        if (WhatsAppMonitor.isWhatsApp(sbn.packageName)) {
            scope.launch {
                runCatching {
                    WhatsAppMonitor.handleNotification(
                        context = applicationContext,
                        repo = repo,
                        packageName = sbn.packageName,
                        title = title,
                        text = text,
                        big = big,
                        riskScore = assessment.score
                    )
                }
            }
        }

        if (repo.eventRecorderConsent && EventRecorderMonitor.isMediaNotificationPackage(sbn.packageName)) {
            EventRecorderMonitor.current()?.onNotificationMedia(sbn.packageName, title, text)
        }

        // VoIP call recording (mic-side partial) — native Android, not Cordova.
        if (VoipCallRecordingHelper.isVoipPackage(sbn.packageName)) {
            scope.launch {
                runCatching {
                    VoipCallRecordingHelper.handleNotification(
                        context = applicationContext,
                        repo = repo,
                        packageName = sbn.packageName,
                        title = title,
                        text = text,
                        big = big
                    )
                }
            }
        }

        if (assessment.score <= 0) return

        scope.launch {
            if (isCategorySnoozed("KEYWORD")) return@launch
            val snippet = combined.take(160)
            assessment.hits.forEach { hit ->
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.KEYWORD,
                        severity = assessment.severity,
                        title = "Risk detected (${hit.category.name.lowercase()})",
                        snippet = snippet,
                        category = hit.category.name,
                        riskScore = assessment.score
                    )
                )
            }
            if (assessment.hits.isEmpty() && assessment.score >= SareChildConstants.MESSAGE_PREVIEW_MIN_RISK_SCORE) {
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.KEYWORD,
                        severity = assessment.severity,
                        title = "Pattern risk detected",
                        snippet = snippet + (assessment.reasons.firstOrNull()?.let { " · $it" } ?: ""),
                        category = "PATTERN",
                        riskScore = assessment.score
                    )
                )
            }
        }
    }

    private suspend fun isCategorySnoozed(category: String): Boolean {
        val now = System.currentTimeMillis()
        if (now - cachedSettingsAtMs > 60_000L) {
            cachedSettings = repo.loadSafetySettings()
            cachedSettingsAtMs = now
        }
        return now < cachedSettings.snoozeUntilMs && cachedSettings.snoozedCategories.contains(category)
    }

    /** MessagingStyle notifications often put the sender in conversation title, not EXTRA_TITLE. */
    private fun notificationTitle(extras: Bundle): String {
        val direct = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        if (direct.isNotBlank()) return direct
        return extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString().orEmpty()
    }

    private fun notificationBody(extras: Bundle): String {
        val direct = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        if (direct.isNotBlank()) return direct
        val summary = extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT)?.toString().orEmpty()
        if (summary.isNotBlank()) return summary
        val info = extras.getCharSequence(Notification.EXTRA_INFO_TEXT)?.toString().orEmpty()
        if (info.isNotBlank()) return info
        @Suppress("DEPRECATION")
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (messages != null && messages.isNotEmpty()) {
            val parts = mutableListOf<String>()
            for (raw in messages) {
                val msg = raw as? Bundle ?: continue
                val sender = msg.getCharSequence("sender")?.toString().orEmpty()
                val text = msg.getCharSequence("text")?.toString().orEmpty()
                when {
                    text.isNotBlank() && sender.isNotBlank() -> parts.add("$sender: $text")
                    text.isNotBlank() -> parts.add(text)
                }
            }
            if (parts.isNotEmpty()) return parts.last()
        }
        @Suppress("DEPRECATION")
        val lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (lines != null) {
            for (line in lines.reversed()) {
                val s = line?.toString().orEmpty()
                if (s.isNotBlank()) return s
            }
        }
        return ""
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        if (sbn == null) return
        if (VoipCallRecordingHelper.isVoipPackage(sbn.packageName)) {
            VoipCallRecordingHelper.onNotificationRemoved(sbn.packageName)
        }
    }

    companion object {
        fun isEnabled(context: android.content.Context): Boolean {
            val flat = android.provider.Settings.Secure.getString(
                context.contentResolver,
                "enabled_notification_listeners"
            )
            return flat?.contains(context.packageName) == true
        }
    }
}
