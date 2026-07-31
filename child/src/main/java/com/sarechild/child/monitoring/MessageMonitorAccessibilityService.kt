package com.sarechild.child.monitoring

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
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
import com.sarechild.shared.TypingSafetyEvent
import com.sarechild.shared.TypingSafetySettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * "Typing safety / message shield" — a consent-gated on-screen text monitor.
 *
 * Honesty about what this is and isn't: this is NOT a keylogger. It never captures individual
 * keystrokes, it never reads password/PIN fields ([AccessibilityNodeInfo.isPassword] is checked
 * and skipped before any text is collected), and it never touches an app's encrypted database —
 * it only reads on-screen text that Android's Accessibility API already exposes to any granted
 * accessibility service, the same API screen readers use. Text is captured once per "settle"
 * (a short debounce after typing pauses), not per keystroke, so this behaves like a periodic
 * screenshot-of-text rather than a stream of every key pressed. Requires the child's explicit
 * "Typing safety" consent (see ConsentActivity) plus the OS-level Accessibility permission grant,
 * both of which show a persistent "Protected by SareChild" notification while active.
 */
class MessageMonitorAccessibilityService : AccessibilityService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var repo: ChildRepository
    @Volatile private var classifier: RiskClassifier = RiskClassifier()
    private val recentUnidentified = ConcurrentHashMap<String, Long>()
    private val lastCapturedHash = ConcurrentHashMap<String, Long>()
    private val pendingCaptures = ConcurrentHashMap<String, Job>()
    private val appLabelCache = ConcurrentHashMap<String, String>()
    @Volatile private var cachedSafeContacts: List<String> = emptyList()
    @Volatile private var cachedSafeContactsAtMs: Long = 0L
    @Volatile private var cachedSettings: FamilySafetySettings = FamilySafetySettings()
    @Volatile private var cachedSettingsAtMs: Long = 0L
    @Volatile private var cachedTypingSettings: TypingSafetySettings = TypingSafetySettings()
    @Volatile private var cachedTypingSettingsAtMs: Long = 0L

    /** Heuristic "communication app" list used when 360 mode is off — messaging/social apps only. */
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
        "com.facebook.katana",
        "com.discord",
        "com.viber.voip",
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.android.mms",
        "com.skype.raider",
        "com.kakao.talk",
        "jp.naver.line.android",
        "com.tencent.mm"
    )

    /**
     * Never monitored, regardless of parent settings: our own app, the system keyboard(s), and
     * the Settings app. Prevents both a nonsensical "SareChild reads its own screen" loop and
     * accidental capture of the on-screen keyboard's own accessibility nodes.
     */
    private val hardWhitelist = setOf(
        "com.android.settings",
        "com.google.android.inputmethod.latin",
        "com.android.inputmethod.latin",
        "com.samsung.android.honeyboard",
        "com.touchtype.swiftkey",
        "com.google.android.googlequicksearchbox",
        "com.android.systemui",
        "com.android.launcher3"
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
        scope.launch { refreshRules(force = true) }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!repo.messageMonitorConsent) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        ) return

        scope.launch {
            refreshRules(force = false)
            if (!shouldMonitor(pkg, cachedTypingSettings)) return@launch
            scheduleCapture(pkg)
        }
    }

    /** Debounces rapid-fire accessibility events into a single capture per settle. */
    private fun scheduleCapture(pkg: String) {
        pendingCaptures[pkg]?.cancel()
        pendingCaptures[pkg] = scope.launch {
            delay(SareChildConstants.TYPING_SAFETY_DEBOUNCE_MS)
            runCatching { captureAndProcess(pkg) }
        }
    }

    private suspend fun captureAndProcess(pkg: String) {
        val root = rootInActiveWindow ?: return
        if (root.packageName?.toString() != pkg) {
            root.recycle()
            return
        }
        val text = collectText(root).trim()
        root.recycle()
        if (text.length < 4) return

        val now = System.currentTimeMillis()
        val hashKey = "$pkg|${text.hashCode()}"
        val lastSeen = lastCapturedHash[hashKey]
        if (lastSeen != null && now - lastSeen < SareChildConstants.TYPING_SAFETY_DEDUPE_MS) return
        lastCapturedHash[hashKey] = now
        lastCapturedHash.entries.removeIf { now - it.value > 10 * 60_000L }

        val appLabel = resolveAppLabel(pkg)
        val assessment = classifier.assess(text)
        val snippet = text.take(SareChildConstants.TYPING_SAFETY_SNIPPET_MAX)
        val mode = if (cachedTypingSettings.mode360) "360" else "communication"

        maybeAlertUnidentifiedWhatsapp(pkg, text, assessment.score)
        runCatching { WhatsAppMonitor.recordOnScreenMessage(repo, pkg, text) }

        runCatching {
            repo.postTypingEvent(
                TypingSafetyEvent(
                    packageName = pkg,
                    appLabel = appLabel,
                    snippet = snippet,
                    matchedWords = assessment.hits.map { it.phrase }.distinct(),
                    category = assessment.hits.firstOrNull()?.category?.name,
                    severity = assessment.severity,
                    riskScore = assessment.score,
                    mode = mode
                )
            )
        }

        if (assessment.score > 0 && assessment.hits.isNotEmpty()) {
            if (isCategorySnoozed("TYPING_SAFETY")) return
            val matched = assessment.hits.map { it.phrase }.distinct()
            repo.postAlert(
                FamilyAlert(
                    type = AlertType.TYPING_SAFETY,
                    severity = assessment.severity,
                    title = "Typing safety flag in $appLabel — ${repo.childName}",
                    // Deliberately a short "app + matched words" summary, not the raw typed text —
                    // the full snippet lives in the Typing safety timeline for a parent who opens it.
                    snippet = "Matched: ${matched.joinToString(limit = 5) { it }}",
                    category = assessment.hits.first().category.name,
                    riskScore = assessment.score
                )
            )
            maybeAutoBlock(pkg, appLabel, assessment.severity)
        }
    }

    private suspend fun maybeAutoBlock(pkg: String, appLabel: String, severity: AlertSeverity) {
        val settings = cachedTypingSettings
        if (!settings.autoBlockEnabled) return
        if (severity.ordinal < settings.autoBlockSeverity.ordinal) return
        runCatching {
            repo.blockAppNow(pkg, appLabel, "typing_safety_auto")
            repo.postAlert(
                FamilyAlert(
                    type = AlertType.APP_BLOCKED,
                    severity = AlertSeverity.HIGH,
                    title = "$appLabel auto-blocked — ${repo.childName}",
                    snippet = "Blocked automatically after a $severity typing safety flag.",
                    category = "TYPING_SAFETY_AUTO_BLOCK"
                )
            )
        }
    }

    /** Communication-app heuristic (or 360 mode) minus hard/parent whitelists — never passwords. */
    private fun shouldMonitor(pkg: String, settings: TypingSafetySettings): Boolean {
        if (pkg in hardWhitelist) return false
        if (settings.whitelistPackages.contains(pkg)) return false
        if (settings.mode360) return true
        return pkg in messagingPackages || settings.alwaysMonitorPackages.contains(pkg)
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

    /** Skips password/PIN/secure fields entirely — their text is never read, even transiently. */
    private fun collectText(node: AccessibilityNodeInfo, depth: Int = 0): String {
        if (depth > 12) return ""
        if (node.isPassword) return ""
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

    private fun resolveAppLabel(pkg: String): String {
        appLabelCache[pkg]?.let { return it }
        val label = runCatching {
            val pm: PackageManager = packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg)
        appLabelCache[pkg] = label
        return label
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

    /** Refreshes the Typing safety rules + prohibited-word matcher at most once a minute. */
    private suspend fun refreshRules(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - cachedTypingSettingsAtMs < 60_000L) return
        cachedTypingSettingsAtMs = now
        runCatching {
            val settings = repo.loadTypingSafetySettings()
            cachedTypingSettings = settings
            classifier = RiskClassifier(repo.loadKeywordMatcher(settings.prohibitedWords))
        }
    }

    private fun showOngoingNotification() {
        val notification = NotificationCompat.Builder(this, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Typing safety is on")
            .setContentText("Protected by SareChild — message shield may report words typed in monitored apps.")
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
