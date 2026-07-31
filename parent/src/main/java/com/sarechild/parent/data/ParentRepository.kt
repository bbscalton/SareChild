package com.sarechild.parent.data

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.storage.FirebaseStorage
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.AppBlockSchedule
import com.sarechild.shared.AppLimit
import com.sarechild.shared.BatterySample
import com.sarechild.shared.CallSmsPreview
import com.sarechild.shared.DeviceStatus
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.FamilyChatMessage
import com.sarechild.shared.FamilySafetySettings
import com.sarechild.shared.GeofenceZone
import com.sarechild.shared.GuardianInfo
import com.sarechild.shared.GuardianRole
import com.sarechild.shared.LatLngPoint
import com.sarechild.shared.DefaultKeywords
import com.sarechild.shared.KeywordCategory
import com.sarechild.shared.PairingCodeGenerator
import com.sarechild.shared.SafetyCommand
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SafetyCommandType
import com.sarechild.shared.SareChildConstants
import com.sarechild.shared.ScreenShareSchedule
import com.sarechild.shared.SafeContact
import com.sarechild.shared.SosContact
import com.sarechild.shared.UsageAppEntry
import com.sarechild.shared.WeeklyDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Parent-app-only view of a families/{fid}/usageDaily/{docId} document (no shared model needed). */
data class UsageDailySummary(
    val id: String = "",
    val deviceId: String = "",
    val day: String = "",
    val totalMinutes: Int = 0,
    val apps: List<UsageAppEntry> = emptyList()
)

data class LocationTrailSample(
    val id: String = "",
    val deviceId: String = "",
    val location: LatLngPoint? = null,
    val batteryPercent: Int = -1,
    val charging: Boolean = false,
    val hadNetwork: Boolean = true,
    val recordedAtMs: Long = 0L
)

/** parentProfiles/{uid} trial fields — mirrors parent-web's TrialInfo type. */
data class TrialInfo(
    val plan: String = "trial",
    val status: String = "active",
    val trialStartedAt: Long = 0L,
    val trialEndsAt: Long = 0L,
    val lastLoginAt: Long? = null,
    val lastParentCheckInAt: Long? = null
) {
    val isBlocked: Boolean
        get() = status == "purged" || (plan == "trial" && trialEndsAt > 0 && System.currentTimeMillis() > trialEndsAt)
}

private fun newTrialFields(now: Long): Map<String, Any> = mapOf(
    "plan" to "trial",
    "status" to "active",
    "trialStartedAt" to now,
    "trialEndsAt" to now + SareChildConstants.TRIAL_DAYS * 24L * 60 * 60 * 1000,
    "lastLoginAt" to now,
    "lastParentCheckInAt" to now
)

class ParentRepository(
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
    private val db: FirebaseFirestore = FirebaseFirestore.getInstance(),
    private val storage: FirebaseStorage = FirebaseStorage.getInstance()
) {
    val currentUserId: String? get() = auth.currentUser?.uid

    suspend fun signUp(email: String, password: String): Result<String> = runCatching {
        val result = auth.createUserWithEmailAndPassword(email, password).await()
        val uid = result.user?.uid ?: error("No user id")
        val now = System.currentTimeMillis()
        val familyRef = db.collection(SareChildConstants.COL_FAMILIES).document()
        familyRef.set(
            mapOf(
                "parentUid" to uid,
                "createdAtMs" to now,
                "parentEmail" to email
            )
        ).await()
        db.collection("parentProfiles").document(uid).set(
            mapOf(
                "familyId" to familyRef.id,
                "email" to email,
                "createdAtMs" to now
            ) + newTrialFields(now)
        ).await()
        familyRef.collection(SareChildConstants.COL_GUARDIANS).document(uid).set(
            mapOf(
                "email" to email,
                "role" to GuardianRole.OWNER.name,
                "joinedAtMs" to now
            )
        ).await()
        familyRef.id
    }

    suspend fun signIn(email: String, password: String): Result<Unit> = runCatching {
        auth.signInWithEmailAndPassword(email, password).await()
        Unit
    }

    /**
     * Signs in (or signs up, on first use) with a Google ID token obtained from GoogleSignInClient.
     * New Google users get the same family/guardian bootstrap as email signups; returning users
     * simply resume their existing family.
     */
    suspend fun signInWithGoogleIdToken(idToken: String): Result<Unit> = runCatching {
        val credential = GoogleAuthProvider.getCredential(idToken, null)
        val authResult = auth.signInWithCredential(credential).await()
        val uid = authResult.user?.uid ?: error("No user id")
        val email = authResult.user?.email.orEmpty()
        val hasProfile = db.collection("parentProfiles").document(uid).get().await().exists()
        if (!hasProfile) {
            val now = System.currentTimeMillis()
            val familyRef = db.collection(SareChildConstants.COL_FAMILIES).document()
            familyRef.set(
                mapOf(
                    "parentUid" to uid,
                    "createdAtMs" to now,
                    "parentEmail" to email
                )
            ).await()
            db.collection("parentProfiles").document(uid).set(
                mapOf(
                    "familyId" to familyRef.id,
                    "email" to email,
                    "createdAtMs" to now
                ) + newTrialFields(now)
            ).await()
            familyRef.collection(SareChildConstants.COL_GUARDIANS).document(uid).set(
                mapOf(
                    "email" to email,
                    "role" to GuardianRole.OWNER.name,
                    "joinedAtMs" to now
                )
            ).await()
        }
        Unit
    }

    fun signOut() = auth.signOut()

    suspend fun getFamilyId(): String {
        val uid = currentUserId ?: error("Not signed in")
        val profile = db.collection("parentProfiles").document(uid).get().await()
        return profile.getString("familyId") ?: error("Family not found")
    }

    /** Reads the current trial/subscription status once (used to gate the dashboard). */
    suspend fun getTrialInfo(): TrialInfo? {
        val uid = currentUserId ?: return null
        val doc = db.collection(SareChildConstants.COL_PARENT_PROFILES).document(uid).get().await()
        if (!doc.exists() || doc.getString("plan") == null) return null
        return TrialInfo(
            plan = doc.getString("plan") ?: "trial",
            status = doc.getString("status") ?: "active",
            trialStartedAt = doc.getLong("trialStartedAt") ?: 0L,
            trialEndsAt = doc.getLong("trialEndsAt") ?: 0L,
            lastLoginAt = doc.getLong("lastLoginAt"),
            lastParentCheckInAt = doc.getLong("lastParentCheckInAt")
        )
    }

    private val checkInThrottleMs = 60 * 60 * 1000L

    /** Called once per app open / sign-in. Best-effort; a purged account's write is denied by rules. */
    suspend fun recordLogin() {
        val uid = currentUserId ?: return
        runCatching {
            db.collection(SareChildConstants.COL_PARENT_PROFILES).document(uid)
                .set(mapOf("lastLoginAt" to System.currentTimeMillis()), SetOptions.merge())
                .await()
        }
    }

    private var lastCheckInWriteMs = 0L

    /**
     * Called when the parent actively checks on their kids (dashboard load, device tab,
     * alerts tab). Throttled in-process to once/hour to match the product spec without
     * spamming Firestore writes.
     */
    suspend fun recordParentCheckIn() {
        val uid = currentUserId ?: return
        val now = System.currentTimeMillis()
        if (now - lastCheckInWriteMs < checkInThrottleMs) return
        lastCheckInWriteMs = now
        runCatching {
            db.collection(SareChildConstants.COL_PARENT_PROFILES).document(uid)
                .set(mapOf("lastParentCheckInAt" to now), SetOptions.merge())
                .await()
        }
    }

    suspend fun createPairingCode(childName: String): String {
        val familyId = getFamilyId()
        val code = PairingCodeGenerator.generate()
        val expiresAt = System.currentTimeMillis() + 30 * 60 * 1000L
        db.collection(SareChildConstants.COL_PAIRING_CODES).document(code).set(
            mapOf(
                "familyId" to familyId,
                "childName" to childName,
                "createdAtMs" to System.currentTimeMillis(),
                "expiresAtMs" to expiresAt,
                "claimed" to false
            )
        ).await()
        return code
    }

    suspend fun saveFcmToken(token: String) {
        val uid = currentUserId ?: return
        db.collection("parentProfiles").document(uid)
            .set(mapOf("fcmTokens" to FieldValue.arrayUnion(token)), SetOptions.merge())
            .await()
    }

    fun observeDevices(familyId: String): Flow<List<DeviceStatus>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_DEVICES)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val now = System.currentTimeMillis()
                val devices = snap?.documents?.map { doc ->
                    val lastHb = doc.getLong("lastHeartbeatMs") ?: 0L
                    @Suppress("UNCHECKED_CAST")
                    val historyMaps = doc.get("batteryHistory") as? List<Map<String, Any?>> ?: emptyList()
                    DeviceStatus(
                        id = doc.id,
                        childName = doc.getString("childName") ?: "Child",
                        online = now - lastHb < SareChildConstants.WENT_DARK_AFTER_MS,
                        lastHeartbeatMs = lastHb,
                        batteryPercent = (doc.getLong("batteryPercent") ?: -1L).toInt(),
                        charging = doc.getBoolean("charging") ?: false,
                        batteryHistory = historyMaps.mapNotNull { BatterySample.fromMap(it) },
                        lastLocation = LatLngPoint.fromMap(doc.get("lastLocation") as? Map<String, Any?>),
                        notificationAccess = doc.getBoolean("notificationAccess") ?: false,
                        locationPermission = doc.getBoolean("locationPermission") ?: false,
                        monitoringActive = doc.getBoolean("monitoringActive") ?: false,
                        screenShareConsent = doc.getBoolean("screenShareConsent") ?: false,
                        cameraCheckConsent = doc.getBoolean("cameraCheckConsent") ?: false,
                        micCheckConsent = doc.getBoolean("micCheckConsent") ?: false,
                        messageMonitorConsent = doc.getBoolean("messageMonitorConsent") ?: false,
                        installMonitorConsent = doc.getBoolean("installMonitorConsent") ?: false,
                        usageConsent = doc.getBoolean("usageConsent") ?: false,
                        callSmsConsent = doc.getBoolean("callSmsConsent") ?: false,
                        offlineSmsFallbackConsent = doc.getBoolean("offlineSmsFallbackConsent") ?: false,
                        offlineAutoCallConsent = doc.getBoolean("offlineAutoCallConsent") ?: false,
                        whatsappMonitorConsent = doc.getBoolean("whatsappMonitorConsent") ?: false,
                        whatsappMediaPermission = doc.getBoolean("whatsappMediaPermission") ?: false,
                        whatsappProtectionEnabled = (doc.get("whatsappProtection") as? Map<*, *>)
                            ?.get("enabled") as? Boolean ?: false,
                        chatOnline = doc.getBoolean("chatOnline") ?: false,
                        chatLastSeenMs = doc.getLong("chatLastSeenMs") ?: 0L,
                        offlineCallEnabled = doc.getBoolean("offlineCallEnabled") ?: false,
                        offlineCallNumber = doc.getString("offlineCallNumber"),
                        offlineCallMaxAttempts = (doc.getLong("offlineCallMaxAttempts") ?: 0L).toInt(),
                        activeSession = doc.getString("activeSession"),
                        latestFrameUrl = doc.getString("latestFrameUrl"),
                        todayScreenMinutes = (doc.getLong("todayScreenMinutes") ?: 0L).toInt()
                    )
                } ?: emptyList()
                trySend(devices)
            }
        awaitClose { reg.remove() }
    }

    fun observeAlerts(familyId: String): Flow<List<FamilyAlert>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_ALERTS)
            .orderBy("createdAtMs", Query.Direction.DESCENDING)
            .limit(100)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val alerts = snap?.documents?.map { doc ->
                    FamilyAlert(
                        id = doc.id,
                        type = runCatching {
                            AlertType.valueOf(doc.getString("type") ?: "KEYWORD")
                        }.getOrDefault(AlertType.KEYWORD),
                        severity = runCatching {
                            AlertSeverity.valueOf(doc.getString("severity") ?: "MEDIUM")
                        }.getOrDefault(AlertSeverity.MEDIUM),
                        title = doc.getString("title") ?: "Alert",
                        snippet = doc.getString("snippet"),
                        category = doc.getString("category"),
                        deviceId = doc.getString("deviceId") ?: "",
                        createdAtMs = doc.getLong("createdAtMs") ?: 0L,
                        read = doc.getBoolean("read") ?: false,
                        location = LatLngPoint.fromMap(doc.get("location") as? Map<String, Any?>),
                        mediaUrl = doc.getString("mediaUrl"),
                        commandId = doc.getString("commandId"),
                        riskScore = doc.getLong("riskScore")?.toInt()
                    )
                } ?: emptyList()
                trySend(alerts)
            }
        awaitClose { reg.remove() }
    }

    fun observeGeofences(familyId: String): Flow<List<GeofenceZone>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_GEOFENCES)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val zones = snap?.documents?.map { doc ->
                    @Suppress("UNCHECKED_CAST")
                    val days = (doc.get("daysOfWeek") as? List<Number>)?.map { it.toInt() } ?: emptyList()
                    GeofenceZone(
                        id = doc.id,
                        name = doc.getString("name") ?: "Zone",
                        lat = doc.getDouble("lat") ?: 0.0,
                        lng = doc.getDouble("lng") ?: 0.0,
                        radiusM = (doc.getDouble("radiusM") ?: 200.0).toFloat(),
                        active = doc.getBoolean("active") ?: true,
                        daysOfWeek = days,
                        startMinute = doc.getLong("startMinute")?.toInt(),
                        endMinute = doc.getLong("endMinute")?.toInt()
                    )
                } ?: emptyList()
                trySend(zones)
            }
        awaitClose { reg.remove() }
    }

    suspend fun addGeofence(familyId: String, zone: GeofenceZone) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_GEOFENCES)
            .add(zone.toMap())
            .await()
    }

    suspend fun deleteGeofence(familyId: String, geofenceId: String) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_GEOFENCES)
            .document(geofenceId)
            .delete()
            .await()
    }

    suspend fun markAlertRead(familyId: String, alertId: String) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_ALERTS)
            .document(alertId)
            .update("read", true)
            .await()
    }

    suspend fun createSafetyCommand(
        familyId: String,
        deviceId: String,
        type: SafetyCommandType,
        durationMinutes: Int? = null
    ): String {
        val ref = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_COMMANDS)
            .document()
        val command = SafetyCommand(
            id = ref.id,
            type = type,
            status = SafetyCommandStatus.PENDING,
            deviceId = deviceId,
            requestedAtMs = System.currentTimeMillis(),
            durationMinutes = durationMinutes?.coerceIn(
                SareChildConstants.SCREEN_SHARE_MIN_MINUTES,
                SareChildConstants.SCREEN_SHARE_MAX_MINUTES
            )
        )
        ref.set(command.toMap()).await()
        return ref.id
    }

    suspend fun addScreenShareSchedule(
        familyId: String,
        deviceId: String,
        label: String,
        daysOfWeek: List<Int>,
        startMinute: Int,
        durationMinutes: Int
    ) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SCREEN_SHARE_SCHEDULES)
            .add(
                mapOf(
                    "deviceId" to deviceId,
                    "label" to label,
                    "daysOfWeek" to daysOfWeek,
                    "startMinute" to startMinute,
                    "durationMinutes" to durationMinutes.coerceIn(
                        SareChildConstants.SCREEN_SHARE_MIN_MINUTES,
                        SareChildConstants.SCREEN_SHARE_MAX_MINUTES
                    ),
                    "active" to true
                )
            ).await()
    }

    fun observeScreenShareSchedules(familyId: String): Flow<List<ScreenShareSchedule>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SCREEN_SHARE_SCHEDULES)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val list = snap?.documents?.map { doc ->
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
                trySend(list)
            }
        awaitClose { reg.remove() }
    }

    suspend fun deleteScreenShareSchedule(familyId: String, scheduleId: String) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SCREEN_SHARE_SCHEDULES)
            .document(scheduleId)
            .delete()
            .await()
    }

    fun observeCommands(familyId: String): Flow<List<SafetyCommand>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_COMMANDS)
            .orderBy("requestedAtMs", Query.Direction.DESCENDING)
            .limit(30)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val commands = snap?.documents?.mapNotNull { doc ->
                    SafetyCommand.fromDoc(doc.id, doc.data ?: emptyMap())
                } ?: emptyList()
                trySend(commands)
            }
        awaitClose { reg.remove() }
    }

    fun observeUsageDaily(familyId: String): Flow<List<UsageDailySummary>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_USAGE_DAILY)
            .orderBy("day", Query.Direction.DESCENDING)
            .limit(60)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val entries = snap?.documents?.map { doc ->
                    @Suppress("UNCHECKED_CAST")
                    val apps = (doc.get("apps") as? List<Map<String, Any?>>)?.map { m ->
                        UsageAppEntry(
                            packageName = m["packageName"] as? String ?: "",
                            label = m["label"] as? String ?: "",
                            minutes = (m["minutes"] as? Number)?.toInt() ?: 0
                        )
                    } ?: emptyList()
                    UsageDailySummary(
                        id = doc.id,
                        deviceId = doc.getString("deviceId") ?: "",
                        day = doc.getString("day") ?: "",
                        totalMinutes = (doc.getLong("totalMinutes") ?: 0L).toInt(),
                        apps = apps
                    )
                } ?: emptyList()
                trySend(entries)
            }
        awaitClose { reg.remove() }
    }

    fun observeLocationTrail(familyId: String): Flow<List<LocationTrailSample>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_LOCATION_TRAIL)
            .orderBy("recordedAtMs", Query.Direction.DESCENDING)
            .limit(300)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val rows = snap?.documents?.map { doc ->
                    LocationTrailSample(
                        id = doc.id,
                        deviceId = doc.getString("deviceId") ?: "",
                        location = LatLngPoint.fromMap(doc.get("location") as? Map<String, Any?>),
                        batteryPercent = (doc.getLong("batteryPercent") ?: -1L).toInt(),
                        charging = doc.getBoolean("charging") ?: false,
                        hadNetwork = doc.getBoolean("hadNetwork") ?: true,
                        recordedAtMs = doc.getLong("recordedAtMs") ?: 0L
                    )
                } ?: emptyList()
                trySend(rows)
            }
        awaitClose { reg.remove() }
    }

    fun observeAppLimits(familyId: String): Flow<List<AppLimit>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_APP_LIMITS)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val limits = snap?.documents?.map { doc ->
                    AppLimit(
                        id = doc.id,
                        packageName = doc.getString("packageName") ?: "",
                        label = doc.getString("label") ?: "",
                        dailyLimitMinutes = (doc.getLong("dailyLimitMinutes") ?: 60L).toInt(),
                        deviceId = doc.getString("deviceId") ?: ""
                    )
                } ?: emptyList()
                trySend(limits)
            }
        awaitClose { reg.remove() }
    }

    fun observeAppBlockSchedules(familyId: String): Flow<List<AppBlockSchedule>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_APP_BLOCK_SCHEDULES)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val rows = snap?.documents?.map { doc ->
                    @Suppress("UNCHECKED_CAST")
                    val days = (doc.get("daysOfWeek") as? List<Number>)?.map { it.toInt() } ?: emptyList()
                    AppBlockSchedule(
                        id = doc.id,
                        packageName = doc.getString("packageName") ?: "",
                        label = doc.getString("label") ?: "",
                        deviceId = doc.getString("deviceId") ?: "",
                        daysOfWeek = days,
                        startMinute = (doc.getLong("startMinute") ?: 0L).toInt(),
                        endMinute = (doc.getLong("endMinute") ?: 0L).toInt(),
                        active = doc.getBoolean("active") ?: true
                    )
                } ?: emptyList()
                trySend(rows)
            }
        awaitClose { reg.remove() }
    }

    suspend fun addAppLimit(familyId: String, limit: AppLimit) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_APP_LIMITS)
            .add(limit.toMap())
            .await()
    }

    suspend fun addAppBlockSchedule(familyId: String, rule: AppBlockSchedule) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_APP_BLOCK_SCHEDULES)
            .add(rule.toMap())
            .await()
    }

    suspend fun deleteAppLimit(familyId: String, limitId: String) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_APP_LIMITS)
            .document(limitId)
            .delete()
            .await()
    }

    suspend fun deleteAppBlockSchedule(familyId: String, ruleId: String) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_APP_BLOCK_SCHEDULES)
            .document(ruleId)
            .delete()
            .await()
    }

    suspend fun setOfflineCallConfig(
        familyId: String,
        deviceId: String,
        enabled: Boolean,
        number: String,
        maxAttempts: Int
    ) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_DEVICES).document(deviceId)
            .set(
                mapOf(
                    "offlineCallEnabled" to enabled,
                    "offlineCallNumber" to number.trim(),
                    "offlineCallMaxAttempts" to maxAttempts.coerceIn(0, 10)
                ),
                SetOptions.merge()
            )
            .await()
    }

    fun observeSosContacts(familyId: String): Flow<List<SosContact>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SOS_CONTACTS)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val contacts = snap?.documents?.map { doc ->
                    SosContact(
                        id = doc.id,
                        name = doc.getString("name") ?: "Contact",
                        phoneNote = doc.getString("phoneNote") ?: ""
                    )
                } ?: emptyList()
                trySend(contacts)
            }
        awaitClose { reg.remove() }
    }

    fun observeSafeContacts(familyId: String): Flow<List<SafeContact>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SAFE_CONTACTS)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val rows = snap?.documents?.map { doc ->
                    SafeContact(
                        id = doc.id,
                        channel = doc.getString("channel") ?: "WHATSAPP",
                        label = doc.getString("label") ?: "",
                        identifier = doc.getString("identifier") ?: ""
                    )
                } ?: emptyList()
                trySend(rows)
            }
        awaitClose { reg.remove() }
    }

    suspend fun addSosContact(familyId: String, contact: SosContact) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SOS_CONTACTS)
            .add(contact.toMap())
            .await()
    }

    suspend fun deleteSosContact(familyId: String, contactId: String) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SOS_CONTACTS)
            .document(contactId)
            .delete()
            .await()
    }

    suspend fun addSafeContact(familyId: String, contact: SafeContact) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SAFE_CONTACTS)
            .add(contact.toMap())
            .await()
    }

    suspend fun deleteSafeContact(familyId: String, safeContactId: String) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SAFE_CONTACTS)
            .document(safeContactId)
            .delete()
            .await()
    }

    fun observeCallSms(familyId: String): Flow<List<CallSmsPreview>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_CALL_SMS)
            .orderBy("atMs", Query.Direction.DESCENDING)
            .limit(60)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val items = snap?.documents?.map { doc ->
                    CallSmsPreview(
                        id = doc.id,
                        kind = doc.getString("kind") ?: "",
                        direction = doc.getString("direction") ?: "",
                        addressMasked = doc.getString("addressMasked") ?: "",
                        snippet = doc.getString("snippet"),
                        atMs = doc.getLong("atMs") ?: 0L,
                        deviceId = doc.getString("deviceId") ?: ""
                    )
                } ?: emptyList()
                trySend(items)
            }
        awaitClose { reg.remove() }
    }

    fun observeDigests(familyId: String): Flow<List<WeeklyDigest>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_DIGESTS)
            .orderBy("weekStartMs", Query.Direction.DESCENDING)
            .limit(30)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val digests = snap?.documents?.map { doc ->
                    @Suppress("UNCHECKED_CAST")
                    val topTypes = (doc.get("topAlertTypes") as? List<String>) ?: emptyList()
                    WeeklyDigest(
                        id = doc.id,
                        weekStartMs = doc.getLong("weekStartMs") ?: 0L,
                        weekEndMs = doc.getLong("weekEndMs") ?: 0L,
                        summary = doc.getString("summary") ?: "",
                        alertCount = (doc.getLong("alertCount") ?: 0L).toInt(),
                        topAlertTypes = topTypes,
                        createdAtMs = doc.getLong("createdAtMs") ?: 0L
                    )
                } ?: emptyList()
                trySend(digests)
            }
        awaitClose { reg.remove() }
    }

    fun observeGuardians(familyId: String): Flow<List<GuardianInfo>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_GUARDIANS)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
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
                trySend(guardians)
            }
        awaitClose { reg.remove() }
    }

    fun observeFamilyChat(familyId: String): Flow<List<FamilyChatMessage>> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_FAMILY_CHAT)
            .orderBy("createdAtMs", Query.Direction.ASCENDING)
            .limit(300)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val rows = snap?.documents?.map { doc ->
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
                trySend(rows)
            }
        awaitClose { reg.remove() }
    }

    fun observeSafetySettings(familyId: String): Flow<FamilySafetySettings> = callbackFlow {
        val reg = db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SAFETY_SETTINGS)
            .document("default")
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val d = snap
                @Suppress("UNCHECKED_CAST")
                val snoozed = (d?.get("snoozedCategories") as? List<String>) ?: emptyList()
                val settings = FamilySafetySettings(
                    escalationEnabled = d?.getBoolean("escalationEnabled") ?: true,
                    escalationRiskThreshold = (d?.getLong("escalationRiskThreshold") ?: 60L).toInt(),
                    autoLockOnCritical = d?.getBoolean("autoLockOnCritical") ?: false,
                    checkInIntervalMinutes = (d?.getLong("checkInIntervalMinutes") ?: 120L).toInt(),
                    snoozedCategories = snoozed,
                    snoozeUntilMs = d?.getLong("snoozeUntilMs") ?: 0L,
                    alertRetentionDays = (d?.getLong("alertRetentionDays")
                        ?: SareChildConstants.ALERT_RETENTION_DAYS.toLong()).toInt(),
                    mediaRetentionDays = (d?.getLong("mediaRetentionDays")
                        ?: SareChildConstants.MEDIA_RETENTION_DAYS.toLong()).toInt()
                )
                trySend(settings)
            }
        awaitClose { reg.remove() }
    }

    suspend fun setSafetySettings(familyId: String, settings: FamilySafetySettings) {
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_SAFETY_SETTINGS)
            .document("default")
            .set(settings.toMap(), SetOptions.merge())
            .await()
    }

    suspend fun sendFamilyChatMessage(
        familyId: String,
        text: String? = null,
        mediaUrl: String? = null,
        mediaType: String? = null
    ) {
        val uid = currentUserId ?: error("Not signed in")
        val profile = db.collection("parentProfiles").document(uid).get().await()
        val name = auth.currentUser?.email ?: profile.getString("email") ?: "Guardian"
        val msg = FamilyChatMessage(
            senderUid = uid,
            senderName = name,
            senderRole = "GUARDIAN",
            text = text?.trim()?.ifBlank { null },
            mediaUrl = mediaUrl,
            mediaType = mediaType
        )
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_FAMILY_CHAT)
            .add(msg.toMap())
            .await()
    }

    suspend fun uploadChatMedia(localFile: java.io.File, contentType: String): String {
        val familyId = getFamilyId()
        val uid = currentUserId ?: error("Not signed in")
        val path = "families/$familyId/guardians/$uid/chat/${System.currentTimeMillis()}_${localFile.name}"
        uploadMediaToR2(path, localFile, contentType)?.let { return it }
        val ref = storage.reference.child(path)
        ref.putFile(android.net.Uri.fromFile(localFile)).await()
        return ref.downloadUrl.await().toString()
    }

    private suspend fun uploadMediaToR2(
        path: String,
        localFile: java.io.File,
        contentType: String
    ): String? = withContext(Dispatchers.IO) {
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
            """"url"\s*:\s*"([^"]+)"""".toRegex().find(body)?.groupValues?.get(1)
                ?: error("R2 response missing URL")
        }.getOrNull()
    }

    suspend fun setGuardianChatPresence(online: Boolean) {
        val familyId = getFamilyId()
        val uid = currentUserId ?: return
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_GUARDIANS).document(uid)
            .set(
                mapOf(
                    "chatOnline" to online,
                    "lastSeenMs" to System.currentTimeMillis()
                ),
                SetOptions.merge()
            )
            .await()
    }

    /** Creates a families/{familyId} guardian invite doc; returns the invite code to share with the caregiver. */
    suspend fun createGuardianInvite(email: String): String {
        val familyId = getFamilyId()
        val code = PairingCodeGenerator.generate()
        val expiresAt = System.currentTimeMillis() + 7 * 24 * 60 * 60 * 1000L
        db.collection(SareChildConstants.COL_GUARDIAN_INVITES).document(code).set(
            mapOf(
                "familyId" to familyId,
                "email" to email,
                "role" to GuardianRole.CAREGIVER.name,
                "createdAtMs" to System.currentTimeMillis(),
                "expiresAtMs" to expiresAt,
                "claimed" to false
            )
        ).await()
        return code
    }

    /** Called by a signed-in caregiver account to join the family that issued [code]. */
    suspend fun acceptGuardianInvite(code: String): Result<String> = runCatching {
        val uid = currentUserId ?: error("Not signed in")
        val email = auth.currentUser?.email ?: ""
        val normalized = code.trim().uppercase()
        val inviteRef = db.collection(SareChildConstants.COL_GUARDIAN_INVITES).document(normalized)
        val invite = inviteRef.get().await()
        if (!invite.exists()) error("Invalid invite code")
        if (invite.getBoolean("claimed") == true) error("Invite already used")
        val expires = invite.getLong("expiresAtMs") ?: 0L
        if (System.currentTimeMillis() > expires) error("Invite expired")
        val familyId = invite.getString("familyId") ?: error("Missing family")
        val role = runCatching {
            GuardianRole.valueOf(invite.getString("role") ?: "CAREGIVER")
        }.getOrDefault(GuardianRole.CAREGIVER)

        db.collection("parentProfiles").document(uid).set(
            mapOf("familyId" to familyId, "email" to email),
            SetOptions.merge()
        ).await()
        db.collection(SareChildConstants.COL_FAMILIES).document(familyId)
            .collection(SareChildConstants.COL_GUARDIANS).document(uid).set(
                mapOf(
                    "email" to email,
                    "role" to role.name,
                    "joinedAtMs" to System.currentTimeMillis()
                )
            ).await()
        inviteRef.update(mapOf("claimed" to true, "claimedByUid" to uid, "claimedAtMs" to System.currentTimeMillis())).await()
        familyId
    }

    /** Seeds keywordLists/default once if missing (uses open test-mode rules until you deploy strict rules). */
    suspend fun ensureKeywordListSeeded() {
        val ref = db.collection(SareChildConstants.COL_KEYWORD_LISTS)
            .document(SareChildConstants.KEYWORD_LIST_DEFAULT)
        if (ref.get().await().exists()) return
        val categories = DefaultKeywords.lists.mapKeys { (cat, _) ->
            when (cat) {
                KeywordCategory.SELF_HARM -> "self_harm"
                else -> cat.name.lowercase()
            }
        }
        ref.set(mapOf("categories" to categories)).await()
    }
}
