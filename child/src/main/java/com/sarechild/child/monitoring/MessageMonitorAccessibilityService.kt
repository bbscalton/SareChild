package com.sarechild.child.monitoring

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationCompat
import com.sarechild.child.R
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
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

/**
 * Consent-gated on-screen text monitor for messaging apps.
 * Does NOT read encrypted chat databases — only currently visible UI text.
 */
class MessageMonitorAccessibilityService : AccessibilityService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var repo: ChildRepository
    @Volatile private var classifier: RiskClassifier = RiskClassifier()
    private val recent = ConcurrentHashMap<String, Long>()
    private val recentUnidentified = ConcurrentHashMap<String, Long>()
    @Volatile private var cachedSafeContacts: List<String> = emptyList()
    @Volatile private var cachedSafeContactsAtMs: Long = 0L
    @Volatile private var cachedSettings: FamilySafetySettings = FamilySafetySettings()
    @Volatile private var cachedSettingsAtMs: Long = 0L

    private val messagingPackages = setOf(
        "com.whatsapp",
        "com.whatsapp.w4b",
        "org.telegram.messenger",
        "org.telegram.messenger.web",
        "org.thunderdog.challegram",
        "com.instagram.android",
        "com.snapchat.android",
        "com.facebook.orca",
        "com.facebook.mlite",
        "com.discord",
        "com.viber.voip",
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.android.mms"
    )

    override fun onServiceConnected() {
        super.onServiceConnected()
        repo = ChildRepository(this)
        if (!repo.messageMonitorConsent) {
            stopMonitoringService()
            return
        }
        ensureChannel()
        showOngoingNotification()
        scope.launch {
            runCatching {
                val matcher = repo.loadKeywordMatcher()
                classifier = RiskClassifier(matcher)
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!repo.messageMonitorConsent) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg !in messagingPackages) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        ) return

        val root = rootInActiveWindow ?: return
        val text = collectText(root).trim()
        root.recycle()
        if (text.length < 4) return

        val key = "$pkg|${text.hashCode()}"
        val now = System.currentTimeMillis()
        val last = recent[key]
        if (last != null && now - last < 45_000L) return
        recent[key] = now
        recent.entries.removeIf { now - it.value > 10 * 60_000L }

        val assessment = classifier.assess(text)
        val snippet = text.take(180)
        scope.launch {
            maybeAlertUnidentifiedWhatsapp(pkg, text, assessment.score)
            if (assessment.score > 0) {
                if (isCategorySnoozed("KEYWORD")) return@launch
                assessment.hits.forEach { hit ->
                    repo.postAlert(
                        FamilyAlert(
                            type = AlertType.KEYWORD,
                            severity = assessment.severity,
                            title = "On-screen risk (${hit.category.name.lowercase()})",
                            snippet = snippet,
                            category = hit.category.name,
                            riskScore = assessment.score
                        )
                    )
                }
                if (assessment.hits.isEmpty()) {
                    repo.postAlert(
                        FamilyAlert(
                            type = AlertType.KEYWORD,
                            severity = assessment.severity,
                            title = "On-screen pattern risk — ${repo.childName}",
                            snippet = snippet,
                            category = "PATTERN",
                            riskScore = assessment.score
                        )
                    )
                }
            }
        }
    }

    private suspend fun maybeAlertUnidentifiedWhatsapp(pkg: String, text: String, riskScore: Int) {
        if (pkg !in setOf("com.whatsapp", "com.whatsapp.w4b")) return
        if (isCategorySnoozed("WHATSAPP_CONTACT")) return
        val candidate = extractContactIdentifier(text) ?: return
        val normalizedCandidate = normalizeIdentifier(candidate)
        if (normalizedCandidate.isBlank()) return
        val safe = loadSafeContactIdentifiers()
        val isSafe = safe.any { normalizedSafe ->
            normalizedSafe.isNotBlank() &&
                (normalizedCandidate.contains(normalizedSafe) || normalizedSafe.contains(normalizedCandidate))
        }
        if (isSafe) return
        val key = "$pkg|$normalizedCandidate"
        val now = System.currentTimeMillis()
        val last = recentUnidentified[key]
        if (last != null && now - last < 5 * 60_000L) return
        recentUnidentified[key] = now
        recentUnidentified.entries.removeIf { now - it.value > 30 * 60_000L }
        val severity = when {
            riskScore >= 50 -> AlertSeverity.HIGH
            riskScore >= 20 -> AlertSeverity.MEDIUM
            else -> AlertSeverity.LOW
        }
        repo.postAlert(
            FamilyAlert(
                type = AlertType.UNIDENTIFIED_CONTACT,
                severity = severity,
                title = "Unidentified WhatsApp contact — ${repo.childName}",
                snippet = "Contact '$candidate' not in safe list. ${text.take(140)}",
                category = "WHATSAPP_CONTACT",
                riskScore = riskScore.takeIf { it > 0 }
            )
        )
    }

    override fun onInterrupt() {}

    private fun collectText(node: AccessibilityNodeInfo, depth: Int = 0): String {
        if (depth > 12) return ""
        val sb = StringBuilder()
        node.text?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
        node.contentDescription?.let { if (it.isNotBlank()) sb.append(it).append(' ') }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            sb.append(collectText(child, depth + 1))
            child.recycle()
        }
        return sb.toString()
    }

    private fun extractContactIdentifier(text: String): String? {
        val phone = PHONE_REGEX.find(text)?.value
        if (!phone.isNullOrBlank()) return phone
        val firstLine = text.lineSequence().firstOrNull()?.trim().orEmpty()
        return firstLine.takeIf { it.length >= 3 && !it.equals("whatsapp", true) }
    }

    private fun normalizeIdentifier(value: String): String {
        return value.lowercase().replace(Regex("[^a-z0-9+]"), "")
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

    private fun showOngoingNotification() {
        val notification = NotificationCompat.Builder(this, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Message monitoring on")
            .setContentText("Protected by SareChild — on-screen message previews may be shared.")
            .setOngoing(true)
            .build()
        getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.MESSAGE_MONITOR_NOTIFICATION_ID, notification)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                "Visible safety checks",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun stopMonitoringService() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            disableSelf()
        }
    }

    companion object {
        private val PHONE_REGEX = Regex("""\+?\d[\d\s\-()]{5,}\d""")
    }
}
