package com.sarechild.shared

object SareChildConstants {
    const val APP_NAME = "SareChild"
    const val PROTECTED_LABEL = "Protected by SareChild"
    const val R2_MEDIA_PROXY_BASE_URL = "https://sarechild-media-proxy.neuereatec.workers.dev"

    const val COL_FAMILIES = "families"
    const val COL_DEVICES = "devices"
    const val COL_GEOFENCES = "geofences"
    const val COL_ALERTS = "alerts"
    const val COL_PAIRING_CODES = "pairingCodes"
    const val COL_KEYWORD_LISTS = "keywordLists"
    const val COL_COMMANDS = "commands"
    const val COL_APP_EVENTS = "appEvents"
    const val COL_USAGE_DAILY = "usageDaily"
    const val COL_LOCATION_TRAIL = "locationTrail"
    const val COL_CALL_SMS = "callSmsPreviews"
    const val COL_GUARDIANS = "guardians"
    const val COL_DIGESTS = "digests"
    const val COL_SOS_CONTACTS = "sosContacts"
    const val COL_SAFE_CONTACTS = "safeContacts"
    const val COL_APP_LIMITS = "appLimits"
    const val COL_APP_BLOCK_SCHEDULES = "appBlockSchedules"
    const val COL_FAMILY_CHAT = "familyChat"
    const val COL_SAFETY_SETTINGS = "safetySettings"
    const val COL_GUARDIAN_INVITES = "guardianInvites"
    const val COL_SCREEN_SHARE_SCHEDULES = "screenShareSchedules"
    // Dedicated WhatsApp protection section: one row per detected message/call/media event.
    // See shared.WhatsAppEvent and child/monitoring/WhatsAppMonitor.
    const val COL_WHATSAPP_EVENTS = "whatsappEvents"
    // "Typing safety / message shield" section: one row per debounced on-screen text
    // settle in a monitored app (see shared.TypingSafetyEvent / child MessageMonitorAccessibilityService),
    // plus the parent-managed rules doc that drives it.
    const val COL_TYPING_EVENTS = "typingEvents"
    const val COL_TYPING_SAFETY_SETTINGS = "typingSafetySettings"
    // Parent-authored Home/School/Work/Custom pins for the parent-web Live Map
    // control center (see parent-web/src/pages/LiveMapPage.tsx). Not yet read/written
    // by either Android app — kept here so the collection name stays a single
    // source of truth if a future on-device feature (e.g. "distance to school") needs it.
    const val COL_MAP_PLACES = "mapPlaces"
    // Parent "Call recording" section: one row per cellular / VoIP call event (with optional
    // uploaded audio). Written by child/monitoring/CallRecordingMonitor and VoipCallRecordingHelper.
    const val COL_CALL_RECORDINGS = "callRecordings"
    /** Per-device installed app inventory (child syncs via PackageManager). */
    const val COL_INSTALLED_APPS = "installedApps"
    /** Per-device photo gallery metadata synced from MediaStore (nested under devices/{id}/photos). */
    const val COL_PHOTOS = "photos"
    /** Per-device structured activity timeline (Event Recorder). Nested under devices/{id}/activityEvents. */
    const val COL_ACTIVITY_EVENTS = "activityEvents"
    /** WebRTC live viewing signaling + session metadata (parent-web ↔ child). */
    const val COL_LIVE_SESSIONS = "liveSessions"
    /** Recorded live viewing sessions (R2 URL + metadata). */
    const val COL_LIVE_RECORDINGS = "liveRecordings"
    /** Top-level daily live-view credit quota per parent uid. */
    const val COL_LIVE_VIEW_QUOTA = "liveViewQuota"

    const val KEYWORD_LIST_DEFAULT = "default"

    const val HEARTBEAT_INTERVAL_MS = 60_000L
    // Every heartbeat tick (60s) also appends the most recent fused-location fix to
    // `locationTrail` (see MonitoringForegroundService.tick()), so real-world trail
    // density is ~once/minute — dense enough for the Live Map's stop-detection
    // (default 5-minute minimum dwell) and history playback without changing the
    // underlying GPS request cadence below. We intentionally did NOT tighten
    // LOCATION_INTERVAL_MS/minUpdateInterval further for this feature: halving it
    // would roughly double location-fix wakeups/battery draw for a marginal
    // playback-smoothness gain that most parents won't notice. If sparser trails
    // ever become a real complaint, prefer significant-motion-triggered extra
    // samples over a blanket interval decrease.
    const val LOCATION_INTERVAL_MS = 120_000L
    const val WENT_DARK_AFTER_MS = 5 * 60_000L
    const val LOW_BATTERY_PERCENT = 15
    const val ALERT_RETENTION_DAYS = 30
    const val MEDIA_RETENTION_DAYS = 7
    // Trial subscription model — see functions/src/index.ts purgeInactiveTrials for the
    // server-side purge rule and README "Trial model" for the plain-language summary.
    const val TRIAL_DAYS = 30
    const val COL_PARENT_PROFILES = "parentProfiles"
    const val MIC_CHECK_SECONDS = 10
    const val SCREEN_FRAME_INTERVAL_MS = 2_000L
    const val SCREEN_SHARE_DEFAULT_MINUTES = 10
    const val SCREEN_SHARE_MAX_MINUTES = 60
    const val SCREEN_SHARE_MIN_MINUTES = 5
    const val MESSAGE_PREVIEW_MIN_RISK_SCORE = 20
    const val BATTERY_HISTORY_MAX = 24
    const val USAGE_SYNC_INTERVAL_MS = 15 * 60_000L
    const val USAGE_BLOCK_ENFORCE_INTERVAL_MS = 10_000L
    /** Minimum interval between full installed-app inventory uploads. */
    const val APP_INVENTORY_SYNC_INTERVAL_MS = 6 * 60 * 60_000L
    /** Minimum interval between photo gallery MediaStore sync passes. */
    const val PHOTO_SYNC_INTERVAL_MS = 4 * 60 * 60_000L
    /** Minimum interval between Event Recorder usage/media poll passes. */
    const val EVENT_RECORDER_SYNC_INTERVAL_MS = 5 * 60_000L
    /** Screen-off or no foreground activity for this long → IDLE_START. */
    const val EVENT_RECORDER_IDLE_MS = 5 * 60_000L
    /** Foreground sessions shorter than this are merged into the next session. */
    const val EVENT_RECORDER_MIN_FOREGROUND_MS = 3_000L
    /** Max accessibility-derived events per minute (navigation/interaction). */
    const val EVENT_RECORDER_A11Y_RATE_PER_MIN = 30
    /** Max events buffered locally before a forced upload. */
    const val EVENT_RECORDER_BATCH_MAX = 40
    /** Max width for uploaded photo thumbnails (JPEG). */
    const val PHOTO_THUMB_MAX_PX = 320
    const val OFFLINE_EVIDENCE_MIN_INTERVAL_MS = 20 * 60_000L
    const val OFFLINE_SMS_FALLBACK_INTERVAL_MS = 15 * 60_000L
    const val OFFLINE_CALL_FALLBACK_INTERVAL_MS = 20 * 60_000L
    const val CALL_SMS_SYNC_LIMIT = 40
    const val SMS_SNIPPET_MAX = 120
    const val WHATSAPP_PACKAGE = "com.whatsapp"
    const val WHATSAPP_BUSINESS_PACKAGE = "com.whatsapp.w4b"
    /** How long a media event "remembers" the most recent notification contact for correlation. */
    const val WHATSAPP_CONTACT_CORRELATION_MS = 3 * 60_000L
    /** Per-contact/type alert throttle so a burst of activity raises one alert, not many. */
    const val WHATSAPP_ALERT_DEDUPE_MS = 5 * 60_000L
    // Typing safety: how long a text field must "settle" (no further changes) before its
    // content is captured — keeps this a snippet-per-thought capture, not a per-keystroke log.
    const val TYPING_SAFETY_DEBOUNCE_MS = 1_500L
    const val TYPING_SAFETY_SNIPPET_MAX = 220
    // Re-captures of unchanged text in the same app are suppressed for this long.
    const val TYPING_SAFETY_DEDUPE_MS = 30_000L
    /** On-screen WhatsApp rows with the same contact+message are suppressed for this long. */
    const val WHATSAPP_ONSCREEN_DEDUPE_MS = 3 * 60_000L

    const val PREFS_NAME = "sarechild_prefs"
    const val PREF_FAMILY_ID = "family_id"
    const val PREF_DEVICE_ID = "device_id"
    const val PREF_CHILD_NAME = "child_name"
    const val PREF_CONSENT_DONE = "consent_done"
    const val PREF_FCM_TOKEN = "fcm_token"
    const val PREF_SCREEN_SHARE_CONSENT = "screen_share_consent"
    const val PREF_CAMERA_CHECK_CONSENT = "camera_check_consent"
    const val PREF_MIC_CHECK_CONSENT = "mic_check_consent"
    const val PREF_MESSAGE_MONITOR_CONSENT = "message_monitor_consent"
    const val PREF_INSTALL_MONITOR_CONSENT = "install_monitor_consent"
    const val PREF_USAGE_CONSENT = "usage_consent"
    const val PREF_CALL_SMS_CONSENT = "call_sms_consent"
    const val PREF_OFFLINE_SMS_FALLBACK_CONSENT = "offline_sms_fallback_consent"
    const val PREF_OFFLINE_AUTO_CALL_CONSENT = "offline_auto_call_consent"
    const val PREF_WHATSAPP_MONITOR_CONSENT = "whatsapp_monitor_consent"
    /** Consent for visible call recording (cellular best-effort + VoIP mic-side partial). */
    const val PREF_CALL_RECORDING_CONSENT = "call_recording_consent"
    /** Whether call recording is actively enabled after consent (parent can request enable). */
    const val PREF_CALL_RECORDING_ENABLED = "call_recording_enabled"
    const val PREF_LAST_WHATSAPP_EVENT_AT_MS = "last_whatsapp_event_at_ms"
    const val PREF_LAST_CALL_RECORDING_AT_MS = "last_call_recording_at_ms"
    const val PREF_OFFLINE_CALL_ENABLED = "offline_call_enabled"
    const val PREF_OFFLINE_CALL_NUMBER = "offline_call_number"
    const val PREF_OFFLINE_CALL_MAX_ATTEMPTS = "offline_call_max_attempts"
    const val PREF_ACTIVE_SESSION = "active_session"
    const val PREF_LAST_OFFLINE_EVIDENCE_MS = "last_offline_evidence_ms"
    const val PREF_LAST_OFFLINE_SMS_MS = "last_offline_sms_ms"
    const val PREF_LAST_OFFLINE_CALL_MS = "last_offline_call_ms"
    const val PREF_LAST_APP_INVENTORY_SYNC_MS = "last_app_inventory_sync_ms"
    /** Consent for parent-visible device photo gallery monitoring. */
    const val PREF_PHOTO_GALLERY_CONSENT = "photo_gallery_consent"
    const val PREF_LAST_PHOTO_SYNC_MS = "last_photo_sync_ms"
    const val PREF_LAST_PHOTO_MODIFIED_MS = "last_photo_modified_ms"
    const val PREF_SYNCED_PHOTO_COUNT = "synced_photo_count"
    /** Consent for structured Event Recorder timeline (apps, idle, media, inferred web). */
    const val PREF_EVENT_RECORDER_CONSENT = "event_recorder_consent"
    const val PREF_LAST_EVENT_RECORDER_SYNC_MS = "last_event_recorder_sync_ms"
    const val PREF_LAST_USAGE_EVENT_POLL_MS = "last_usage_event_poll_ms"
    const val PREF_EVENT_RECORDER_EVENT_COUNT_24H = "event_recorder_event_count_24h"
    const val PREF_LAST_ACTIVITY_AT_MS = "last_activity_at_ms"

    const val NOTIFICATION_CHANNEL_MONITORING = "monitoring"
    const val NOTIFICATION_CHANNEL_ALERTS = "alerts"
    const val NOTIFICATION_CHANNEL_SAFETY = "safety_checks"
    // Family chat push: kept distinct from ALERTS/SAFETY so a chat message never gets
    // silenced/misrouted if a user tweaks those channels, and so an urgent chat message
    // (keyword match) can escalate to a louder, alarm-toned channel without touching SOS.
    const val NOTIFICATION_CHANNEL_FAMILY_CHAT = "family_chat"
    const val NOTIFICATION_CHANNEL_CHAT_URGENT = "family_chat_urgent"
    const val FGS_NOTIFICATION_ID = 1001
    const val SAFETY_NOTIFICATION_ID = 1002
    const val SCREEN_NOTIFICATION_ID = 1003
    const val MESSAGE_MONITOR_NOTIFICATION_ID = 1004
    const val RING_NOTIFICATION_ID = 1005
    const val CALL_SMS_NOTIFICATION_ID = 1006
    const val USAGE_NOTIFICATION_ID = 1007
    const val DEVICE_LOCK_NOTIFICATION_ID = 1008
    const val CHAT_NOTIFICATION_ID = 1009
    const val CALL_RECORDING_NOTIFICATION_ID = 1010
    const val NOTIFICATION_CHANNEL_CALL_RECORDING = "call_recording"

    // FCM data-payload keys shared by the family chat Cloud Function and both apps.
    const val FCM_DATA_TYPE = "type"
    const val FCM_TYPE_FAMILY_CHAT = "FAMILY_CHAT"
    const val FCM_DATA_URGENT = "urgent"
    const val FCM_DATA_SCREEN = "screen"
    const val FCM_SCREEN_FAMILY_CHAT = "family_chat"
    const val EXTRA_OPEN_CHAT = "open_chat"

    const val EXTRA_COMMAND_ID = "command_id"
    const val EXTRA_COMMAND_TYPE = "command_type"
    const val EXTRA_CAMERA_FACING = "camera_facing"
    const val EXTRA_DURATION_MINUTES = "duration_minutes"
    const val EXTRA_SCHEDULE_ID = "schedule_id"
    const val ACTION_DEVICE_UNLOCK = "com.sarechild.child.ACTION_DEVICE_UNLOCK"
    const val PREF_DEVICE_LOCKED = "device_locked"
    const val PREF_LAST_LOCK_AT_MS = "last_lock_at_ms"
    const val PREF_LAST_LOCK_RESULT = "last_lock_result"

    /**
     * How long a child has to tap Allow/Not now on an in-app parent request
     * (screen share, camera check, mic check, etc.) before it auto-allows.
     * Exists so an emergency where the child can't reach the phone doesn't
     * leave the parent stuck waiting forever. Never applies to OS-controlled
     * system permission dialogs — only our own in-app Allow screens.
     */
    const val PARENT_REQUEST_AUTO_ALLOW_SECONDS = 30

    /** Live viewing: 1 credit = 1 minute of streaming. Trial default allowance. */
    const val LIVE_VIEW_DAILY_CREDITS = 10
    const val LIVE_VIEW_MIN_MINUTES = 1
    const val LIVE_VIEW_MAX_MINUTES = 5
    const val LIVE_VIEW_DEFAULT_MINUTES = 1
    const val STUN_SERVER = "stun:stun.l.google.com:19302"

    const val EXTRA_LIVE_SESSION_ID = "live_session_id"
    const val EXTRA_LIVE_VIDEO = "live_video"
    const val EXTRA_LIVE_AUDIO = "live_audio"
    const val EXTRA_LIVE_SCREEN = "live_screen"
    const val EXTRA_LIVE_RECORD = "live_record"
    const val LIVE_VIEW_NOTIFICATION_ID = 1011
    const val NOTIFICATION_CHANNEL_LIVE_VIEW = "live_viewing"
}
