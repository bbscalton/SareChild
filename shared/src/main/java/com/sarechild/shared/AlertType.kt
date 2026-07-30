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
    DEVICE_LOCKED
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
