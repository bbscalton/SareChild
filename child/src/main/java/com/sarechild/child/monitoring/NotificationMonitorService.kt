package com.sarechild.child.monitoring

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
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
    private val recentUnidentified = ConcurrentHashMap<String, Long>()
    @Volatile private var cachedSafeContacts: List<String> = emptyList()
    @Volatile private var cachedSafeContactsAtMs: Long = 0L
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
        scope.launch {
            maybeAlertUnidentifiedWhatsappContact(sbn.packageName, title, text, combined, assessment.score)
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

    private suspend fun maybeAlertUnidentifiedWhatsappContact(
        packageNameValue: String,
        title: String,
        text: String,
        combined: String,
        riskScore: Int
    ) {
        if (packageNameValue !in setOf("com.whatsapp", "com.whatsapp.w4b")) return
        if (isCategorySnoozed("WHATSAPP_CONTACT")) return
        val candidate = extractContactIdentifier(title, text) ?: return
        val normalizedCandidate = normalizeIdentifier(candidate)
        if (normalizedCandidate.isBlank()) return
        val safe = loadSafeContactIdentifiers()
        val isSafe = safe.any { normalizedSafe ->
            normalizedSafe.isNotBlank() &&
                (normalizedCandidate.contains(normalizedSafe) || normalizedSafe.contains(normalizedCandidate))
        }
        if (isSafe) return

        val key = "${packageNameValue}|$normalizedCandidate"
        val now = System.currentTimeMillis()
        val last = recentUnidentified[key]
        if (last != null && now - last < 5 * 60_000L) return
        recentUnidentified[key] = now
        recentUnidentified.entries.removeIf { now - it.value > 30 * 60_000L }

        val severity = when {
            riskScore >= 50 -> com.sarechild.shared.AlertSeverity.HIGH
            riskScore >= 20 -> com.sarechild.shared.AlertSeverity.MEDIUM
            else -> com.sarechild.shared.AlertSeverity.LOW
        }
        repo.postAlert(
            FamilyAlert(
                type = AlertType.UNIDENTIFIED_CONTACT,
                severity = severity,
                title = "Unidentified WhatsApp contact — ${repo.childName}",
                snippet = "Contact '$candidate' is not in safe list. ${combined.take(140)}",
                category = "WHATSAPP_CONTACT",
                riskScore = riskScore.takeIf { it > 0 }
            )
        )
    }

    private fun extractContactIdentifier(title: String, text: String): String? {
        val phone = PHONE_REGEX.find("$title $text")?.value
        if (!phone.isNullOrBlank()) return phone
        return title.trim().takeIf { it.isNotBlank() && !it.equals("WhatsApp", ignoreCase = true) }
    }

    private fun normalizeIdentifier(value: String): String {
        return value.lowercase()
            .replace(Regex("[^a-z0-9+]"), "")
    }

    private suspend fun loadSafeContactIdentifiers(): List<String> {
        val now = System.currentTimeMillis()
        if (now - cachedSafeContactsAtMs < 60_000L && cachedSafeContacts.isNotEmpty()) return cachedSafeContacts
        val identifiers = repo.loadSafeContacts("WHATSAPP")
            .map { normalizeIdentifier(it.identifier) }
            .filter { it.isNotBlank() }
        cachedSafeContacts = identifiers
        cachedSafeContactsAtMs = now
        return identifiers
    }

    private suspend fun isCategorySnoozed(category: String): Boolean {
        val now = System.currentTimeMillis()
        if (now - cachedSettingsAtMs > 60_000L) {
            cachedSettings = repo.loadSafetySettings()
            cachedSettingsAtMs = now
        }
        return now < cachedSettings.snoozeUntilMs && cachedSettings.snoozedCategories.contains(category)
    }

    companion object {
        private val PHONE_REGEX = Regex("""\+?\d[\d\s\-()]{5,}\d""")
    }
}
