package com.sarechild.child.monitoring

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val caps = serviceInfo?.capabilities ?: 0
            if (caps and AccessibilityServiceInfo.CAPABILITY_CAN_TAKE_SCREENSHOT == 0) {
                Log.w(
                    TAG,
                    "canTakeScreenshot missing — toggle SareChild accessibility off/on in Settings"
                )
            }
        }
        if (!repo.messageMonitorConsent && !repo.whatsappMonitorConsent && !repo.eventRecorderConsent
            && !repo.screenSnapshotsActive
        ) {
            stopMonitoringService()
            return
        }
        ensureChannel()
        showOngoingNotification()
        ScreenSnapshotCapture.onServiceReady(this, repo)
        scope.launch { refreshRules(force = true) }
    }

    override fun onDestroy() {
        ScreenSnapshotCapture.onServiceGone()
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!repo.messageMonitorConsent && !repo.whatsappMonitorConsent && !repo.eventRecorderConsent
            && !repo.screenSnapshotsActive
        ) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName) return

        if (repo.eventRecorderConsent) {
            when (event.eventType) {
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                    val titleHint = event.text?.joinToString(" ")?.trim()?.takeIf { it.isNotBlank() }
                    EventRecorderMonitor.current()?.onWindowChanged(
                        packageName = pkg,
                        className = event.className?.toString(),
                        titleHint = titleHint
                    )
                }
                AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                    EventRecorderMonitor.current()?.onInteraction(
                        packageName = pkg,
                        contentDescription = event.contentDescription?.toString()
                    )
                }
            }
        }

        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            ScreenSnapshotCapture.updateForegroundApp(pkg, resolveAppLabel(pkg))
        }

        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        ) return
        if (!repo.messageMonitorConsent && !repo.whatsappMonitorConsent) return

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
        var whatsAppAlignment: List<Pair<String, Boolean>> = emptyList()
        val text = if (WhatsAppMonitor.isWhatsApp(pkg)) {
            val screenWidth = resources.displayMetrics.widthPixels
            val capture = collectWhatsAppScreen(root, screenWidth)
            whatsAppAlignment = capture.alignment
            capture.text.trim()
        } else {
            collectText(root).trim()
        }
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

        if (WhatsAppMonitor.isWhatsApp(pkg) && repo.whatsappMonitorConsent) {
            if (!WhatsAppMonitor.isChromeDump(text)) {
                maybeAlertUnidentifiedWhatsapp(pkg, text, assessment.score)
                runCatching { WhatsAppMonitor.recordOnScreenMessage(repo, pkg, text, whatsAppAlignment) }
            }
        }

        if (!repo.messageMonitorConsent) return

        val mode = if (cachedTypingSettings.mode360) "360" else "communication"

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
        if (WhatsAppMonitor.isWhatsApp(pkg) && repo.whatsappMonitorConsent) return true
        if (!repo.messageMonitorConsent) return false
        if (settings.mode360) return true
        return pkg in messagingPackages || settings.alwaysMonitorPackages.contains(pkg)
    }

    private suspend fun maybeAlertUnidentifiedWhatsapp(pkg: String, text: String, riskScore: Int) {
        if (pkg !in setOf("com.whatsapp", "com.whatsapp.w4b")) return
        if (!repo.whatsappMonitorConsent) return
        if (isCategorySnoozed("WHATSAPP_CONTACT")) return
        val candidate = extractContactIdentifier(text) ?: return
        val normalizedCandidate = normalizeIdentifier(candidate)
        if (normalizedCandidate.isBlank()) return
        val safe = loadSafeContactIdentifiers()
        val isSafe = safe.any { WhatsAppMonitor.matchesSafeIdentifier(normalizedCandidate, it) }
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

    /** Text plus a per-line right/left alignment hint, used for [WhatsAppMonitor]'s geometry-based
     *  IN/OUT detection — see [collectWhatsAppScreen]. */
    private data class WhatsAppScreenCapture(val text: String, val alignment: List<Pair<String, Boolean>>)

    /**
     * Preserves line breaks between nodes — WhatsApp chat/contact/status lines parse more
     * reliably. Also records each text-bearing node's horizontal screen position: WhatsApp (like
     * essentially every chat UI) right-aligns bubbles the child sent and left-aligns bubbles they
     * received, which is a far more version/locale-proof "outgoing" signal than matching status
     * words such as "Delivered"/"Read" that may only ever exist as unlabeled tick icons.
     */
    private fun collectWhatsAppScreen(
        node: AccessibilityNodeInfo,
        screenWidth: Int,
        depth: Int = 0
    ): WhatsAppScreenCapture {
        if (depth > 12) return WhatsAppScreenCapture("", emptyList())
        if (node.isPassword) return WhatsAppScreenCapture("", emptyList())
        val parts = mutableListOf<String>()
        val alignment = mutableListOf<Pair<String, Boolean>>()

        val nodeText = node.text?.toString()?.trim()
        if (!nodeText.isNullOrBlank()) {
            parts.add(nodeText)
            rightAlignedOrNull(node, screenWidth)?.let { alignment.add(nodeText to it) }
        }
        node.contentDescription?.let { cd ->
            val cdStr = cd.toString().trim()
            if (cdStr.isNotBlank() && cdStr != nodeText) parts.add(cdStr)
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val childCapture = collectWhatsAppScreen(child, screenWidth, depth + 1)
            if (childCapture.text.isNotBlank()) parts.add(childCapture.text)
            alignment.addAll(childCapture.alignment)
            child.recycle()
        }
        return WhatsAppScreenCapture(parts.joinToString("\n"), alignment)
    }

    /** True if confidently right-aligned, false if confidently left-aligned, null if ambiguous
     *  (near screen center, zero-width, or width unknown) — ambiguous nodes are simply skipped
     *  rather than risking a wrong IN/OUT call. */
    private fun rightAlignedOrNull(node: AccessibilityNodeInfo, screenWidth: Int): Boolean? {
        if (screenWidth <= 0) return null
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        if (bounds.width() <= 0 || bounds.height() <= 0) return null
        val ratio = bounds.centerX().toDouble() / screenWidth
        return when {
            ratio >= 0.55 -> true
            ratio <= 0.45 -> false
            else -> null
        }
    }

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
        if (now - cachedSafeContactsAtMs < 60_000L) return cachedSafeContacts
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
        val title = when {
            repo.screenSnapshotsActive && !repo.messageMonitorConsent && !repo.whatsappMonitorConsent ->
                "Screen snapshots are on"
            repo.whatsappMonitorConsent && repo.messageMonitorConsent -> "Message safety is on"
            repo.whatsappMonitorConsent -> "WhatsApp protection is on"
            else -> "Typing safety is on"
        }
        val text = when {
            repo.screenSnapshotsActive && !repo.messageMonitorConsent && !repo.whatsappMonitorConsent ->
                "Protected by SareChild — periodic screen snapshots for your parent."
            repo.whatsappMonitorConsent && !repo.messageMonitorConsent ->
                "Protected by SareChild — WhatsApp on-screen text may be logged for your parent."
            repo.whatsappMonitorConsent ->
                "Protected by SareChild — messaging apps may be monitored with your consent."
            else ->
                "Protected by SareChild — message shield may report words typed in monitored apps."
        }
        val notification = NotificationCompat.Builder(this, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
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
        private const val TAG = "MessageMonitorA11y"
        private val PHONE_REGEX = Regex("""\+?\d[\d\s\-()]{5,}\d""")

        fun isServiceEnabled(context: android.content.Context): Boolean {
            val flat = android.provider.Settings.Secure.getString(
                context.contentResolver,
                android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: return false
            return flat.contains(context.packageName)
        }
    }
}
