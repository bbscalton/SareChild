package com.sarechild.shared

enum class AlertType {
    SOS,
    KEYWORD,
    GEOFENCE_ENTER,
    GEOFENCE_EXIT,
    LOW_BATTERY,
    WENT_DARK,
    TAMPER,
    PERMISSION_REVOKED,
    SCREEN_SHARE,
    CAMERA_CHECK,
    MIC_CHECK,
    MESSAGE_PREVIEW,
    APP_INSTALL,
    APP_UNINSTALL,
    RING_DEVICE,
    USAGE_LIMIT,
    APP_BLOCKED,
    UNIDENTIFIED_CONTACT,
    CHECK_IN,
    OFFLINE_EVIDENCE,
    CALL_SMS_SYNC,
    DEVICE_LOCKED,
    DEVICE_UNLOCKED,
    WHATSAPP_MEDIA,
    WHATSAPP_CALL,
    // A prohibited-word match from the Typing safety / message shield monitor
    // (see TypingSafetyEvent / MessageMonitorAccessibilityService). Distinct from
    // KEYWORD (legacy on-screen risk alert) so parent-web/parent-Android can route
    // it to the dedicated "Typing safety" section instead of the generic feed.
    TYPING_SAFETY
}

enum class AlertSeverity {
    LOW,
    MEDIUM,
    HIGH,
    CRITICAL
}

enum class KeywordCategory {
    SEX,
    DRUGS,
    GROOMING,
    SELF_HARM,
    VIOLENCE,
    OTHER
}

enum class SafetyCommandType {
    SCREEN_SHARE,
    CAMERA_CHECK,
    MIC_CHECK,
    STOP_SCREEN_SHARE,
    RING_DEVICE,
    SYNC_CALL_SMS,
    LOCK_DEVICE,
    UNLOCK_DEVICE
}

enum class SafetyCommandStatus {
    PENDING,
    ACCEPTED,
    DECLINED,
    RUNNING,
    COMPLETED,
    FAILED,
    CANCELLED
}

enum class GuardianRole {
    OWNER,
    CAREGIVER
}

/**
 * Classification for a single WhatsApp activity record (see [WhatsAppEvent]). Derived from
 * best-effort heuristics on notification text / on-screen text / MediaStore file metadata —
 * WhatsApp's chat database itself is end-to-end encrypted and never read.
 */
enum class WhatsAppEventType {
    MESSAGE,
    CALL,
    IMAGE,
    VOICE_NOTE,
    VIDEO,
    DOCUMENT,
    /** First-ever sighting of this (non-whitelisted) contact/handle on this device. */
    UNKNOWN_CONTACT
}
