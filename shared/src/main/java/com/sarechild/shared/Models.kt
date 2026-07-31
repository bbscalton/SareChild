package com.sarechild.shared

data class LatLngPoint(
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val accuracyM: Float? = null,
    val updatedAtMs: Long = System.currentTimeMillis()
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "lat" to lat,
        "lng" to lng,
        "accuracyM" to accuracyM,
        "updatedAtMs" to updatedAtMs
    )

    companion object {
        fun fromMap(map: Map<String, Any?>?): LatLngPoint? {
            if (map == null) return null
            val lat = (map["lat"] as? Number)?.toDouble() ?: return null
            val lng = (map["lng"] as? Number)?.toDouble() ?: return null
            return LatLngPoint(
                lat = lat,
                lng = lng,
                accuracyM = (map["accuracyM"] as? Number)?.toFloat(),
                updatedAtMs = (map["updatedAtMs"] as? Number)?.toLong() ?: 0L
            )
        }
    }
}

data class BatterySample(
    val percent: Int = -1,
    val charging: Boolean = false,
    val atMs: Long = System.currentTimeMillis()
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "percent" to percent,
        "charging" to charging,
        "atMs" to atMs
    )

    companion object {
        fun fromMap(map: Map<String, Any?>?): BatterySample? {
            if (map == null) return null
            return BatterySample(
                percent = (map["percent"] as? Number)?.toInt() ?: -1,
                charging = map["charging"] as? Boolean ?: false,
                atMs = (map["atMs"] as? Number)?.toLong() ?: 0L
            )
        }
    }
}

data class DeviceStatus(
    val id: String = "",
    val childName: String = "",
    val online: Boolean = false,
    val lastHeartbeatMs: Long = 0L,
    val batteryPercent: Int = -1,
    val charging: Boolean = false,
    val batteryHistory: List<BatterySample> = emptyList(),
    val lastLocation: LatLngPoint? = null,
    val notificationAccess: Boolean = false,
    val locationPermission: Boolean = false,
    val monitoringActive: Boolean = false,
    val screenShareConsent: Boolean = false,
    val cameraCheckConsent: Boolean = false,
    val micCheckConsent: Boolean = false,
    val messageMonitorConsent: Boolean = false,
    val installMonitorConsent: Boolean = false,
    val usageConsent: Boolean = false,
    val callSmsConsent: Boolean = false,
    val offlineSmsFallbackConsent: Boolean = false,
    val offlineAutoCallConsent: Boolean = false,
    val whatsappMonitorConsent: Boolean = false,
    val chatOnline: Boolean = false,
    val chatLastSeenMs: Long = 0L,
    val offlineCallEnabled: Boolean = false,
    val offlineCallNumber: String? = null,
    val offlineCallMaxAttempts: Int = 0,
    val activeSession: String? = null,
    val latestFrameUrl: String? = null,
    val todayScreenMinutes: Int = 0
)

data class FamilyAlert(
    val id: String = "",
    val type: AlertType = AlertType.KEYWORD,
    val severity: AlertSeverity = AlertSeverity.MEDIUM,
    val title: String = "",
    val snippet: String? = null,
    val category: String? = null,
    val deviceId: String = "",
    val createdAtMs: Long = System.currentTimeMillis(),
    val read: Boolean = false,
    val location: LatLngPoint? = null,
    val mediaUrl: String? = null,
    val commandId: String? = null,
    val riskScore: Int? = null,
    val retainUntilMs: Long = System.currentTimeMillis() +
        SareChildConstants.ALERT_RETENTION_DAYS * 24L * 60L * 60L * 1000L
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "type" to type.name,
        "severity" to severity.name,
        "title" to title,
        "snippet" to snippet,
        "category" to category,
        "deviceId" to deviceId,
        "createdAtMs" to createdAtMs,
        "read" to read,
        "location" to location?.toMap(),
        "mediaUrl" to mediaUrl,
        "commandId" to commandId,
        "riskScore" to riskScore,
        "retainUntilMs" to retainUntilMs
    )
}

data class GeofenceZone(
    val id: String = "",
    val name: String = "",
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val radiusM: Float = 200f,
    val active: Boolean = true,
    /** Calendar.SUNDAY=1 … SATURDAY=7; empty = always active */
    val daysOfWeek: List<Int> = emptyList(),
    /** Minutes from midnight local; null = always */
    val startMinute: Int? = null,
    val endMinute: Int? = null
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "name" to name,
        "lat" to lat,
        "lng" to lng,
        "radiusM" to radiusM,
        "active" to active,
        "daysOfWeek" to daysOfWeek,
        "startMinute" to startMinute,
        "endMinute" to endMinute
    )

    fun isScheduleActiveNow(nowMs: Long = System.currentTimeMillis()): Boolean {
        if (daysOfWeek.isEmpty() && startMinute == null && endMinute == null) return true
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = nowMs }
        val dow = cal.get(java.util.Calendar.DAY_OF_WEEK)
        if (daysOfWeek.isNotEmpty() && dow !in daysOfWeek) return false
        val minuteOfDay = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 +
            cal.get(java.util.Calendar.MINUTE)
        val start = startMinute
        val end = endMinute
        if (start == null || end == null) return true
        return if (start <= end) {
            minuteOfDay in start..end
        } else {
            // overnight window
            minuteOfDay >= start || minuteOfDay <= end
        }
    }
}

data class KeywordHit(
    val category: KeywordCategory,
    val phrase: String,
    val matchedText: String
)

data class SafetyCommand(
    val id: String = "",
    val type: SafetyCommandType = SafetyCommandType.CAMERA_CHECK,
    val status: SafetyCommandStatus = SafetyCommandStatus.PENDING,
    val deviceId: String = "",
    val requestedAtMs: Long = System.currentTimeMillis(),
    val acceptedAtMs: Long? = null,
    val completedAtMs: Long? = null,
    val resultPath: String? = null,
    val resultUrl: String? = null,
    val error: String? = null,
    /** Screen share session length (minutes). Default 10, max 60. */
    val durationMinutes: Int? = null
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "type" to type.name,
        "status" to status.name,
        "deviceId" to deviceId,
        "requestedAtMs" to requestedAtMs,
        "acceptedAtMs" to acceptedAtMs,
        "completedAtMs" to completedAtMs,
        "resultPath" to resultPath,
        "resultUrl" to resultUrl,
        "error" to error,
        "durationMinutes" to durationMinutes
    )

    companion object {
        fun fromDoc(id: String, data: Map<String, Any?>): SafetyCommand? {
            val type = runCatching {
                SafetyCommandType.valueOf(data["type"] as? String ?: return null)
            }.getOrNull() ?: return null
            val status = runCatching {
                SafetyCommandStatus.valueOf(data["status"] as? String ?: "PENDING")
            }.getOrDefault(SafetyCommandStatus.PENDING)
            return SafetyCommand(
                id = id,
                type = type,
                status = status,
                deviceId = data["deviceId"] as? String ?: "",
                requestedAtMs = (data["requestedAtMs"] as? Number)?.toLong() ?: 0L,
                acceptedAtMs = (data["acceptedAtMs"] as? Number)?.toLong(),
                completedAtMs = (data["completedAtMs"] as? Number)?.toLong(),
                resultPath = data["resultPath"] as? String,
                resultUrl = data["resultUrl"] as? String,
                error = data["error"] as? String,
                durationMinutes = (data["durationMinutes"] as? Number)?.toInt()
            )
        }
    }
}

data class ScreenShareSchedule(
    val id: String = "",
    val deviceId: String = "",
    val label: String = "Scheduled check",
    val daysOfWeek: List<Int> = emptyList(),
    val startMinute: Int = 0,
    val durationMinutes: Int = SareChildConstants.SCREEN_SHARE_DEFAULT_MINUTES,
    val active: Boolean = true,
    val lastTriggeredDayKey: String? = null
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "deviceId" to deviceId,
        "label" to label,
        "daysOfWeek" to daysOfWeek,
        "startMinute" to startMinute,
        "durationMinutes" to durationMinutes,
        "active" to active,
        "lastTriggeredDayKey" to lastTriggeredDayKey
    )

    fun isDueNow(nowMs: Long = System.currentTimeMillis()): Boolean {
        if (!active) return false
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = nowMs }
        val dow = cal.get(java.util.Calendar.DAY_OF_WEEK)
        if (daysOfWeek.isNotEmpty() && dow !in daysOfWeek) return false
        val minuteOfDay = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 +
            cal.get(java.util.Calendar.MINUTE)
        return minuteOfDay == startMinute
    }

    fun dayKey(nowMs: Long = System.currentTimeMillis()): String {
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = nowMs }
        return "${cal.get(java.util.Calendar.YEAR)}-${cal.get(java.util.Calendar.DAY_OF_YEAR)}"
    }
}

data class SosContact(
    val id: String = "",
    val name: String = "",
    val phoneNote: String = ""
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "name" to name,
        "phoneNote" to phoneNote
    )
}

data class SafeContact(
    val id: String = "",
    val channel: String = "WHATSAPP",
    val label: String = "",
    /** Name, handle, or phone fragment that is allowed. */
    val identifier: String = ""
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "channel" to channel,
        "label" to label,
        "identifier" to identifier
    )
}

data class AppLimit(
    val id: String = "",
    val packageName: String = "",
    val label: String = "",
    val dailyLimitMinutes: Int = 60,
    val deviceId: String = ""
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "packageName" to packageName,
        "label" to label,
        "dailyLimitMinutes" to dailyLimitMinutes,
        "deviceId" to deviceId
    )
}

data class AppBlockSchedule(
    val id: String = "",
    val packageName: String = "",
    val label: String = "",
    val deviceId: String = "",
    /** Calendar.SUNDAY=1 … SATURDAY=7; empty = always active */
    val daysOfWeek: List<Int> = emptyList(),
    /** Minutes from midnight local. Supports overnight when start > end. */
    val startMinute: Int = 0,
    val endMinute: Int = 0,
    val active: Boolean = true
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "packageName" to packageName,
        "label" to label,
        "deviceId" to deviceId,
        "daysOfWeek" to daysOfWeek,
        "startMinute" to startMinute,
        "endMinute" to endMinute,
        "active" to active
    )

    fun isActiveNow(nowMs: Long = System.currentTimeMillis()): Boolean {
        if (!active) return false
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = nowMs }
        val dow = cal.get(java.util.Calendar.DAY_OF_WEEK)
        if (daysOfWeek.isNotEmpty() && dow !in daysOfWeek) return false
        val minuteOfDay = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 +
            cal.get(java.util.Calendar.MINUTE)
        return if (startMinute <= endMinute) {
            minuteOfDay in startMinute..endMinute
        } else {
            minuteOfDay >= startMinute || minuteOfDay <= endMinute
        }
    }
}

data class UsageAppEntry(
    val packageName: String = "",
    val label: String = "",
    val minutes: Int = 0
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "packageName" to packageName,
        "label" to label,
        "minutes" to minutes
    )
}

data class CallSmsPreview(
    val id: String = "",
    val kind: String = "", // CALL or SMS
    val direction: String = "",
    val addressMasked: String = "",
    val snippet: String? = null,
    val atMs: Long = 0L,
    val deviceId: String = ""
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "kind" to kind,
        "direction" to direction,
        "addressMasked" to addressMasked,
        "snippet" to snippet,
        "atMs" to atMs,
        "deviceId" to deviceId,
        "createdAtMs" to System.currentTimeMillis()
    )
}

/**
 * A single WhatsApp activity record for the parent's dedicated "WhatsApp" dashboard section
 * (see `families/{familyId}/whatsappEvents`). Written by [com.sarechild.child.monitoring
 * .WhatsAppMonitor] / `WhatsAppMediaObserver` on the child device from notification text,
 * on-screen accessibility text, and/or MediaStore metadata for files under a WhatsApp media
 * folder — never from WhatsApp's (encrypted) chat database.
 *
 * Whitelist behavior: when [contactSafe] is true (the contact/handle matches a parent-managed
 * `safeContacts` entry), the event is still written for completeness but is written without a
 * companion [FamilyAlert] — see WhatsAppMonitor for the alerting rules.
 */
data class WhatsAppEvent(
    val id: String = "",
    val deviceId: String = "",
    val eventType: WhatsAppEventType = WhatsAppEventType.MESSAGE,
    /** Best-effort contact name / handle / phone fragment extracted from the source signal. */
    val contactLabel: String = "",
    /** True if [contactLabel] matched a parent-managed safe contact for this family. */
    val contactSafe: Boolean = false,
    /** IN / OUT / UNKNOWN — best effort; notifications are almost always incoming. */
    val direction: String = "IN",
    /** Notification/on-screen text preview — never decrypted chat content beyond what
     *  Android/WhatsApp already surfaced in the notification or visible screen. */
    val preview: String? = null,
    val mediaUrl: String? = null,
    /** image | video | voice_note | document */
    val mediaType: String? = null,
    val durationSec: Int? = null,
    val riskScore: Int? = null,
    /** Heuristic "review recommended" badge: an unknown (non-whitelisted) contact paired with
     *  a media/voice/video/document event. Not a certainty claim — for parent review only. */
    val riskFlag: Boolean = false,
    /** notification | onscreen | media_scan */
    val source: String = "notification",
    val createdAtMs: Long = System.currentTimeMillis(),
    val retainUntilMs: Long = System.currentTimeMillis() +
        SareChildConstants.ALERT_RETENTION_DAYS * 24L * 60L * 60L * 1000L
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "deviceId" to deviceId,
        "eventType" to eventType.name,
        "contactLabel" to contactLabel,
        "contactSafe" to contactSafe,
        "direction" to direction,
        "preview" to preview,
        "mediaUrl" to mediaUrl,
        "mediaType" to mediaType,
        "durationSec" to durationSec,
        "riskScore" to riskScore,
        "riskFlag" to riskFlag,
        "source" to source,
        "createdAtMs" to createdAtMs,
        "retainUntilMs" to retainUntilMs
    )
}

data class GuardianInfo(
    val uid: String = "",
    val email: String = "",
    val role: GuardianRole = GuardianRole.CAREGIVER,
    val joinedAtMs: Long = System.currentTimeMillis(),
    val chatOnline: Boolean = false,
    val lastSeenMs: Long = 0L
)

data class WeeklyDigest(
    val id: String = "",
    val weekStartMs: Long = 0L,
    val weekEndMs: Long = 0L,
    val summary: String = "",
    val alertCount: Int = 0,
    val topAlertTypes: List<String> = emptyList(),
    val createdAtMs: Long = System.currentTimeMillis()
)

data class FamilyChatMessage(
    val id: String = "",
    val senderUid: String = "",
    val senderName: String = "",
    val senderRole: String = "GUARDIAN", // GUARDIAN or CHILD
    val deviceId: String? = null,
    val text: String? = null,
    val mediaUrl: String? = null,
    val mediaType: String? = null, // image | audio
    val createdAtMs: Long = System.currentTimeMillis()
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "senderUid" to senderUid,
        "senderName" to senderName,
        "senderRole" to senderRole,
        "deviceId" to deviceId,
        "text" to text,
        "mediaUrl" to mediaUrl,
        "mediaType" to mediaType,
        "createdAtMs" to createdAtMs
    )
}

data class FamilySafetySettings(
    val escalationEnabled: Boolean = true,
    val escalationRiskThreshold: Int = 60,
    val autoLockOnCritical: Boolean = false,
    val checkInIntervalMinutes: Int = 120,
    val snoozedCategories: List<String> = emptyList(),
    val snoozeUntilMs: Long = 0L,
    val alertRetentionDays: Int = SareChildConstants.ALERT_RETENTION_DAYS,
    val mediaRetentionDays: Int = SareChildConstants.MEDIA_RETENTION_DAYS
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "escalationEnabled" to escalationEnabled,
        "escalationRiskThreshold" to escalationRiskThreshold,
        "autoLockOnCritical" to autoLockOnCritical,
        "checkInIntervalMinutes" to checkInIntervalMinutes,
        "snoozedCategories" to snoozedCategories,
        "snoozeUntilMs" to snoozeUntilMs,
        "alertRetentionDays" to alertRetentionDays,
        "mediaRetentionDays" to mediaRetentionDays
    )
}
