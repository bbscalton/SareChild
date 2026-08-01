package com.sarechild.child.monitoring

import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.FamilySafetySettings
import com.sarechild.shared.SareChildConstants
import com.sarechild.shared.WhatsAppEvent
import com.sarechild.shared.WhatsAppEventType
import java.util.concurrent.ConcurrentHashMap

/**
 * Central, consent-gated home for "everything WhatsApp" on the child device.
 *
 * Honesty about what this can/can't do: WhatsApp's chat database is end-to-end encrypted and is
 * never read here — there is no root, no accessibility scraping beyond what
 * [MessageMonitorAccessibilityService] already does for on-screen text under explicit consent,
 * and no exploit of any kind. Every signal this object records comes from one of:
 *  - [android.service.notification.NotificationListenerService] notification text
 *    (see [NotificationMonitorService]) — requires the notification-access permission the app
 *    already asks for.
 *  - Currently-visible on-screen text via the existing accessibility service, when the child/
 *    parent enabled it.
 *  - MediaStore metadata for newly-added images/video/audio living under a WhatsApp media
 *    folder (see [WhatsAppMediaObserver]) — requires READ_MEDIA_* (API 33+) / legacy storage
 *    permission, both gated behind [ChildRepository.whatsappMonitorConsent].
 *
 * Whitelist rule: a contact/handle that matches a parent-managed `safeContacts` (channel
 * "WHATSAPP") entry is still written to the `whatsappEvents` timeline (with `contactSafe=true`)
 * so the parent's "All" filter is a complete record, but it never raises a [FamilyAlert] and is
 * exempt from the "first sighting" / risk-flag heuristics below.
 */
object WhatsAppMonitor {
    private val WHATSAPP_PACKAGES = setOf(
        SareChildConstants.WHATSAPP_PACKAGE,
        SareChildConstants.WHATSAPP_BUSINESS_PACKAGE
    )
    private val MEDIA_TYPES = setOf(
        WhatsAppEventType.IMAGE,
        WhatsAppEventType.VIDEO,
        WhatsAppEventType.VOICE_NOTE,
        WhatsAppEventType.DOCUMENT
    )
    private val CALL_PHRASES = listOf(
        "missed voice call", "missed video call", "missed call",
        "incoming voice call", "incoming video call",
        "ongoing voice call", "ongoing video call",
        "voice call ended", "video call ended",
        "voice call", "video call",
        "calling…", "calling...", "calling"
    )
    private val WHATSAPP_CHROME_PHRASES = listOf(
        "ask meta ai",
        "ask meta ai or search",
        "inbox filters",
        "communities",
        "start your community",
        "swipe down to reveal",
        "new status update",
        "status updates",
        "archived chats",
        "starred messages",
        "search chats",
        "linked devices",
        "broadcast lists",
        "disappearing messages",
        "view status"
    )
    private val WHATSAPP_INBOX_MARKERS = listOf(
        "inbox filters",
        "communities",
        "ask meta ai"
    )
    private val WHATSAPP_CHROME_TABS = setOf(
        "chats", "updates", "calls", "communities", "status", "camera", "search", "settings"
    )
    /** Delivery-status words WhatsApp exposes in the a11y tree on *sent* bubbles only. */
    private val OUTGOING_STATUS_WORDS = setOf("delivered", "read", "sent", "sending", "pending")
    private val OUTGOING_A11Y_PHRASES = listOf(
        "you sent", "outgoing message", "message sent", "sent message", "message you sent"
    )
    private val COMPOSE_PLACEHOLDERS = listOf(
        "type a message", "message", "add a caption"
    )
    private val CHECKMARK_REGEX = Regex("""[✓✔]{1,2}""")
    private val PHONE_REGEX = Regex("""\+?\d[\d\s\-()]{5,}\d""")
    private const val KNOWN_CONTACTS_PREF_KEY = "whatsapp_known_contact_keys"
    private const val KNOWN_CONTACTS_MAX = 500

    private val recentAlerts = ConcurrentHashMap<String, Long>()
    private val recentEventHashes = ConcurrentHashMap<String, Long>()
    // Suppresses a rare inbound notification echo shortly after we logged the same send as OUT.
    private val recentOutgoingKeys = ConcurrentHashMap<String, Long>()
    // Correlates media-store additions with a contact who just had an outgoing on-screen event.
    private val recentOutgoingContacts = ConcurrentHashMap<String, Long>()
    // Correlates a media-store file addition with whichever contact most recently appeared in
    // a WhatsApp notification for the same package — MediaStore rows carry no contact info.
    private val lastContactByPackage = ConcurrentHashMap<String, Pair<String, Long>>()

    @Volatile private var cachedSafeContacts: List<String> = emptyList()
    @Volatile private var cachedSafeContactsAtMs = 0L
    @Volatile private var cachedSettings: FamilySafetySettings = FamilySafetySettings()
    @Volatile private var cachedSettingsAtMs = 0L

    fun isWhatsApp(packageName: String): Boolean = packageName in WHATSAPP_PACKAGES

    /** Called from the media observer to guess the contact behind a just-added media file. */
    fun recentContactLabel(packageName: String): String? {
        val (label, at) = lastContactByPackage[packageName] ?: return null
        return if (System.currentTimeMillis() - at <= SareChildConstants.WHATSAPP_CONTACT_CORRELATION_MS) {
            label
        } else {
            null
        }
    }

    /** True when [text] looks like a WhatsApp home/inbox accessibility dump, not a real message. */
    fun isChromeDump(text: String): Boolean {
        val lower = text.lowercase().replace(Regex("\\s+"), " ").trim()
        if (lower.isBlank()) return true
        val inboxHits = WHATSAPP_INBOX_MARKERS.count { lower.contains(it) }
        if (inboxHits >= 2) return true
        if (inboxHits >= 1 && lower.length > 180) return true
        if (lower.length > 100 && WHATSAPP_CHROME_PHRASES.any { lower.contains(it) }) {
            val lineCount = segmentLines(text).size
            if (lineCount > 6) return true
        }
        return false
    }

    /** True when a MediaStore path looks like WhatsApp's sent-media folder (best-effort). */
    fun isSentMediaPath(path: String): Boolean {
        val lower = path.lowercase().replace('\\', '/')
        return lower.contains("/whatsapp") && (
            lower.contains("/sent/") ||
                lower.contains("/sent ") ||
                lower.endsWith("/sent")
            )
    }

    /** Recent outgoing on-screen activity for [contactLabel] — used by [WhatsAppMediaObserver]. */
    fun wasRecentOutgoingContact(contactLabel: String): Boolean {
        val key = normalizeIdentifier(contactLabel)
        if (key.isBlank()) return false
        val at = recentOutgoingContacts[key] ?: return false
        return System.currentTimeMillis() - at <= SareChildConstants.WHATSAPP_CONTACT_CORRELATION_MS
    }

    private fun markRecentOutgoing(contact: String, message: String) {
        val now = System.currentTimeMillis()
        val norm = normalizeIdentifier(contact)
        recentOutgoingContacts[norm] = now
        recentOutgoingKeys["$norm|${message.take(80).hashCode()}"] = now
        recentOutgoingKeys.entries.removeIf { now - it.value > 15 * 60_000L }
        recentOutgoingContacts.entries.removeIf { now - it.value > 15 * 60_000L }
    }

    private fun wasRecentOutgoing(contact: String, message: String): Boolean {
        val key = "${normalizeIdentifier(contact)}|${message.take(80).hashCode()}"
        val at = recentOutgoingKeys[key] ?: return false
        return System.currentTimeMillis() - at <= SareChildConstants.WHATSAPP_ONSCREEN_DEDUPE_MS
    }

    private fun segmentLines(raw: String): List<String> {
        val byNewline = raw.lines().map { it.trim() }.filter { it.isNotBlank() }
        if (byNewline.size > 1) return byNewline
        return raw.split(Regex("\\s{2,}"))
            .map { it.trim() }
            .filter { it.isNotBlank() }
    }

    private fun isOutgoingStatusLine(line: String): Boolean {
        val trimmed = line.trim()
        if (trimmed.isBlank()) return false
        if (CHECKMARK_REGEX.matches(trimmed)) return true
        val lower = trimmed.lowercase()
        if (lower in OUTGOING_STATUS_WORDS) return true
        if (lower.startsWith("delivered") || lower.startsWith("read")) return true
        return OUTGOING_A11Y_PHRASES.any { lower.contains(it) }
    }

    /**
     * Best-effort IN vs OUT from on-screen a11y text. Delivered/Read/checkmarks after the last
     * bubble strongly indicate an outgoing send; inbound notifications never carry those markers.
     */
    private fun inferDirection(raw: String, lines: List<String>, message: String, messageIdx: Int): String {
        val lowerRaw = raw.lowercase()
        if (OUTGOING_A11Y_PHRASES.any { lowerRaw.contains(it) }) return "OUT"

        val tail = lines.drop(messageIdx + 1).take(4)
        if (tail.any { isOutgoingStatusLine(it) }) return "OUT"

        val msgPos = raw.lastIndexOf(message)
        if (msgPos >= 0) {
            val afterMsg = raw.substring(msgPos + message.length, minOf(raw.length, msgPos + message.length + 80))
            if (CHECKMARK_REGEX.containsMatchIn(afterMsg)) return "OUT"
            val afterLower = afterMsg.lowercase()
            if (OUTGOING_STATUS_WORDS.any { w -> Regex("""\b$w\b""").containsMatchIn(afterLower) }) return "OUT"
        }

        val lastFew = lines.takeLast(5)
        if (lastFew.any { isOutgoingStatusLine(it) }) {
            val hasActiveCompose = COMPOSE_PLACEHOLDERS.any { lowerRaw.contains(it) } &&
                !lastFew.any { it.equals(message, ignoreCase = true) }
            if (!hasActiveCompose || lastFew.last().let { isOutgoingStatusLine(it) }) return "OUT"
        }

        return "IN"
    }

    /** Requires a dedicated call-status line — avoids misclassifying chat dumps that mention calls. */
    private fun isCallScreen(lines: List<String>): Boolean {
        return lines.any { line ->
            val lower = line.lowercase().trim()
            if (line.length > 100) return@any false
            CALL_PHRASES.any { phrase ->
                lower == phrase ||
                    lower.startsWith("$phrase ") ||
                    lower.endsWith(" $phrase") ||
                    (lower.contains(phrase) && line.length <= 60)
            }
        }
    }

    private fun isChromeLine(line: String): Boolean {
        val lower = line.lowercase().trim()
        if (lower.length <= 2) return true
        if (WHATSAPP_CHROME_PHRASES.any { lower.contains(it) }) return true
        return lower in WHATSAPP_CHROME_TABS
    }

    private fun isTimestampLine(line: String): Boolean {
        val t = line.trim()
        return t.matches(Regex("""^\d{1,2}:\d{2}(\s*[AP]M)?$""", RegexOption.IGNORE_CASE)) ||
            t.matches(
                Regex(
                    """^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday).*$""",
                    RegexOption.IGNORE_CASE
                )
            )
    }

    data class ParsedWhatsAppScreen(
        val contact: String,
        val message: String,
        val eventType: WhatsAppEventType,
        val direction: String = "IN"
    )

    /** Extract contact + last message bubble from on-screen accessibility text. */
    fun parseOnScreenText(raw: String): ParsedWhatsAppScreen? {
        val trimmed = raw.trim()
        if (trimmed.length < 3) return null
        if (isChromeDump(trimmed)) return null

        val lines = segmentLines(trimmed)
            .filter { it.isNotBlank() && !isChromeLine(it) }
        if (lines.isEmpty()) return null

        if (isCallScreen(lines)) {
            val contact = extractCallContact(trimmed)
            val message = lines.firstOrNull { line ->
                CALL_PHRASES.any { line.lowercase().contains(it) }
            }?.take(160) ?: trimmed.take(120)
            return ParsedWhatsAppScreen(contact, message, WhatsAppEventType.CALL)
        }

        val contact = lines.first().let { first ->
            when {
                isTimestampLine(first) || first.length > 60 -> "Unknown contact"
                else -> first
            }
        }

        val messageCandidates = lines.drop(1)
            .mapIndexed { idx, line -> idx + 1 to line }
            .filter { (_, line) -> !isTimestampLine(line) && !isOutgoingStatusLine(line) && line != contact }
        val lastCandidate = messageCandidates.lastOrNull() ?: return null
        val (messageIdx, message) = lastCandidate
        if (message.length < 2) return null
        if (isChromeDump(message)) return null

        val direction = inferDirection(trimmed, lines, message, messageIdx)
        return ParsedWhatsAppScreen(
            contact = contact,
            message = message,
            eventType = classify(contact, message, trimmed),
            direction = direction
        )
    }

    private fun extractCallContact(text: String): String {
        val lines = text.lines().map { it.trim() }.filter { it.isNotBlank() && !isChromeLine(it) }
        val callLineIdx = lines.indexOfFirst { line ->
            CALL_PHRASES.any { line.lowercase().contains(it) }
        }
        if (callLineIdx > 0) return lines[callLineIdx - 1]
        return lines.firstOrNull { !CALL_PHRASES.any { p -> it.lowercase().contains(p) } }
            ?: "Unknown caller"
    }

    private fun shouldSkipDuplicateEvent(
        contact: String,
        message: String,
        eventType: WhatsAppEventType,
        direction: String = "IN"
    ): Boolean {
        val key = "${normalizeIdentifier(contact)}|${eventType.name}|$direction|${message.take(80).hashCode()}"
        val now = System.currentTimeMillis()
        val last = recentEventHashes[key]
        if (last != null && now - last < SareChildConstants.WHATSAPP_ONSCREEN_DEDUPE_MS) return true
        recentEventHashes[key] = now
        recentEventHashes.entries.removeIf { now - it.value > 15 * 60_000L }
        return false
    }

    fun normalizeIdentifier(value: String): String {
        val normalized = value.lowercase().replace(Regex("[^a-z0-9+]"), "")
        if (normalized.isNotBlank()) return normalized
        val fallback = value.trim().lowercase().filter { it.isLetterOrDigit() }
        return fallback.ifBlank { "unknown" }
    }

    private fun digitsOnly(value: String): String = value.filter { it.isDigit() }

    /**
     * Tight safe-contact match — avoids short fragments (e.g. "ton") matching unrelated names.
     * Phone-like identifiers match on trailing digits; name handles require length >= 4.
     */
    fun matchesSafeIdentifier(normalizedContact: String, normalizedSafe: String): Boolean {
        if (normalizedContact.isBlank() || normalizedSafe.isBlank()) return false
        if (normalizedContact == normalizedSafe) return true

        val contactDigits = digitsOnly(normalizedContact)
        val safeDigits = digitsOnly(normalizedSafe)
        if (safeDigits.length >= 7 && contactDigits.length >= 7) {
            val safeTail = safeDigits.takeLast(7)
            val contactTail = contactDigits.takeLast(7)
            if (safeTail == contactTail) return true
            if (contactDigits.endsWith(safeDigits) || safeDigits.endsWith(contactDigits)) return true
        }

        val contactName = normalizedContact.replace(Regex("\\d+"), "")
        val safeName = normalizedSafe.replace(Regex("\\d+"), "")
        if (safeName.length >= 4 && contactName.length >= 4) {
            if (contactName == safeName) return true
            if (contactName.contains(safeName) || safeName.contains(contactName)) return true
        }
        return false
    }

    /** Best-effort English-locale heuristic — WhatsApp's exact notification wording varies by
     *  OS/locale/version, so this purposefully degrades to MESSAGE rather than guessing wrong. */
    fun classify(title: String, text: String, big: String): WhatsAppEventType {
        val combined = listOf(title, text, big).joinToString(" ").lowercase()
        return when {
            CALL_PHRASES.any { combined.contains(it) } -> WhatsAppEventType.CALL
            "voice message" in combined || "audio message" in combined -> WhatsAppEventType.VOICE_NOTE
            "video" in combined && ("sent" in combined || "shared" in combined || combined.trim() == "video") ->
                WhatsAppEventType.VIDEO
            "photo" in combined || "image" in combined -> WhatsAppEventType.IMAGE
            "document" in combined -> WhatsAppEventType.DOCUMENT
            "sticker" in combined || "gif" in combined -> WhatsAppEventType.IMAGE
            else -> WhatsAppEventType.MESSAGE
        }
    }

    private fun extractContact(eventType: WhatsAppEventType, title: String, text: String): String {
        val phone = PHONE_REGEX.find("$title $text")?.value?.trim()
        if (!phone.isNullOrBlank()) return phone
        val titleLower = title.trim().lowercase()
        if (eventType == WhatsAppEventType.CALL && CALL_PHRASES.any { titleLower.contains(it) }) {
            return text.trim().ifBlank { "Unknown caller" }
        }
        return title.trim().ifBlank { "Unknown contact" }
    }

    suspend fun isKnownSafe(repo: ChildRepository, normalizedIdentifier: String): Boolean {
        if (normalizedIdentifier.isBlank()) return false
        val safe = loadSafeContactIdentifiers(repo)
        return safe.any { s -> matchesSafeIdentifier(normalizedIdentifier, s) }
    }

    /** Main entry point from [NotificationMonitorService] for every WhatsApp notification. */
    suspend fun handleNotification(
        context: Context,
        repo: ChildRepository,
        packageName: String,
        title: String,
        text: String,
        big: String,
        riskScore: Int
    ) {
        if (!isWhatsApp(packageName)) return
        if (!repo.whatsappMonitorConsent) return
        val combined = listOf(title, text, big).filter { it.isNotBlank() }.joinToString(" — ")
        if (combined.isBlank()) return
        if (isChromeDump(combined)) return

        val contentType = classify(title, text, big)
        val contactRaw = extractContact(contentType, title, text)
        val normalized = normalizeIdentifier(contactRaw)
        lastContactByPackage[packageName] = contactRaw to System.currentTimeMillis()

        val previewBody = when {
            contentType == WhatsAppEventType.CALL -> text.ifBlank { big }.ifBlank { combined }
            text.isNotBlank() -> text
            big.isNotBlank() -> big
            else -> combined
        }.take(160)

        if (shouldSkipDuplicateEvent(contactRaw, previewBody, contentType)) return
        if (wasRecentOutgoing(contactRaw, previewBody)) return

        val safe = isKnownSafe(repo, normalized)
        val firstSighting = !safe && isFirstSighting(context, "$packageName|$normalized")
        val effectiveType = if (firstSighting) WhatsAppEventType.UNKNOWN_CONTACT else contentType
        val isMediaType = contentType in MEDIA_TYPES
        val riskFlag = !safe && isMediaType

        repo.postWhatsAppEvent(
            WhatsAppEvent(
                eventType = effectiveType,
                contactLabel = contactRaw,
                contactSafe = safe,
                direction = "IN",
                preview = previewBody,
                riskScore = riskScore.takeIf { it > 0 },
                riskFlag = riskFlag,
                source = "notification"
            )
        )

        if (safe) return
        maybeAlert(
            repo = repo,
            packageName = packageName,
            contentType = contentType,
            firstSighting = firstSighting,
            contactRaw = contactRaw,
            normalized = normalized,
            riskScore = riskScore,
            riskFlag = riskFlag,
            snippet = combined.take(140)
        )
    }

    /**
     * Secondary, richer signal from [MessageMonitorAccessibilityService]'s on-screen text —
     * only ever adds a MESSAGE-type timeline row (never an alert; the accessibility service
     * already raises its own unidentified-contact alert). Skipped entirely without consent.
     */
    suspend fun recordOnScreenMessage(repo: ChildRepository, packageName: String, text: String) {
        if (!isWhatsApp(packageName)) return
        if (!repo.whatsappMonitorConsent) return
        val parsed = parseOnScreenText(text) ?: return
        if (shouldSkipDuplicateEvent(parsed.contact, parsed.message, parsed.eventType, parsed.direction)) return

        val normalized = normalizeIdentifier(parsed.contact)
        lastContactByPackage[packageName] = parsed.contact to System.currentTimeMillis()
        if (parsed.direction == "OUT") markRecentOutgoing(parsed.contact, parsed.message)
        val safe = isKnownSafe(repo, normalized)
        repo.postWhatsAppEvent(
            WhatsAppEvent(
                eventType = parsed.eventType,
                contactLabel = parsed.contact,
                contactSafe = safe,
                direction = parsed.direction,
                preview = parsed.message.take(160),
                source = "onscreen"
            )
        )
    }

    /** Called by [WhatsAppMediaObserver] once a WhatsApp media file has been recorded. */
    suspend fun maybeAlertMedia(
        repo: ChildRepository,
        eventType: WhatsAppEventType,
        contactLabel: String,
        mediaUrl: String?
    ) {
        val normalized = normalizeIdentifier(contactLabel)
        val dedupeKey = "media|$eventType|$normalized"
        val now = System.currentTimeMillis()
        val last = recentAlerts[dedupeKey]
        if (last != null && now - last < SareChildConstants.WHATSAPP_ALERT_DEDUPE_MS) return
        recentAlerts[dedupeKey] = now
        trimRecentAlerts(now)

        if (isCategorySnoozed(repo, "WHATSAPP_MEDIA")) return
        val label = eventType.name.lowercase().replace('_', ' ')
        repo.postAlert(
            FamilyAlert(
                type = AlertType.WHATSAPP_MEDIA,
                severity = AlertSeverity.MEDIUM,
                title = "WhatsApp $label from unknown contact — ${repo.childName}",
                snippet = "Contact '$contactLabel' is not in your safe list. Recommend reviewing this $label together.",
                category = "WHATSAPP_MEDIA",
                mediaUrl = mediaUrl
            )
        )
    }

    private suspend fun maybeAlert(
        repo: ChildRepository,
        packageName: String,
        contentType: WhatsAppEventType,
        firstSighting: Boolean,
        contactRaw: String,
        normalized: String,
        riskScore: Int,
        riskFlag: Boolean,
        snippet: String
    ) {
        val category = if (contentType == WhatsAppEventType.CALL) "WHATSAPP_CALL" else "WHATSAPP_CONTACT"
        if (isCategorySnoozed(repo, category)) return

        val dedupeKey = "$packageName|$contentType|$normalized"
        val now = System.currentTimeMillis()
        val last = recentAlerts[dedupeKey]
        if (last != null && now - last < SareChildConstants.WHATSAPP_ALERT_DEDUPE_MS) return
        recentAlerts[dedupeKey] = now
        trimRecentAlerts(now)

        val severity = when {
            riskScore >= 50 -> AlertSeverity.HIGH
            riskScore >= 20 || riskFlag -> AlertSeverity.MEDIUM
            else -> AlertSeverity.LOW
        }
        val riskNote = if (riskFlag) " Unknown contact + media — recommend reviewing together." else ""

        val (alertType, alertTitle) = when {
            firstSighting -> AlertType.UNIDENTIFIED_CONTACT to
                "Unidentified WhatsApp contact — ${repo.childName}"
            contentType == WhatsAppEventType.CALL -> AlertType.WHATSAPP_CALL to
                "WhatsApp call with unknown contact — ${repo.childName}"
            contentType in MEDIA_TYPES -> AlertType.WHATSAPP_MEDIA to
                "WhatsApp ${contentType.name.lowercase().replace('_', ' ')} from unknown contact — ${repo.childName}"
            else -> AlertType.UNIDENTIFIED_CONTACT to
                "WhatsApp message from unknown contact — ${repo.childName}"
        }
        repo.postAlert(
            FamilyAlert(
                type = alertType,
                severity = severity,
                title = alertTitle,
                snippet = "Contact '$contactRaw' is not in your safe list.$riskNote $snippet",
                category = category,
                riskScore = riskScore.takeIf { it > 0 }
            )
        )
    }

    private fun trimRecentAlerts(now: Long) {
        recentAlerts.entries.removeIf { now - it.value > 30 * 60_000L }
    }

    private suspend fun loadSafeContactIdentifiers(repo: ChildRepository): List<String> {
        val now = System.currentTimeMillis()
        if (now - cachedSafeContactsAtMs < 60_000L) return cachedSafeContacts
        val identifiers = repo.loadSafeContacts("WHATSAPP")
            .map { normalizeIdentifier(it.identifier) }
            .filter { it.isNotBlank() }
        cachedSafeContacts = identifiers
        cachedSafeContactsAtMs = now
        return identifiers
    }

    private suspend fun isCategorySnoozed(repo: ChildRepository, category: String): Boolean {
        val now = System.currentTimeMillis()
        if (now - cachedSettingsAtMs > 60_000L) {
            cachedSettings = repo.loadSafetySettings()
            cachedSettingsAtMs = now
        }
        return now < cachedSettings.snoozeUntilMs && cachedSettings.snoozedCategories.contains(category)
    }

    /** Persisted (across restarts) so "first sighting" alerts don't repeat after a process kill. */
    private fun isFirstSighting(context: Context, key: String): Boolean {
        val prefs = context.getSharedPreferences(SareChildConstants.PREFS_NAME, Context.MODE_PRIVATE)
        val known = prefs.getStringSet(KNOWN_CONTACTS_PREF_KEY, null) ?: emptySet()
        if (known.contains(key)) return false
        val updated = (known + key).let {
            if (it.size > KNOWN_CONTACTS_MAX) it.toList().takeLast(KNOWN_CONTACTS_MAX).toSet() else it
        }
        prefs.edit().putStringSet(KNOWN_CONTACTS_PREF_KEY, updated).apply()
        return true
    }

    /** Composite status written to the device doc for the parent WhatsApp dashboard. */
    fun protectionStatusMap(
        consent: Boolean,
        notificationAccess: Boolean,
        accessibilityAccess: Boolean,
        mediaPermission: Boolean,
        lastEventAtMs: Long = 0L
    ): Map<String, Any?> {
        val now = System.currentTimeMillis()
        val enabled = consent && notificationAccess
        return mapOf(
            "enabled" to enabled,
            "consent" to consent,
            "notificationAccess" to notificationAccess,
            "accessibilityAccess" to accessibilityAccess,
            "mediaPermission" to mediaPermission,
            "lastEventAtMs" to lastEventAtMs.takeIf { it > 0L },
            "updatedAtMs" to now
        )
    }

    fun hasMediaPermission(context: Context): Boolean {
        return if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            hasPerm(context, android.Manifest.permission.READ_MEDIA_IMAGES) ||
                hasPerm(context, android.Manifest.permission.READ_MEDIA_VIDEO) ||
                hasPerm(context, android.Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            hasPerm(context, android.Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun hasPerm(context: Context, perm: String): Boolean =
        ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
}
