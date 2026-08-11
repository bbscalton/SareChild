package com.sarechild.shared

data class LatLngPoint(
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val accuracyM: Float? = null,
    val updatedAtMs: Long = System.currentTimeMillis(),
    /** Compass heading in degrees (0-360, true north), from Location.getBearing() when the
     *  device has a recent bearing fix (typically only while moving). Null if unavailable —
     *  the parent map UI falls back to computing heading from consecutive trail points. */
    val bearingDeg: Float? = null,
    /** Ground speed in meters/second from Location.getSpeed(), when available. */
    val speedMps: Float? = null
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "lat" to lat,
        "lng" to lng,
        "accuracyM" to accuracyM,
        "updatedAtMs" to updatedAtMs,
        "bearingDeg" to bearingDeg,
        "speedMps" to speedMps
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
                updatedAtMs = (map["updatedAtMs"] as? Number)?.toLong() ?: 0L,
                bearingDeg = (map["bearingDeg"] as? Number)?.toFloat(),
                speedMps = (map["speedMps"] as? Number)?.toFloat()
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
    val cameraPermission: Boolean = false,
    val micCheckConsent: Boolean = false,
    val messageMonitorConsent: Boolean = false,
    val installMonitorConsent: Boolean = false,
    val usageConsent: Boolean = false,
    val callSmsConsent: Boolean = false,
    val offlineSmsFallbackConsent: Boolean = false,
    val offlineAutoCallConsent: Boolean = false,
    val whatsappMonitorConsent: Boolean = false,
    val whatsappMediaPermission: Boolean = false,
    val whatsappProtectionEnabled: Boolean = false,
    val photoGalleryConsent: Boolean = false,
    val chatOnline: Boolean = false,
    val chatLastSeenMs: Long = 0L,
    val offlineCallEnabled: Boolean = false,
    val offlineCallNumber: String? = null,
    val offlineCallMaxAttempts: Int = 0,
    val activeSession: String? = null,
    val latestFrameUrl: String? = null,
    val todayScreenMinutes: Int = 0,
    /** Guardian uids the parent has explicitly assigned to this device's chat thread.
     *  Empty means only the family owner (parent) can see/use this thread — a guardian
     *  needs to be added here before they can read or send in it. */
    val assignedGuardianUids: List<String> = emptyList(),
    /** uid -> last-read timestamp (ms) for this device's chat thread, used to compute
     *  per-participant unread badges (parent, each assigned guardian, and the child). */
    val chatReads: Map<String, Long> = emptyMap()
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
    val durationMinutes: Int? = null,
    /** Live viewing: Firestore liveSessions doc id. */
    val liveSessionId: String? = null,
    val liveVideo: Boolean? = null,
    val liveAudio: Boolean? = null,
    val liveScreen: Boolean? = null,
    val liveRecord: Boolean? = null,
    /** true = front camera, false = rear. */
    val cameraFront: Boolean? = null,
    /** Camera snapshot mode: "front", "back", or "both". */
    val cameras: String? = null,
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
        "durationMinutes" to durationMinutes,
        "liveSessionId" to liveSessionId,
        "liveVideo" to liveVideo,
        "liveAudio" to liveAudio,
        "liveScreen" to liveScreen,
        "liveRecord" to liveRecord,
        "cameraFront" to cameraFront,
        "cameras" to cameras,
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
                durationMinutes = (data["durationMinutes"] as? Number)?.toInt(),
                liveSessionId = data["liveSessionId"] as? String,
                liveVideo = data["liveVideo"] as? Boolean,
                liveAudio = data["liveAudio"] as? Boolean,
                liveScreen = data["liveScreen"] as? Boolean,
                liveRecord = data["liveRecord"] as? Boolean,
                cameraFront = data["cameraFront"] as? Boolean,
                cameras = data["cameras"] as? String,
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
    val active: Boolean = true,
    /** Shown on the child block screen when this schedule is active. */
    val message: String = "Application has been blocked.",
    val createdAtMs: Long = System.currentTimeMillis()
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "packageName" to packageName,
        "label" to label,
        "deviceId" to deviceId,
        "daysOfWeek" to daysOfWeek,
        "startMinute" to startMinute,
        "endMinute" to endMinute,
        "active" to active,
        "message" to message,
        "createdAtMs" to createdAtMs
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

/** One installed app row synced from the child device inventory. */
data class InstalledApp(
    val packageName: String = "",
    val name: String = "",
    val versionName: String = "",
    val versionCode: Long = 0L,
    val apkSizeBytes: Long = 0L,
    val firstInstallTime: Long = 0L,
    val lastUpdateTime: Long = 0L,
    val updatedAtMs: Long = System.currentTimeMillis(),
    val deviceId: String = ""
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "packageName" to packageName,
        "name" to name,
        "versionName" to versionName,
        "versionCode" to versionCode,
        "apkSizeBytes" to apkSizeBytes,
        "firstInstallTime" to firstInstallTime,
        "lastUpdateTime" to lastUpdateTime,
        "updatedAtMs" to updatedAtMs,
        "deviceId" to deviceId
    )
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
 * One row in the parent "Call recording" dashboard section (`families/{familyId}/callRecordings`).
 * Native Android implementation — MediaRecorder + phone-state for cellular, notification-assisted
 * mic-side capture for VoIP apps. Cordova call-recorder plugins are not used.
 */
data class CallRecordingEvent(
    val id: String = "",
    val deviceId: String = "",
    val callType: CallRecordingType = CallRecordingType.CELLULAR,
    val direction: String = "UNKNOWN",
    val numberMasked: String? = null,
    val contactLabel: String? = null,
    val packageName: String? = null,
    val durationSec: Int = 0,
    val audioUrl: String? = null,
    val audioCaptured: Boolean = false,
    /** e.g. mic_only, voice_call, voice_communication, capture_failed_android10 */
    val audioSourceNote: String? = null,
    val createdAtMs: Long = System.currentTimeMillis(),
    val retainUntilMs: Long = System.currentTimeMillis() +
        SareChildConstants.MEDIA_RETENTION_DAYS * 24L * 60L * 60L * 1000L
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "deviceId" to deviceId,
        "callType" to callType.name,
        "direction" to direction,
        "numberMasked" to numberMasked,
        "contactLabel" to contactLabel,
        "packageName" to packageName,
        "durationSec" to durationSec,
        "audioUrl" to audioUrl,
        "audioCaptured" to audioCaptured,
        "audioSourceNote" to audioSourceNote,
        "createdAtMs" to createdAtMs,
        "retainUntilMs" to retainUntilMs
    )
}

/** Android photo gallery access level reported to the parent dashboard. */
enum class PhotoGalleryAccessLevel {
    NONE,
    PARTIAL,
    FULL
}

/**
 * Metadata for one photo synced from the child's MediaStore gallery
 * (`families/{familyId}/devices/{deviceId}/photos/{mediaStoreId}`).
 */
data class DevicePhoto(
    val mediaStoreId: Long = 0L,
    val displayName: String = "",
    val sizeBytes: Long = 0L,
    val takenAtMs: Long = 0L,
    val modifiedAtMs: Long = 0L,
    val mimeType: String = "image/jpeg",
    val width: Int = 0,
    val height: Int = 0,
    val syncedAtMs: Long = System.currentTimeMillis(),
    val thumbPath: String? = null,
    val thumbUrl: String? = null,
    val fullPath: String? = null,
    val fullUrl: String? = null
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "mediaStoreId" to mediaStoreId,
        "displayName" to displayName,
        "sizeBytes" to sizeBytes,
        "takenAtMs" to takenAtMs,
        "modifiedAtMs" to modifiedAtMs,
        "mimeType" to mimeType,
        "width" to width,
        "height" to height,
        "syncedAtMs" to syncedAtMs,
        "thumbPath" to thumbPath,
        "thumbUrl" to thumbUrl,
        "fullPath" to fullPath,
        "fullUrl" to fullUrl
    )

    companion object {
        fun fromMap(map: Map<String, Any?>?): DevicePhoto? {
            if (map == null) return null
            return DevicePhoto(
                mediaStoreId = (map["mediaStoreId"] as? Number)?.toLong() ?: return null,
                displayName = map["displayName"] as? String ?: "",
                sizeBytes = (map["sizeBytes"] as? Number)?.toLong() ?: 0L,
                takenAtMs = (map["takenAtMs"] as? Number)?.toLong() ?: 0L,
                modifiedAtMs = (map["modifiedAtMs"] as? Number)?.toLong() ?: 0L,
                mimeType = map["mimeType"] as? String ?: "image/jpeg",
                width = (map["width"] as? Number)?.toInt() ?: 0,
                height = (map["height"] as? Number)?.toInt() ?: 0,
                syncedAtMs = (map["syncedAtMs"] as? Number)?.toLong() ?: 0L,
                thumbPath = map["thumbPath"] as? String,
                thumbUrl = map["thumbUrl"] as? String,
                fullPath = map["fullPath"] as? String,
                fullUrl = map["fullUrl"] as? String
            )
        }
    }
}

/** A single periodic accessibility screenshot (see ScreenSnapshotCapture on the child device). */
data class ScreenSnapshot(
    val id: String = "",
    val deviceId: String = "",
    val capturedAtMs: Long = System.currentTimeMillis(),
    val appPackage: String? = null,
    val appLabel: String? = null,
    val r2Path: String? = null,
    val imageUrl: String? = null,
    val thumbPath: String? = null,
    val thumbUrl: String? = null,
    val width: Int = 0,
    val height: Int = 0
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "deviceId" to deviceId,
        "capturedAtMs" to capturedAtMs,
        "appPackage" to appPackage,
        "appLabel" to appLabel,
        "r2Path" to r2Path,
        "imageUrl" to imageUrl,
        "thumbPath" to thumbPath,
        "thumbUrl" to thumbUrl,
        "width" to width,
        "height" to height
    )

    companion object {
        fun fromMap(id: String, map: Map<String, Any?>?): ScreenSnapshot? {
            if (map == null) return null
            return ScreenSnapshot(
                id = id,
                deviceId = map["deviceId"] as? String ?: "",
                capturedAtMs = (map["capturedAtMs"] as? Number)?.toLong() ?: 0L,
                appPackage = map["appPackage"] as? String,
                appLabel = map["appLabel"] as? String,
                r2Path = map["r2Path"] as? String,
                imageUrl = map["imageUrl"] as? String,
                thumbPath = map["thumbPath"] as? String,
                thumbUrl = map["thumbUrl"] as? String,
                width = (map["width"] as? Number)?.toInt() ?: 0,
                height = (map["height"] as? Number)?.toInt() ?: 0
            )
        }
    }
}

/** A single periodic camera snapshot (see CameraSnapshotCapture on the child device). */
data class CameraSnapshot(
    val id: String = "",
    val deviceId: String = "",
    val capturedAtMs: Long = System.currentTimeMillis(),
    /** "front" or "back". */
    val cameraFacing: String = "back",
    val r2Path: String? = null,
    val imageUrl: String? = null,
    val thumbPath: String? = null,
    val thumbUrl: String? = null,
    val width: Int = 0,
    val height: Int = 0
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "deviceId" to deviceId,
        "capturedAtMs" to capturedAtMs,
        "cameraFacing" to cameraFacing,
        "r2Path" to r2Path,
        "imageUrl" to imageUrl,
        "thumbPath" to thumbPath,
        "thumbUrl" to thumbUrl,
        "width" to width,
        "height" to height
    )

    companion object {
        fun fromMap(id: String, map: Map<String, Any?>?): CameraSnapshot? {
            if (map == null) return null
            return CameraSnapshot(
                id = id,
                deviceId = map["deviceId"] as? String ?: "",
                capturedAtMs = (map["capturedAtMs"] as? Number)?.toLong() ?: 0L,
                cameraFacing = map["cameraFacing"] as? String ?: "back",
                r2Path = map["r2Path"] as? String,
                imageUrl = map["imageUrl"] as? String,
                thumbPath = map["thumbPath"] as? String,
                thumbUrl = map["thumbUrl"] as? String,
                width = (map["width"] as? Number)?.toInt() ?: 0,
                height = (map["height"] as? Number)?.toInt() ?: 0
            )
        }
    }
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

/**
 * One row in the "Typing safety / message shield" timeline (families/{familyId}/typingEvents).
 * Written by [com.sarechild.child.monitoring.MessageMonitorAccessibilityService] on the child
 * device from on-screen text it can already legally see via Android's Accessibility API — never
 * from a keylogger, root, or WhatsApp's (encrypted) database. Written for every settled text
 * change in a monitored app (debounced, not per-keystroke) so the parent timeline is complete;
 * [matchedWords]/[severity] are only non-empty/above LOW when a prohibited word matched.
 * Password/PIN fields ([AccessibilityNodeInfo.isPassword]) are always skipped before this is built.
 */
data class TypingSafetyEvent(
    val id: String = "",
    val deviceId: String = "",
    val packageName: String = "",
    val appLabel: String = "",
    /** Truncated on-screen text snippet — never the full raw text history, just the latest settle. */
    val snippet: String = "",
    val matchedWords: List<String> = emptyList(),
    val category: String? = null,
    val severity: AlertSeverity = AlertSeverity.LOW,
    val riskScore: Int = 0,
    /** "communication" (heuristic messaging-app list) or "360" (all-apps mode). */
    val mode: String = "communication",
    val reviewed: Boolean = false,
    val createdAtMs: Long = System.currentTimeMillis(),
    val retainUntilMs: Long = System.currentTimeMillis() +
        SareChildConstants.ALERT_RETENTION_DAYS * 24L * 60L * 60L * 1000L
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "deviceId" to deviceId,
        "packageName" to packageName,
        "appLabel" to appLabel,
        "snippet" to snippet,
        "matchedWords" to matchedWords,
        "category" to category,
        "severity" to severity.name,
        "riskScore" to riskScore,
        "mode" to mode,
        "reviewed" to reviewed,
        "createdAtMs" to createdAtMs,
        "retainUntilMs" to retainUntilMs
    )
}

/**
 * Parent-configurable rules for the Typing safety monitor (families/{familyId}/typingSafetySettings/default).
 * [prohibitedWords] are added on top of the baseline defaults in [DefaultKeywords] / the shared
 * `keywordLists/default` doc — this list is per-family so a parent can tailor it without affecting
 * every other family. [mode360] flips monitoring from "communication apps only" to "every
 * foreground app except the whitelist" (still never passwords, never SareChild itself).
 */
data class TypingSafetySettings(
    val prohibitedWords: List<String> = emptyList(),
    val alwaysMonitorPackages: List<String> = emptyList(),
    val whitelistPackages: List<String> = emptyList(),
    val mode360: Boolean = false,
    val autoBlockEnabled: Boolean = false,
    /** LOW | MEDIUM | HIGH | CRITICAL — minimum severity that triggers an automatic app block. */
    val autoBlockSeverity: AlertSeverity = AlertSeverity.HIGH
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "prohibitedWords" to prohibitedWords,
        "alwaysMonitorPackages" to alwaysMonitorPackages,
        "whitelistPackages" to whitelistPackages,
        "mode360" to mode360,
        "autoBlockEnabled" to autoBlockEnabled,
        "autoBlockSeverity" to autoBlockSeverity.name
    )

    companion object {
        fun fromMap(map: Map<String, Any?>?): TypingSafetySettings {
            if (map == null) return TypingSafetySettings()
            @Suppress("UNCHECKED_CAST")
            val words = (map["prohibitedWords"] as? List<String>) ?: emptyList()
            @Suppress("UNCHECKED_CAST")
            val always = (map["alwaysMonitorPackages"] as? List<String>) ?: emptyList()
            @Suppress("UNCHECKED_CAST")
            val whitelist = (map["whitelistPackages"] as? List<String>) ?: emptyList()
            val severity = runCatching {
                AlertSeverity.valueOf(map["autoBlockSeverity"] as? String ?: "HIGH")
            }.getOrDefault(AlertSeverity.HIGH)
            return TypingSafetySettings(
                prohibitedWords = words,
                alwaysMonitorPackages = always,
                whitelistPackages = whitelist,
                mode360 = map["mode360"] as? Boolean ?: false,
                autoBlockEnabled = map["autoBlockEnabled"] as? Boolean ?: false,
                autoBlockSeverity = severity
            )
        }
    }
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

/**
 * One message in a device's per-device family chat thread
 * (`families/{familyId}/devices/{deviceId}/chatMessages/{msgId}`). Every paired device has
 * its own isolated thread — [deviceId] is always that thread's device, never used to imply
 * a shared/family-wide conversation. Guardians only see this thread if their uid is in that
 * device's `assignedGuardianUids` (see [DeviceStatus.assignedGuardianUids]); the family owner
 * (parent) always sees every device's thread.
 */
data class FamilyChatMessage(
    val id: String = "",
    val senderUid: String = "",
    val senderName: String = "",
    val senderRole: String = "GUARDIAN", // GUARDIAN or CHILD
    val deviceId: String? = null,
    val text: String? = null,
    val mediaUrl: String? = null,
    val mediaPath: String? = null,
    val mediaType: String? = null, // image | audio | video
    /** Playback length for audio/video notes, in milliseconds. */
    val durationMs: Long? = null,
    val createdAtMs: Long = System.currentTimeMillis()
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "senderUid" to senderUid,
        "senderName" to senderName,
        "senderRole" to senderRole,
        "deviceId" to deviceId,
        "text" to text,
        "mediaUrl" to mediaUrl,
        "mediaPath" to mediaPath,
        "mediaType" to mediaType,
        "durationMs" to durationMs,
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

/** Structured activity row for the Event Recorder timeline (parent-web + Firestore). */
enum class ActivityEventType {
    APP_FOREGROUND,
    APP_BACKGROUND,
    SCREEN_ON,
    SCREEN_OFF,
    IDLE_START,
    IDLE_END,
    MEDIA_PLAY,
    MEDIA_PAUSE,
    NOTIFICATION_MEDIA,
    WEB_VISIT_INFERRED,
    WINDOW_CHANGED,
    INTERACTION
}

data class ActivityEvent(
    val id: String = "",
    val deviceId: String = "",
    val type: ActivityEventType = ActivityEventType.APP_FOREGROUND,
    val packageName: String? = null,
    val appLabel: String? = null,
    val title: String? = null,
    val details: String? = null,
    val url: String? = null,
    val inferred: Boolean = false,
    val startedAtMs: Long? = null,
    val endedAtMs: Long? = null,
    val durationMs: Long? = null,
    val createdAtMs: Long = System.currentTimeMillis()
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "deviceId" to deviceId,
        "type" to type.name,
        "packageName" to packageName,
        "appLabel" to appLabel,
        "title" to title,
        "details" to details,
        "url" to url,
        "inferred" to inferred,
        "startedAtMs" to startedAtMs,
        "endedAtMs" to endedAtMs,
        "durationMs" to durationMs,
        "createdAtMs" to createdAtMs
    )

    companion object {
        fun fromMap(id: String, map: Map<String, Any?>?): ActivityEvent? {
            if (map == null) return null
            val type = runCatching {
                ActivityEventType.valueOf(map["type"] as? String ?: return null)
            }.getOrNull() ?: return null
            return ActivityEvent(
                id = id,
                deviceId = map["deviceId"] as? String ?: "",
                type = type,
                packageName = map["packageName"] as? String,
                appLabel = map["appLabel"] as? String,
                title = map["title"] as? String,
                details = map["details"] as? String,
                url = map["url"] as? String,
                inferred = map["inferred"] as? Boolean ?: false,
                startedAtMs = (map["startedAtMs"] as? Number)?.toLong(),
                endedAtMs = (map["endedAtMs"] as? Number)?.toLong(),
                durationMs = (map["durationMs"] as? Number)?.toLong(),
                createdAtMs = (map["createdAtMs"] as? Number)?.toLong() ?: 0L
            )
        }
    }
}
