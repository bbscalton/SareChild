package com.sarechild.child.monitoring

import android.app.Notification
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
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
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

        // Dedicated WhatsApp protection pipeline: classification, whitelist check, timeline
        // write, and (for non-whitelisted contacts) its own alert — see WhatsAppMonitor.
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
}
