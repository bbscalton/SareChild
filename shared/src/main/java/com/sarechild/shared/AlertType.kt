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
    /** WebRTC live viewing session started or ended. */
    LIVE_VIEW,
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
    /** A call recording was uploaded or a call event logged (cellular / VoIP partial). */
    CALL_RECORDING,
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
    /** Parent requests a WebRTC live viewing session — child must consent first. */
    START_LIVE_VIEW,
    /** Parent or timer ends an active live viewing session. */
    STOP_LIVE_VIEW,
    CAMERA_CHECK,
    MIC_CHECK,
    STOP_SCREEN_SHARE,
    RING_DEVICE,
    SYNC_CALL_SMS,
    LOCK_DEVICE,
    UNLOCK_DEVICE,
    /** Parent asks child to enable WhatsApp protection (consent + OS permission setup). */
    REQUEST_WHATSAPP_PROTECTION,
    /** Parent asks child to enable call recording (consent + mic / phone-state permissions). */
    REQUEST_CALL_RECORDING,
    /** Parent asks child to upload a fresh installed-app inventory snapshot. */
    REQUEST_APP_INVENTORY,
    /** Parent asks child to enable photo gallery monitoring (consent + media permissions). */
    REQUEST_PHOTO_ACCESS,
    /** Parent asks child to run a full photo gallery rescan now. */
    REQUEST_PHOTO_SYNC,
    /** Parent asks child to enable Event Recorder (consent + usage/accessibility/notification setup). */
    REQUEST_EVENT_RECORDER_ACCESS,
    /** Parent asks child to flush pending activity events to Firestore now. */
    REQUEST_EVENT_RECORDER_SYNC
}

/**
 * Classification for a call recording row. Native Android — not Cordova plugins.
 * CELLULAR: best-effort via MediaRecorder + phone state (full two-way may be blocked on Android 10+).
 * VOIP_PARTIAL: mic-side only while a VoIP call notification is active (WhatsApp, Telegram, etc.).
 * MISSED: call event logged without audio (ring → idle, or log-only when capture failed).
 */
enum class CallRecordingType {
    CELLULAR,
    VOIP_PARTIAL,
    MISSED
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
