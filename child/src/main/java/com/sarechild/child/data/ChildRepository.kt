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
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.AppBlockSchedule
import com.sarechild.shared.AppLimit
import com.sarechild.shared.BatterySample
import com.sarechild.shared.CallSmsPreview
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.FamilyChatMessage
import com.sarechild.shared.FamilySafetySettings
import com.sarechild.shared.GeofenceZone
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

    var activeSession: String?
        get() = prefs.getString(SareChildConstants.PREF_ACTIVE_SESSION, null)
        set(value) = prefs.edit().putString(SareChildConstants.PREF_ACTIVE_SESSION, value).apply()

    var deviceLocked: Boolean
        get() = prefs.getBoolean(SareChildConstants.PREF_DEVICE_LOCKED, false)
        set(value) = prefs.edit().putBoolean(SareChildConstants.PREF_DEVICE_LOCKED, value).apply()

    val isPaired: Boolean get() = !familyId.isNullOrBlank() && !deviceId.isNullOrBlank()

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
        todayScreenMinutes: Int = 0
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
            "batteryHistory" to FieldValue.arrayUnion(sample.toMap())
        )
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

    suspend fun loadKeywordMatcher(): KeywordMatcher {
        val snap = db.collection(SareChildConstants.COL_KEYWORD_LISTS)
            .document(SareChildConstants.KEYWORD_LIST_DEFAULT)
            .get()
            .await()
        @Suppress("UNCHECKED_CAST")
        val categories = snap.get("categories") as? Map<String, Any?>
        return KeywordMatcher.fromFirestoreMap(categories)
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
        val fid = familyId ?: return emptyList()
        val did = deviceId ?: return emptyList()
        val snap = db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_APP_BLOCK_SCHEDULES)
            .whereEqualTo("deviceId", did)
            .whereEqualTo("active", true)
            .get()
            .await()
        return snap.documents.map {
            @Suppress("UNCHECKED_CAST")
            val days = (it.get("daysOfWeek") as? List<Number>)?.map { n -> n.toInt() } ?: emptyList()
            AppBlockSchedule(
                id = it.id,
                packageName = it.getString("packageName") ?: "",
                label = it.getString("label") ?: "",
                deviceId = did,
                daysOfWeek = days,
                startMinute = (it.getLong("startMinute") ?: 0L).toInt(),
                endMinute = (it.getLong("endMinute") ?: 0L).toInt(),
                active = it.getBoolean("active") ?: true
            )
        }.filter { it.packageName.isNotBlank() }
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
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_WHATSAPP_EVENTS)
            .add(event.copy(deviceId = did).toMap())
            .await()
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
        // the child actively tapped Allow — see AllowCountdownController.
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

    fun listenFamilyChat(onMessages: (List<FamilyChatMessage>) -> Unit): ListenerRegistration? {
        val fid = familyId ?: return null
        return db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_FAMILY_CHAT)
            .orderBy("createdAtMs", Query.Direction.ASCENDING)
            .limit(300)
            .addSnapshotListener { snap, _ ->
                val msgs = snap?.documents?.map { doc ->
                    FamilyChatMessage(
                        id = doc.id,
                        senderUid = doc.getString("senderUid") ?: "",
                        senderName = doc.getString("senderName") ?: "Family",
                        senderRole = doc.getString("senderRole") ?: "GUARDIAN",
                        deviceId = doc.getString("deviceId"),
                        text = doc.getString("text"),
                        mediaUrl = doc.getString("mediaUrl"),
                        mediaType = doc.getString("mediaType"),
                        createdAtMs = doc.getLong("createdAtMs") ?: 0L
                    )
                } ?: emptyList()
                onMessages(msgs)
            }
    }

    suspend fun sendFamilyChatMessage(
        text: String? = null,
        mediaUrl: String? = null,
        mediaType: String? = null
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
            mediaType = mediaType
        )
        db.collection(SareChildConstants.COL_FAMILIES).document(fid)
            .collection(SareChildConstants.COL_FAMILY_CHAT)
            .add(msg.toMap())
            .await()
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
}
