package com.sarechild.child.data

import android.content.Context
import android.net.Uri
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.storage.FirebaseStorage
import com.sarechild.child.DeviceAdminHelper
import com.sarechild.shared.ActivityEvent
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.AppBlockSchedule
import com.sarechild.shared.AppLimit
import com.sarechild.shared.BatterySample
import com.sarechild.shared.CallRecordingEvent
import com.sarechild.shared.DevicePhoto
import com.sarechild.shared.CallRecordingType
import com.sarechild.shared.CallSmsPreview
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.FamilyChatMessage
import com.sarechild.shared.FamilySafetySettings
import com.sarechild.shared.GeofenceZone
import com.sarechild.shared.InstalledApp
import com.sarechild.shared.GuardianInfo
import com.sarechild.shared.GuardianRole
import com.sarechild.shared.KeywordMatcher
import com.sarechild.shared.LatLngPoint
import com.sarechild.shared.SafetyCommand
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import com.sarechild.shared.ScreenShareSchedule
import com.sarechild.shared.SafeContact
import com.sarechild.shared.SosContact
import com.sarechild.shared.TypingSafetyEvent
import com.sarechild.shared.TypingSafetySettings
import com.sarechild.shared.UsageAppEntry
import com.sarechild.shared.WhatsAppEvent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.tasks.await
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

class ChildRepository(
    private val context: Context,
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
    private val db: FirebaseFirestore = FirebaseFirestore.getInstance(),
    private val storage: FirebaseStorage = FirebaseStorage.getInstance()
) {
    private val prefs = context.getSharedPreferences(SareChildConstants.PREFS_NAME, Context.MODE_PRIVATE)

    var familyId: String?
        get() = prefs.getString(SareChildConstants.PREF_FAMILY_ID, null)
        set(value) = prefs.edit().putString(SareChildConstants.PREF_FAMILY_ID, value).apply()

    var deviceId: String?
        get() = prefs.getString(SareChildConstants.PREF_DEVICE_ID, null)
        set(value) = prefs.edit().putString(SareChildConstants.PREF_DEVICE_ID, value).apply()

    var childName: String
        get() = prefs.getString(SareChildConstants.PREF_CHILD_NAME, "Child") ?: "Child"
        set(value) = prefs.edit().putString(SareChildConstants.PREF_CHILD_NAME, value).apply()

    var consentDone: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_CONSENT_DONE, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_CONSENT_DONE, value).apply()

    var screenShareConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_SCREEN_SHARE_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_SCREEN_SHARE_CONSENT, value).apply()

    var cameraCheckConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_CAMERA_CHECK_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_CAMERA_CHECK_CONSENT, value).apply()

    var micCheckConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_MIC_CHECK_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_MIC_CHECK_CONSENT, value).apply()

    var messageMonitorConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_MESSAGE_MONITOR_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_MESSAGE_MONITOR_CONSENT, value).apply()

    var installMonitorConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_INSTALL_MONITOR_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_INSTALL_MONITOR_CONSENT, value).apply()

    var usageConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_USAGE_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_USAGE_CONSENT, value).apply()

    var callSmsConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_CALL_SMS_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_CALL_SMS_CONSENT, value).apply()

    var offlineSmsFallbackConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_OFFLINE_SMS_FALLBACK_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_OFFLINE_SMS_FALLBACK_CONSENT, value).apply()

    var offlineAutoCallConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_OFFLINE_AUTO_CALL_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_OFFLINE_AUTO_CALL_CONSENT, value).apply()

    /**
     * Gates the dedicated WhatsApp protection section: notification-based message/call
     * classification, MediaStore-based media detection, and whitelist-aware event recording.
     * Requires notification access (already covered by [messageMonitorConsent]'s permission)
     * plus, for media detection, the READ_MEDIA_* / READ_EXTERNAL_STORAGE runtime permission.
     */
    var whatsappMonitorConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_WHATSAPP_MONITOR_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_WHATSAPP_MONITOR_CONSENT, value).apply()

    /** Consent for visible call recording (cellular + VoIP partial). Not Cordova — native Android. */
    var callRecordingConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_CALL_RECORDING_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_CALL_RECORDING_CONSENT, value).apply()

    var callRecordingEnabled: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_CALL_RECORDING_ENABLED, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_CALL_RECORDING_ENABLED, value).apply()

    /** Consent for syncing device photo gallery metadata + thumbnails to the parent dashboard. */
    var photoGalleryConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_PHOTO_GALLERY_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_PHOTO_GALLERY_CONSENT, value).apply()

    /** Consent for structured Event Recorder activity timeline. */
    var eventRecorderConsent: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_EVENT_RECORDER_CONSENT, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_EVENT_RECORDER_CONSENT, value).apply()

    var lastEventRecorderSyncMs: Long
        get() = prefs.getLong(SareChildConstants.PREF_LAST_EVENT_RECORDER_SYNC_MS, 0L)
        set(value) = prefs.edit().putLong(SareChildConstants.PREF_LAST_EVENT_RECORDER_SYNC_MS, value).apply()

    var lastUsageEventPollMs: Long
        get() = prefs.getLong(SareChildConstants.PREF_LAST_USAGE_EVENT_POLL_MS, 0L)
        set(value) = prefs.edit().putLong(SareChildConstants.PREF_LAST_USAGE_EVENT_POLL_MS, value).apply()

    var eventRecorderEventCount24h: Int
        get() = prefs.getInt(SareChildConstants.PREF_EVENT_RECORDER_EVENT_COUNT_24H, 0)
        set(value) = prefs.edit().putInt(SareChildConstants.PREF_EVENT_RECORDER_EVENT_COUNT_24H, value).apply()

    var lastActivityAtMs: Long
        get() = prefs.getLong(SareChildConstants.PREF_LAST_ACTIVITY_AT_MS, 0L)
        set(value) = prefs.edit().putLong(SareChildConstants.PREF_LAST_ACTIVITY_AT_MS, value).apply()

    var lastPhotoSyncMs: Long
        get() = prefs.getLong(SareChildConstants.PREF_LAST_PHOTO_SYNC_MS, 0L)
        set(value) = prefs.edit().putLong(SareChildConstants.PREF_LAST_PHOTO_SYNC_MS, value).apply()

    var lastPhotoModifiedMs: Long
        get() = prefs.getLong(SareChildConstants.PREF_LAST_PHOTO_MODIFIED_MS, 0L)
        set(value) = prefs.edit().putLong(SareChildConstants.PREF_LAST_PHOTO_MODIFIED_MS, value).apply()

    var syncedPhotoCount: Int
        get() = prefs.getInt(SareChildConstants.PREF_SYNCED_PHOTO_COUNT, 0)
        set(value) = prefs.edit().putInt(SareChildConstants.PREF_SYNCED_PHOTO_COUNT, value).apply()

    fun lastCallRecordingAtMs(): Long =
        prefs.getLong(SareChildConstants.PREF_LAST_CALL_RECORDING_AT_MS, 0L)

    fun lastWhatsAppEventAtMs(): Long =
        prefs.getLong(SareChildConstants.PREF_LAST_WHATSAPP_EVENT_AT_MS, 0L)

    var activeSession: String?
        get() = prefs.getString(SareChildConstants.PREF_ACTIVE_SESSION, null)
        set(value) = prefs.edit().putString(SareChildConstants.PREF_ACTIVE_SESSION, value).apply()

    var deviceLocked: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_DEVICE_LOCKED, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_DEVICE_LOCKED, value).apply()

    var lastLockAtMs: Long
        get() = prefs.getLong(SareChildConstants.PREF_LAST_LOCK_AT_MS, 0L)
        set(value) = prefs.edit().putLong(SareChildConstants.PREF_LAST_LOCK_AT_MS, value).apply()

    var lastLockResult: String
        get() = prefs.getString(SareChildConstants.PREF_LAST_LOCK_RESULT, "").orEmpty()
        set(value) = prefs.edit().putString(SareChildConstants.PREF_LAST_LOCK_RESULT, value).apply()

    var lastAppInventorySyncMs: Long
        get() = prefs.getLong(SareChildConstants.PREF_LAST_APP_INVENTORY_SYNC_MS, 0L)
        set(value) = prefs.edit().putLong(SareChildConstants.PREF_LAST_APP_INVENTORY_SYNC_MS, value).apply()

    @Volatile
    private var cachedBlockSchedules: List<AppBlockSchedule> = emptyList()
    private var blockScheduleListener: ListenerRegistration? = null

    val isPaired: Boolean get() = !familyId.isNullOrBlank() && !deviceId.isNullOrBlank()

    /**
     * Clears local pairing/consent so [isPaired] goes false and MainActivity routes back
     * to PairingActivity. Called by [com.sarechild.child.monitoring.DeviceUnpairHandler]
     * when a parent removes this device from the parent app. Per-feature consent flags are
     * left as-is — they're only read while paired and get a fresh review on re-pairing.
     */
    fun clearPairing() {
        prefs.edit()
            .remove(SareChildConstants.PREF_FAMILY_ID)
            .remove(SareChildConstants.PREF_DEVICE_ID)
            .remove(SareChildConstants.PREF_CONSENT_DONE)
            .apply()
    }

    /**
     * Direct listener on this device's own doc. Once a parent removes the device,
     * families/{fid}/devices/{did} no longer exists, so isDeviceMember() in
     * firestore.rules can't read it — the listener gets PERMISSION_DENIED (not just
     * "does not exist"), which [DeviceUnpairHandler] treats as the removal signal.
     */
    fun listenDeviceDoc(
        familyId: String,
        deviceId: String,
        onChange: (exists: Boolean, error: com.google.firebase.firestore.FirebaseFirestoreException?) -> Unit
    ): ListenerRegistration {
        return db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_DEVICES).document(deviceId)
            .addSnapshotListener { snap, error ->
                onChange(snap?.exists() == true, error)
            }
    }

    suspend fun ensureSignedIn() {
        if (auth.currentUser == null) {
            auth.signInAnonymously().await()
        }
    }

    suspend fun claimPairingCode(code: String): Result<Unit> = runCatching {
        ensureSignedIn()
        val normalized = code.trim().uppercase()
        val doc = db.collection(SareChildConstants.COL_PAIRING_CODES).document(normalized).get().await()
        if (!doc.exists()) error("Invalid pairing code")
        if (doc.getBoolean("claimed") == true) error("Code already used")
        val expires = doc.getLong("expiresAtMs") ?: 0L
        if (System.currentTimeMillis() > expires) error("Code expired")
        val family = doc.getString("familyId") ?: error("Missing family")
        val name = doc.getString("childName") ?: "Child"
        val newDeviceId = deviceId ?: UUID.randomUUID().toString()

        db.collection(SareChildConstants.COL_FAMILIES).document(family)
            .collection(SareChildConstants.COL_DEVICES).document(newDeviceId)
            .set(
                mapOf(
                    "childName" to name,
                    "pairedAtMs" to System.currentTimeMillis(),
                    "authUid" to (auth.currentUser?.uid ?: ""),
                    "monitoringActive" to false,
                    "lastHeartbeatMs" to System.currentTimeMillis(),
                    "batteryPercent" to -1,
                    "online" to true
                ),
                SetOptions.merge()
            ).await()

        doc.reference.update(
            mapOf(
                "claimed" to true,
                "claimedAtMs" to System.currentTimeMillis(),
                "deviceId" to newDeviceId
            )
        ).await()

        familyId = family
        deviceId = newDeviceId
        childName = name

        // Register push notifications for this device right away so a guardian's very
        // first family chat message (or an alert) can reach it — don't wait for a
        // fresh onNewToken() callback, which may not fire again on this install.
        runCatching {
            val token = FirebaseMessaging.getInstance().token.await()
            saveFcmToken(token)
        }
    }

    /**
     * Persists an FCM registration token on this device's Firestore doc so the
     * `onFamilyChatMessageCreated` / `onAlertCreated` Cloud Functions can push to it.
     * Cached locally first so a token delivered via onNewToken() before pairing
     * completes isn't lost — see [claimPairingCode].
     */
    suspend fun saveFcmToken(token: String) {
        prefs.edit().putString(SareChildConstants.PREF_FCM_TOKEN, token).apply()
        val fid = familyId ?: return
        val did = deviceId ?: return
        runCatching {
            db.collection(SareChildConstants.COL_FAMILIES).document(fid)
                .collection(SareChildConstants.COL_DEVICES).document(did)
                .set(mapOf("fcmTokens" to FieldValue.arrayUnion(token)), SetOptions.merge())
                .await()
        }
    }

    fun consentMap(): Map<String, Any?> = mapOf(
        "screenShareConsent" to screenShareConsent,
        "cameraCheckConsent" to cameraCheckConsent,
        "micCheckConsent" to micCheckConsent,
        "messageMonitorConsent" to messageMonitorConsent,
        "installMonitorConsent" to installMonitorConsent,
        "usageConsent" to usageConsent,
        "callSmsConsent" to callSmsConsent,
        "offlineSmsFallbackConsent" to offlineSmsFallbackConsent,
        "offlineAutoCallConsent" to offlineAutoCallConsent,
        "whatsappMonitorConsent" to whatsappMonitorConsent,
        "photoGalleryConsent" to photoGalleryConsent,
        "eventRecorderConsent" to eventRecorderConsent,
        "callRecordingConsent" to callRecordingConsent,
        "callRecordingEnabled" to callRecordingEnabled,
        "activeSession" to activeSession
    )

    suspend fun syncConsentFlags() {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .set(consentMap(), SetOptions.merge())
            .await()
    }

    suspend fun updateHeartbeat(
        batteryPercent: Int,
        charging: Boolean,
        location: LatLngPoint?,
        notificationAccess: Boolean,
        locationPermission: Boolean,
        monitoringActive: Boolean,
        todayScreenMinutes: Int = 0,
        whatsappMediaPermission: Boolean = false,
        whatsappProtection: Map<String, Any?> = emptyMap(),
        callRecordingStatus: Map<String, Any?> = emptyMap(),
        photoGalleryStatus: Map<String, Any?> = emptyMap(),
        eventRecorderStatus: Map<String, Any?> = emptyMap(),
        lockScreenStatus: Map<String, Any?> = emptyMap()
    ) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        val sample = BatterySample(batteryPercent, charging)
        val data = mutableMapOf<String, Any?>(
            "lastHeartbeatMs" to System.currentTimeMillis(),
            "batteryPercent" to batteryPercent,
            "charging" to charging,
            "notificationAccess" to notificationAccess,
            "locationPermission" to locationPermission,
            "monitoringActive" to monitoringActive,
            "online" to true,
            "todayScreenMinutes" to todayScreenMinutes,
            "batteryHistory" to FieldValue.arrayUnion(sample.toMap()),
            "whatsappMediaPermission" to whatsappMediaPermission
        )
        if (whatsappProtection.isNotEmpty()) {
            data["whatsappProtection"] = whatsappProtection
        }
        if (callRecordingStatus.isNotEmpty()) {
            data["callRecordingStatus"] = callRecordingStatus
        }
        if (photoGalleryStatus.isNotEmpty()) {
            data["photoGalleryStatus"] = photoGalleryStatus
        }
        if (eventRecorderStatus.isNotEmpty()) {
            data["eventRecorderStatus"] = eventRecorderStatus
        }
        if (lockScreenStatus.isNotEmpty()) {
            data["lockScreenStatus"] = lockScreenStatus
        }
        data.putAll(consentMap())
        if (location != null) {
            data["lastLocation"] = location.toMap()
        }
        val ref = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
        ref.set(data, SetOptions.merge()).await()
        // Trim battery history client-side if too long
        val snap = ref.get().await()
        @Suppress("UNCHECKED_CAST")
        val history = (snap.get("batteryHistory") as? List<Map<String, Any?>>) ?: emptyList()
        if (history.size > SareChildConstants.BATTERY_HISTORY_MAX) {
            val trimmed = history.takeLast(SareChildConstants.BATTERY_HISTORY_MAX)
            ref.update("batteryHistory", trimmed).await()
        }
        // Dual-write heartbeat to Cloudflare edge (D1/KV) for fast TCD + redundancy.
        syncHeartbeatToEdge(
            familyId = fid,
            deviceId = did,
            batteryPercent = batteryPercent,
            monitoringActive = monitoringActive,
        )
    }

    private suspend fun syncHeartbeatToEdge(
        familyId: String,
        deviceId: String,
        batteryPercent: Int,
        monitoringActive: Boolean,
    ) = withContext(Dispatchers.IO) {
        try {
            val url = URL("${SareChildConstants.R2_MEDIA_PROXY_BASE_URL}/edge/sync/device")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 4_000
                readTimeout = 4_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            val payload =
                """{"familyId":"$familyId","deviceId":"$deviceId","childName":"${childName.replace("\"", "")}","lastHeartbeatMs":${System.currentTimeMillis()},"batteryPercent":$batteryPercent,"monitoringActive":$monitoringActive}"""
            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            conn.responseCode
            conn.disconnect()
        } catch (_: Exception) {
            // Best-effort edge redundancy; Firebase remains source of truth.
        }
    }

    suspend fun postAlert(alert: FamilyAlert) {
        val fid = familyId ?: return
        val withDevice = alert.copy(deviceId = deviceId ?: alert.deviceId)
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_ALERTS)
            .add(withDevice.toMap())
            .await()
    }

    suspend fun loadKeywordMatcher(extraWords: List<String> = emptyList()): KeywordMatcher {
        val snap = db.collection(SareChildConstants.COL_KEYWORD_LISTS)
            .document(SareChildConstants.KEYWORD_LIST_DEFAULT)
            .get()
            .await()
        @Suppress("UNCHECKED_CAST")
        val categories = snap.get("categories") as? Map<String, Any?>
        return KeywordMatcher.fromFirestoreMap(categories, extraWords)
    }

    /**
     * Loads the family's Typing safety rules (prohibited-word additions, whitelist/always-monitor
     * app lists, 360 mode, auto-block threshold). Falls back to all-defaults (communication-apps
     * only, no auto-block) if the family hasn't configured anything yet.
     */
    suspend fun loadTypingSafetySettings(): TypingSafetySettings {
        val fid = familyId ?: return TypingSafetySettings()
        val doc = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_TYPING_SAFETY_SETTINGS)
            .document("default")
            .get()
            .await()
        return TypingSafetySettings.fromMap(doc.data)
    }

    /**
     * Writes one row to the Typing safety / message shield timeline. Called for every settled
     * text change in a monitored app — whether or not it matched a prohibited word — so the
     * parent timeline is a complete "what was typed, when, in what app" view; matched-word rows
     * additionally get a companion [FamilyAlert] via [postAlert].
     */
    suspend fun postTypingEvent(event: TypingSafetyEvent) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_TYPING_EVENTS)
            .add(event.copy(deviceId = did).toMap())
            .await()
    }

    /**
     * Blocks an app on this device immediately by writing an always-on (every day, full 24h)
     * [AppBlockSchedule] row — reusing the exact same enforcement loop as parent-scheduled app
     * blocks ([com.sarechild.child.monitoring.UsageMonitorHelper.enforceScheduledBlocks]) rather
     * than a second, parallel blocking mechanism. Requires the child's usage-access permission
     * (same as any other app block/limit) to actually be enforced on-device.
     */
    suspend fun blockAppNow(packageName: String, label: String, reason: String) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_APP_BLOCK_SCHEDULES)
            .add(
                mapOf(
                    "packageName" to packageName,
                    "label" to label.ifBlank { packageName },
                    "deviceId" to did,
                    "daysOfWeek" to emptyList<Int>(),
                    "startMinute" to 0,
                    "endMinute" to 1439,
                    "active" to true,
                    "message" to "Application has been blocked.",
                    "createdAtMs" to System.currentTimeMillis(),
                    "source" to reason
                )
            ).await()
    }

    suspend fun loadGeofences(): List<GeofenceZone> {
        val fid = familyId ?: return emptyList()
        val snap = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_GEOFENCES)
            .get()
            .await()
        return snap.documents.mapNotNull { doc ->
            if (doc.getBoolean("active") == false) return@mapNotNull null
            @Suppress("UNCHECKED_CAST")
            val days = (doc.get("daysOfWeek") as? List<Number>)?.map { it.toInt() } ?: emptyList()
            GeofenceZone(
                id = doc.id,
                name = doc.getString("name") ?: "Zone",
                lat = doc.getDouble("lat") ?: return@mapNotNull null,
                lng = doc.getDouble("lng") ?: return@mapNotNull null,
                radiusM = (doc.getDouble("radiusM") ?: 200.0).toFloat(),
                active = true,
                daysOfWeek = days,
                startMinute = doc.getLong("startMinute")?.toInt(),
                endMinute = doc.getLong("endMinute")?.toInt()
            )
        }
    }

    suspend fun loadGeofenceById(id: String): GeofenceZone? {
        return loadGeofences().firstOrNull { it.id == id }
    }

    suspend fun loadSosContacts(): List<SosContact> {
        val fid = familyId ?: return emptyList()
        val snap = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_SOS_CONTACTS)
            .get()
            .await()
        return snap.documents.map {
            SosContact(
                id = it.id,
                name = it.getString("name") ?: "Contact",
                phoneNote = it.getString("phoneNote") ?: ""
            )
        }
    }

    suspend fun loadSafetySettings(): FamilySafetySettings {
        val fid = familyId ?: return FamilySafetySettings()
        val doc = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_SAFETY_SETTINGS)
            .document("default")
            .get()
            .await()
        @Suppress("UNCHECKED_CAST")
        val snoozed = (doc.get("snoozedCategories") as? List<String>) ?: emptyList()
        return FamilySafetySettings(
            escalationEnabled = doc.getBoolean("escalationEnabled") ?: true,
            escalationRiskThreshold = (doc.getLong("escalationRiskThreshold") ?: 60L).toInt(),
            autoLockOnCritical = doc.getBoolean("autoLockOnCritical") ?: false,
            checkInIntervalMinutes = (doc.getLong("checkInIntervalMinutes") ?: 120L).toInt(),
            snoozedCategories = snoozed,
            snoozeUntilMs = doc.getLong("snoozeUntilMs") ?: 0L,
            alertRetentionDays = (doc.getLong("alertRetentionDays")
                ?: SareChildConstants.ALERT_RETENTION_DAYS.toLong()).toInt(),
            mediaRetentionDays = (doc.getLong("mediaRetentionDays")
                ?: SareChildConstants.MEDIA_RETENTION_DAYS.toLong()).toInt()
        )
    }

    suspend fun loadSafeContacts(channel: String = "WHATSAPP"): List<SafeContact> {
        val fid = familyId ?: return emptyList()
        val snap = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_SAFE_CONTACTS)
            .whereEqualTo("channel", channel)
            .get()
            .await()
        return snap.documents.map {
            SafeContact(
                id = it.id,
                channel = it.getString("channel") ?: channel,
                label = it.getString("label") ?: "",
                identifier = it.getString("identifier") ?: ""
            )
        }.filter { it.identifier.isNotBlank() }
    }

    suspend fun loadAppLimits(): List<AppLimit> {
        val fid = familyId ?: return emptyList()
        val did = deviceId ?: return emptyList()
        val snap = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_APP_LIMITS)
            .whereEqualTo("deviceId", did)
            .get()
            .await()
        return snap.documents.map {
            AppLimit(
                id = it.id,
                packageName = it.getString("packageName") ?: "",
                label = it.getString("label") ?: "",
                dailyLimitMinutes = (it.getLong("dailyLimitMinutes") ?: 60L).toInt(),
                deviceId = did
            )
        }
    }

    suspend fun loadAppBlockSchedules(): List<AppBlockSchedule> {
        val cached = cachedBlockSchedules
        if (cached.isNotEmpty()) return cached
        return fetchAppBlockSchedules()
    }

    fun getCachedAppBlockSchedules(): List<AppBlockSchedule> = cachedBlockSchedules

    fun startAppBlockScheduleListener() {
        val fid = familyId ?: return
        val did = deviceId ?: return
        if (blockScheduleListener != null) return
        blockScheduleListener = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_APP_BLOCK_SCHEDULES)
            .whereEqualTo("deviceId", did)
            .whereEqualTo("active", true)
            .addSnapshotListener { snap, _ ->
                cachedBlockSchedules = snap?.documents?.mapNotNull { doc ->
                    parseAppBlockSchedule(doc.id, doc.data ?: emptyMap())
                } ?: emptyList()
            }
    }

    fun stopAppBlockScheduleListener() {
        blockScheduleListener?.remove()
        blockScheduleListener = null
        cachedBlockSchedules = emptyList()
    }

    private suspend fun fetchAppBlockSchedules(): List<AppBlockSchedule> {
        val fid = familyId ?: return emptyList()
        val did = deviceId ?: return emptyList()
        val snap = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_APP_BLOCK_SCHEDULES)
            .whereEqualTo("deviceId", did)
            .whereEqualTo("active", true)
            .get()
            .await()
        return snap.documents.mapNotNull { parseAppBlockSchedule(it.id, it.data ?: emptyMap()) }
    }

    private fun parseAppBlockSchedule(id: String, data: Map<String, Any?>): AppBlockSchedule? {
        val packageName = data["packageName"] as? String ?: return null
        if (packageName.isBlank()) return null
        @Suppress("UNCHECKED_CAST")
        val days = (data["daysOfWeek"] as? List<Number>)?.map { it.toInt() } ?: emptyList()
        return AppBlockSchedule(
            id = id,
            packageName = packageName,
            label = data["label"] as? String ?: "",
            deviceId = data["deviceId"] as? String ?: "",
            daysOfWeek = days,
            startMinute = (data["startMinute"] as? Number)?.toInt() ?: 0,
            endMinute = (data["endMinute"] as? Number)?.toInt() ?: 0,
            active = data["active"] as? Boolean ?: true,
            message = data["message"] as? String ?: "Application has been blocked.",
            createdAtMs = (data["createdAtMs"] as? Number)?.toLong() ?: 0L
        )
    }

    suspend fun uploadInstalledApps(apps: List<InstalledApp>) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        ensureSignedIn()
        val now = System.currentTimeMillis()
        val batchLimit = 400
        apps.chunked(batchLimit).forEach { chunk ->
            val batch = db.batch()
            chunk.forEach { app ->
                val ref = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
                    .collection(SareChildConstants.COL_DEVICES).document(did)
                    .collection(SareChildConstants.COL_INSTALLED_APPS).document(app.packageName)
                batch.set(
                    ref,
                    app.copy(deviceId = did, updatedAtMs = now).toMap(),
                    SetOptions.merge()
                )
            }
            batch.commit().await()
        }
        runCatching {
            db.collection(SareChildConstants.COL_FAMILIES).document(fid)
                .collection(SareChildConstants.COL_DEVICES).document(did)
                .set(
                    mapOf(
                        "installedAppsCount" to apps.size,
                        "installedAppsUpdatedAtMs" to now
                    ),
                    SetOptions.merge()
                )
                .await()
        }
    }

    suspend fun postSos(location: LatLngPoint?) {
        val contacts = loadSosContacts()
        val contactLine = if (contacts.isEmpty()) {
            "Child pressed the SOS button"
        } else {
            "SOS pressed. Notify: " + contacts.joinToString { "${it.name} (${it.phoneNote})" }
        }
        postAlert(
            FamilyAlert(
                type = AlertType.SOS,
                severity = AlertSeverity.CRITICAL,
                title = "SOS from $childName",
                snippet = contactLine,
                location = location
            )
        )
    }

    suspend fun postTamper(title: String, snippet: String) {
        postAlert(
            FamilyAlert(
                type = AlertType.TAMPER,
                severity = AlertSeverity.HIGH,
                title = title,
                snippet = snippet
            )
        )
    }

    suspend fun postPermissionRevoked(permission: String) {
        postAlert(
            FamilyAlert(
                type = AlertType.PERMISSION_REVOKED,
                severity = AlertSeverity.HIGH,
                title = "Permission revoked on $childName",
                snippet = permission
            )
        )
    }

    suspend fun postLowBattery(percent: Int, location: LatLngPoint?) {
        postAlert(
            FamilyAlert(
                type = AlertType.LOW_BATTERY,
                severity = AlertSeverity.MEDIUM,
                title = "Low battery ($percent%) — $childName",
                snippet = "Device battery is low",
                location = location
            )
        )
    }

    suspend fun postAppEvent(installed: Boolean, packageName: String, label: String) {
        if (!installMonitorConsent) return
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_APP_EVENTS)
            .add(
                mapOf(
                    "deviceId" to did,
                    "packageName" to packageName,
                    "label" to label,
                    "installed" to installed,
                    "atMs" to System.currentTimeMillis()
                )
            ).await()
        postAlert(
            FamilyAlert(
                type = if (installed) AlertType.APP_INSTALL else AlertType.APP_UNINSTALL,
                severity = AlertSeverity.MEDIUM,
                title = if (installed) "App installed — $childName" else "App uninstalled — $childName",
                snippet = "$label ($packageName)"
            )
        )
    }

    suspend fun uploadUsageDaily(totalMinutes: Int, apps: List<UsageAppEntry>) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
        val docId = "${did}_$day"
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_USAGE_DAILY).document(docId)
            .set(
                mapOf(
                    "deviceId" to did,
                    "day" to day,
                    "totalMinutes" to totalMinutes,
                    "apps" to apps.map { it.toMap() },
                    "updatedAtMs" to System.currentTimeMillis()
                ),
                SetOptions.merge()
            ).await()
    }

    suspend fun addLocationTrailSample(
        location: LatLngPoint,
        batteryPercent: Int,
        charging: Boolean,
        hadNetwork: Boolean
    ) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_LOCATION_TRAIL)
            .add(
                mapOf(
                    "deviceId" to did,
                    "location" to location.toMap(),
                    "batteryPercent" to batteryPercent,
                    "charging" to charging,
                    "hadNetwork" to hadNetwork,
                    "recordedAtMs" to location.updatedAtMs,
                    "createdAtMs" to System.currentTimeMillis()
                )
            )
            .await()
    }

    suspend fun uploadCallSmsPreviews(items: List<CallSmsPreview>) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        items.forEach { item ->
            db.collection(SareChildConstants.COL_FAMILIES).document(fid)
                .collection(SareChildConstants.COL_CALL_SMS)
                .add(item.copy(deviceId = did).toMap())
                .await()
        }
        if (items.isNotEmpty()) {
            postAlert(
                FamilyAlert(
                    type = AlertType.CALL_SMS_SYNC,
                    severity = AlertSeverity.MEDIUM,
                    title = "Call & SMS summary synced — $childName",
                    snippet = "${items.size} recent items (visible monitoring)"
                )
            )
        }
    }

    /**
     * Writes one row to the dedicated WhatsApp protection timeline. Called for every detected
     * event — whitelisted contacts are still recorded (with `contactSafe=true`) so the parent
     * "All" view is complete, but see [WhatsAppMonitor] for why whitelisted contacts don't also
     * raise a [FamilyAlert].
     */
    suspend fun postWhatsAppEvent(event: WhatsAppEvent) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        ensureSignedIn()
        val now = System.currentTimeMillis()
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_WHATSAPP_EVENTS)
            .add(event.copy(deviceId = did).toMap())
            .await()
        prefs.edit().putLong(SareChildConstants.PREF_LAST_WHATSAPP_EVENT_AT_MS, now).apply()
        runCatching {
            db.collection(SareChildConstants.COL_FAMILIES).document(fid)
                .collection(SareChildConstants.COL_DEVICES).document(did)
                .set(
                    mapOf(
                        "lastWhatsAppEventAtMs" to now,
                        "whatsappProtection" to mapOf("lastEventAtMs" to now)
                    ),
                    SetOptions.merge()
                )
                .await()
        }
    }

    /**
     * Writes one row to the parent "Call recording" timeline. Native Android capture —
     * Cordova call-recorder plugins are not used in this project.
     */
    suspend fun postCallRecording(
        callType: CallRecordingType,
        direction: String,
        numberMasked: String? = null,
        contactLabel: String? = null,
        packageName: String? = null,
        durationSec: Int,
        audioUrl: String? = null,
        audioCaptured: Boolean,
        audioSourceNote: String? = null
    ) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        ensureSignedIn()
        val now = System.currentTimeMillis()
        val event = CallRecordingEvent(
            deviceId = did,
            callType = callType,
            direction = direction,
            numberMasked = numberMasked,
            contactLabel = contactLabel,
            packageName = packageName,
            durationSec = durationSec,
            audioUrl = audioUrl,
            audioCaptured = audioCaptured,
            audioSourceNote = audioSourceNote,
            createdAtMs = now
        )
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_CALL_RECORDINGS)
            .add(event.toMap())
            .await()
        prefs.edit().putLong(SareChildConstants.PREF_LAST_CALL_RECORDING_AT_MS, now).apply()
        runCatching {
            db.collection(SareChildConstants.COL_FAMILIES).document(fid)
                .collection(SareChildConstants.COL_DEVICES).document(did)
                .set(
                    mapOf(
                        "lastCallRecordingAtMs" to now,
                        "callRecordingStatus" to mapOf("lastRecordingAtMs" to now)
                    ),
                    SetOptions.merge()
                )
                .await()
        }
        postAlert(
            FamilyAlert(
                type = AlertType.CALL_RECORDING,
                severity = if (audioCaptured) AlertSeverity.MEDIUM else AlertSeverity.LOW,
                title = "Call recorded — $childName",
                snippet = buildString {
                    append(callType.name.lowercase().replace('_', ' '))
                    append(" · ${durationSec}s")
                    if (!audioCaptured) append(" (event only — no audio)")
                },
                mediaUrl = audioUrl
            )
        )
    }

    fun listenPendingCommands(
        onCommand: (SafetyCommand) -> Unit
    ): ListenerRegistration? {
        val fid = familyId ?: return null
        val did = deviceId ?: return null
        return db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_COMMANDS)
            .whereEqualTo("deviceId", did)
            .whereEqualTo("status", SafetyCommandStatus.PENDING.name)
            .orderBy("requestedAtMs", Query.Direction.DESCENDING)
            .limit(10)
            .addSnapshotListener { snap, _ ->
                snap?.documents?.forEach { doc ->
                    val cmd = SafetyCommand.fromDoc(doc.id, doc.data ?: emptyMap()) ?: return@forEach
                    onCommand(cmd)
                }
            }
    }

    suspend fun updateCommand(
        commandId: String,
        status: SafetyCommandStatus,
        resultPath: String? = null,
        resultUrl: String? = null,
        error: String? = null,
        autoAllowed: Boolean = false
    ) {
        val fid = familyId ?: return
        val data = mutableMapOf<String, Any?>(
            "status" to status.name
        )
        when (status) {
            SafetyCommandStatus.ACCEPTED, SafetyCommandStatus.RUNNING ->
                data["acceptedAtMs"] = System.currentTimeMillis()
            SafetyCommandStatus.COMPLETED, SafetyCommandStatus.FAILED, SafetyCommandStatus.DECLINED ->
                data["completedAtMs"] = System.currentTimeMillis()
            else -> Unit
        }
        if (resultPath != null) data["resultPath"] = resultPath
        if (resultUrl != null) data["resultUrl"] = resultUrl
        if (error != null) data["error"] = error
        // Lets the parent dashboard show "auto-allowed for safety" instead of implying
        // the child actively tapped Allow, for any legacy command rows that still set it.
        if (autoAllowed) data["autoAllowed"] = true
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_COMMANDS).document(commandId)
            .set(data, SetOptions.merge())
            .await()
    }

    suspend fun uploadMedia(localFile: File, folder: String, contentType: String): Pair<String, String> {
        val fid = familyId ?: error("Not paired")
        val did = deviceId ?: error("Not paired")
        val path = "families/$fid/devices/$did/$folder/${System.currentTimeMillis()}_${localFile.name}"
        uploadMediaToR2(path, localFile, contentType)?.let { return it }
        val ref = storage.reference.child(path)
        ref.putFile(Uri.fromFile(localFile)).await()
        val url = ref.downloadUrl.await().toString()
        return path to url
    }

    suspend fun upsertDevicePhoto(photo: DevicePhoto) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        val docId = photo.mediaStoreId.toString()
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .collection(SareChildConstants.COL_PHOTOS).document(docId)
            .set(photo.toMap(), SetOptions.merge())
            .await()
    }

    suspend fun updatePhotoGalleryStatus(status: Map<String, Any?>) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .set(mapOf("photoGalleryStatus" to status), SetOptions.merge())
            .await()
    }

    suspend fun postActivityEvents(events: List<ActivityEvent>) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        if (events.isEmpty()) return
        val col = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .collection(SareChildConstants.COL_ACTIVITY_EVENTS)
        val batch = db.batch()
        for (event in events) {
            val ref = col.document()
            batch.set(ref, event.copy(deviceId = did).toMap())
        }
        batch.commit().await()
        eventRecorderEventCount24h = eventRecorderEventCount24h + events.size
    }

    suspend fun updateEventRecorderStatus(status: Map<String, Any?>) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .set(mapOf("eventRecorderStatus" to status), SetOptions.merge())
            .await()
    }

    fun lockScreenStatusMap(context: Context): Map<String, Any?> {
        val adminActive = DeviceAdminHelper.isAdminActive(context)
        return mapOf(
            "deviceAdminActive" to adminActive,
            "lastLockAtMs" to lastLockAtMs,
            "lastLockResult" to lastLockResult.ifBlank { null },
            "updatedAtMs" to System.currentTimeMillis()
        )
    }

    suspend fun updateLockScreenStatus(context: Context) {
        updateLockScreenStatus(lockScreenStatusMap(context))
    }

    suspend fun updateLockScreenStatus(status: Map<String, Any?>) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .set(mapOf("lockScreenStatus" to status), SetOptions.merge())
            .await()
    }

    suspend fun recordLockScreenResult(
        context: Context,
        success: Boolean,
        message: String,
    ) {
        lastLockAtMs = System.currentTimeMillis()
        lastLockResult = if (success) "success" else message
        updateLockScreenStatus(lockScreenStatusMap(context))
    }

    private suspend fun uploadMediaToR2(
        path: String,
        localFile: File,
        contentType: String
    ): Pair<String, String>? = withContext(Dispatchers.IO) {
        val base = SareChildConstants.R2_MEDIA_PROXY_BASE_URL.trim()
        if (!base.startsWith("http")) return@withContext null
        runCatching {
            val encodedPath = path.split("/").joinToString("/") { URLEncoder.encode(it, "UTF-8") }
            val url = URL("$base/upload/$encodedPath?contentType=${URLEncoder.encode(contentType, "UTF-8")}")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "PUT"
                doOutput = true
                setRequestProperty("Content-Type", contentType)
            }
            localFile.inputStream().use { input ->
                conn.outputStream.use { output -> input.copyTo(output) }
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val mediaUrl = """"url"\s*:\s*"([^"]+)"""".toRegex().find(body)?.groupValues?.get(1)
                ?: error("R2 response missing URL")
            path to mediaUrl
        }.getOrNull()
    }

    suspend fun setLatestFrameUrl(url: String?) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .set(mapOf("latestFrameUrl" to url), SetOptions.merge())
            .await()
    }

    suspend fun setActiveSessionRemote(session: String?) {
        activeSession = session
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .set(mapOf("activeSession" to session), SetOptions.merge())
            .await()
    }

    fun listenScreenShareSchedules(onSchedules: (List<ScreenShareSchedule>) -> Unit): ListenerRegistration? {
        val fid = familyId ?: return null
        val did = deviceId ?: return null
        return db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_SCREEN_SHARE_SCHEDULES)
            .whereEqualTo("deviceId", did)
            .whereEqualTo("active", true)
            .addSnapshotListener { snap, _ ->
                val list = snap?.documents?.mapNotNull { doc ->
                    @Suppress("UNCHECKED_CAST")
                    val days = (doc.get("daysOfWeek") as? List<Number>)?.map { it.toInt() } ?: emptyList()
                    ScreenShareSchedule(
                        id = doc.id,
                        deviceId = doc.getString("deviceId") ?: "",
                        label = doc.getString("label") ?: "Scheduled check",
                        daysOfWeek = days,
                        startMinute = (doc.getLong("startMinute") ?: 0L).toInt(),
                        durationMinutes = (doc.getLong("durationMinutes")
                            ?: SareChildConstants.SCREEN_SHARE_DEFAULT_MINUTES.toLong()).toInt(),
                        active = doc.getBoolean("active") ?: true,
                        lastTriggeredDayKey = doc.getString("lastTriggeredDayKey")
                    )
                } ?: emptyList()
                onSchedules(list)
            }
    }

    suspend fun markScheduleTriggered(scheduleId: String, dayKey: String) {
        val fid = familyId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_SCREEN_SHARE_SCHEDULES).document(scheduleId)
            .update("lastTriggeredDayKey", dayKey)
            .await()
    }

    suspend fun getCommandDurationMinutes(commandId: String): Int? {
        val fid = familyId ?: return null
        val doc = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_COMMANDS).document(commandId)
            .get().await()
        return (doc.getLong("durationMinutes"))?.toInt()
    }

    suspend fun loadOfflineCallConfig(): Triple<Boolean, String?, Int> {
        val cached = Triple(
            prefs.getBoolean(SareChildConstants.PREF_OFFLINE_CALL_ENABLED, false),
            prefs.getString(SareChildConstants.PREF_OFFLINE_CALL_NUMBER, null),
            prefs.getInt(SareChildConstants.PREF_OFFLINE_CALL_MAX_ATTEMPTS, 0).coerceIn(0, 10)
        )
        val fid = familyId ?: return cached
        val did = deviceId ?: return cached
        return runCatching {
            val doc = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
                .collection(SareChildConstants.COL_DEVICES).document(did)
                .get().await()
            val enabled = doc.getBoolean("offlineCallEnabled") ?: false
            val number = doc.getString("offlineCallNumber")
            val maxAttempts = (doc.getLong("offlineCallMaxAttempts") ?: 0L).toInt().coerceIn(0, 10)
            prefs.edit()
                .putBoolean(SareChildConstants.PREF_OFFLINE_CALL_ENABLED, enabled)
                .putString(SareChildConstants.PREF_OFFLINE_CALL_NUMBER, number)
                .putInt(SareChildConstants.PREF_OFFLINE_CALL_MAX_ATTEMPTS, maxAttempts)
                .apply()
            Triple(enabled, number, maxAttempts)
        }.getOrDefault(cached)
    }

    /** This device's own chat thread — families/{fid}/devices/{did}/chatMessages. A child
     *  device only ever has one thread (its own), so no deviceId parameter is needed here. */
    private fun deviceChatCollection(fid: String, did: String) =
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .collection(SareChildConstants.COL_CHAT_MESSAGES)

    fun listenFamilyChat(onMessages: (List<FamilyChatMessage>) -> Unit): ListenerRegistration? {
        val fid = familyId ?: return null
        val did = deviceId ?: return null
        return deviceChatCollection(fid, did)
            .orderBy("createdAtMs", Query.Direction.ASCENDING)
            .limit(300)
            .addSnapshotListener { snap, _ ->
                val msgs = snap?.documents?.map { doc ->
                    FamilyChatMessage(
                        id = doc.id,
                        senderUid = doc.getString("senderUid") ?: "",
                        senderName = doc.getString("senderName") ?: "Family",
                        senderRole = doc.getString("senderRole") ?: "GUARDIAN",
                        deviceId = doc.getString("deviceId") ?: did,
                        text = doc.getString("text"),
                        mediaUrl = doc.getString("mediaUrl"),
                        mediaPath = doc.getString("mediaPath"),
                        mediaType = doc.getString("mediaType"),
                        durationMs = doc.getLong("durationMs"),
                        createdAtMs = doc.getLong("createdAtMs") ?: 0L
                    )
                } ?: emptyList()
                onMessages(msgs)
            }
    }

    suspend fun sendFamilyChatMessage(
        text: String? = null,
        mediaUrl: String? = null,
        mediaPath: String? = null,
        mediaType: String? = null,
        durationMs: Long? = null
    ) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        val uid = auth.currentUser?.uid ?: ""
        val msg = FamilyChatMessage(
            senderUid = uid,
            senderName = childName,
            senderRole = "CHILD",
            deviceId = did,
            text = text?.trim()?.ifBlank { null },
            mediaUrl = mediaUrl,
            mediaPath = mediaPath,
            mediaType = mediaType,
            durationMs = durationMs
        )
        deviceChatCollection(fid, did).add(msg.toMap()).await()
        markChatRead()
    }

    /** Records that the child has seen this thread up to now — drives the parent/guardian
     *  unread badge math (see DeviceStatus.chatReads). */
    suspend fun markChatRead() {
        val fid = familyId ?: return
        val did = deviceId ?: return
        val uid = auth.currentUser?.uid ?: return
        runCatching {
            db.collection(SareChildConstants.COL_FAMILIES).document(fid)
                .collection(SareChildConstants.COL_DEVICES).document(did)
                .update("${SareChildConstants.FIELD_CHAT_READS}.$uid", System.currentTimeMillis())
                .await()
        }
    }

    /** Family-level (TCD-configurable) cap on chat video note length, seconds. Falls back to
     *  the product default (180s / 3 min) if the family doc has no override. */
    suspend fun getMaxChatVideoSeconds(): Int {
        val fid = familyId ?: return SareChildConstants.CHAT_VIDEO_SECONDS_DEFAULT_MAX
        return runCatching {
            val doc = db.collection(SareChildConstants.COL_FAMILIES).document(fid).get().await()
            (doc.getLong(SareChildConstants.FIELD_MAX_CHAT_VIDEO_SECONDS))?.toInt()
        }.getOrNull() ?: SareChildConstants.CHAT_VIDEO_SECONDS_DEFAULT_MAX
    }

    suspend fun setChildChatPresence(online: Boolean) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_DEVICES).document(did)
            .set(
                mapOf(
                    "chatOnline" to online,
                    "chatLastSeenMs" to System.currentTimeMillis()
                ),
                SetOptions.merge()
            )
            .await()
    }

    fun listenGuardiansPresence(onGuardians: (List<GuardianInfo>) -> Unit): ListenerRegistration? {
        val fid = familyId ?: return null
        return db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_GUARDIANS)
            .addSnapshotListener { snap, _ ->
                val guardians = snap?.documents?.map { doc ->
                    GuardianInfo(
                        uid = doc.id,
                        email = doc.getString("email") ?: "",
                        role = runCatching {
                            GuardianRole.valueOf(doc.getString("role") ?: "CAREGIVER")
                        }.getOrDefault(GuardianRole.CAREGIVER),
                        joinedAtMs = doc.getLong("joinedAtMs") ?: 0L,
                        chatOnline = doc.getBoolean("chatOnline") ?: false,
                        lastSeenMs = doc.getLong("lastSeenMs") ?: 0L
                    )
                } ?: emptyList()
                onGuardians(guardians)
            }
    }

    suspend fun updateLiveSession(sessionId: String, patch: Map<String, Any?>) {
        val fid = familyId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_LIVE_SESSIONS).document(sessionId)
            .set(patch, SetOptions.merge())
            .await()
    }

    suspend fun addLiveSessionIceCandidate(sessionId: String, side: String, candidate: Map<String, Any?>) {
        val fid = familyId ?: return
        val field = if (side == "child") "childCandidates" else "parentCandidates"
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_LIVE_SESSIONS).document(sessionId)
            .update(field, FieldValue.arrayUnion(candidate))
            .await()
    }

    fun listenLiveSession(sessionId: String, onData: (Map<String, Any?>) -> Unit): ListenerRegistration? {
        val fid = familyId ?: return null
        return db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_LIVE_SESSIONS).document(sessionId)
            .addSnapshotListener { snap, _ ->
                val data = snap?.data ?: return@addSnapshotListener
                onData(data)
            }
    }

    suspend fun createLiveRecording(
        sessionId: String,
        path: String,
        url: String,
        durationSec: Int,
        sizeBytes: Long,
    ) {
        val fid = familyId ?: return
        val did = deviceId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_LIVE_RECORDINGS)
            .add(
                mapOf(
                    "sessionId" to sessionId,
                    "deviceId" to did,
                    "status" to "ready",
                    "mediaUrl" to url,
                    "mediaPath" to path,
                    "durationSec" to durationSec,
                    "sizeBytes" to sizeBytes,
                    "createdAtMs" to System.currentTimeMillis()
                )
            )
            .await()
    }
}
