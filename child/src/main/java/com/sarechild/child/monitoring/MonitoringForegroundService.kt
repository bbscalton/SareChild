package com.sarechild.child.monitoring

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.sarechild.child.MainActivity
import com.sarechild.child.R
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.LatLngPoint
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

class MonitoringForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var foregroundTypeFallback = false
    private lateinit var repo: ChildRepository
    private lateinit var fused: com.google.android.gms.location.FusedLocationProviderClient
    private lateinit var geofencingClient: GeofencingClient
    private var heartbeatJob: Job? = null
    private var liveTrackingJob: Job? = null
    private var usageBlockJob: Job? = null
    private var lastLocation: LatLngPoint? = null
    private var liveTrackingActive = false
    private var liveTrackingExpiresAtMs = 0L
    private var lastLivePublishMs = 0L
    private var lastLowBatteryAlertMs = 0L
    private var lastNotifAccess: Boolean? = null
    private var lastLocationPerm: Boolean? = null
    private var commandListener: CommandListener? = null
    private var unpairHandler: DeviceUnpairHandler? = null
    private var scheduleWatcher: ScreenShareScheduleWatcher? = null
    private var whatsAppMediaObserver: WhatsAppMediaObserver? = null
    private var photoGallerySync: PhotoGallerySync? = null
    private var callRecordingMonitor: CallRecordingMonitor? = null
    private var eventRecorderMonitor: EventRecorderMonitor? = null
    private var lastWallClockMs: Long = 0L
    private var lastElapsedRealtimeMs: Long = 0L
    private var lastCheckInPromptMs: Long = 0L
    private var lastTodayScreenMinutes = 0

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val loc = result.lastLocation ?: return
            lastLocation = loc.toLatLngPoint()
            if (liveTrackingActive) {
                scope.launch { maybePublishLiveLocation(force = false) }
            }
        }
    }

    private fun Location.toLatLngPoint(): LatLngPoint = LatLngPoint(
        lat = latitude,
        lng = longitude,
        accuracyM = accuracy,
        updatedAtMs = System.currentTimeMillis(),
        bearingDeg = if (hasBearing()) bearing else null,
        speedMps = if (hasSpeed()) speed else null
    )

    private suspend fun fetchFreshLocation(): LatLngPoint? {
        if (!hasLocationPermission()) return lastLocation
        return try {
            val loc = fused.getCurrentLocation(
                Priority.PRIORITY_HIGH_ACCURACY,
                CancellationTokenSource().token
            ).await()
            if (loc != null) {
                val point = loc.toLatLngPoint()
                lastLocation = point
                point
            } else {
                lastLocation
            }
        } catch (_: Exception) {
            lastLocation
        }
    }

    override fun onCreate() {
        super.onCreate()
        repo = ChildRepository(this)
        fused = LocationServices.getFusedLocationProviderClient(this)
        geofencingClient = LocationServices.getGeofencingClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Process STOP actions before ensureServiceRunning — prefs are still true there and
        // would re-arm capture + race Firestore status back to active=true.
        when (intent?.action) {
            SareChildConstants.ACTION_STOP_LIVE_TRACKING -> disableLiveTracking()
            SareChildConstants.ACTION_STOP_SCREEN_SNAPSHOTS -> ScreenSnapshotCapture.stop(this)
            SareChildConstants.ACTION_STOP_CAMERA_SNAPSHOTS -> CameraSnapshotCapture.stop(this)
        }
        ensureServiceRunning()
        when (intent?.action) {
            SareChildConstants.ACTION_START_LIVE_TRACKING -> {
                val durationMin = intent.getIntExtra(
                    SareChildConstants.EXTRA_DURATION_MINUTES,
                    (SareChildConstants.LIVE_TRACKING_MAX_DURATION_MS / 60_000L).toInt()
                ).coerceIn(1, 60)
                enableLiveTracking(durationMin * 60_000L)
            }
            SareChildConstants.ACTION_START_SCREEN_SNAPSHOTS -> {
                ScreenSnapshotCapture.start(this)
            }
            SareChildConstants.ACTION_START_CAMERA_SNAPSHOTS -> {
                val mode = intent.getStringExtra(SareChildConstants.EXTRA_CAMERA_SNAPSHOTS_MODE)
                CameraSnapshotCapture.start(this, mode)
            }
        }
        return START_STICKY
    }

    private fun ensureServiceRunning() {
        startAsForeground()
        startLocationUpdates()
        startHeartbeatLoop()
        startUsageBlockLoop()
        if (repo.screenSnapshotsActive) {
            ScreenSnapshotCapture.start(this)
        }
        if (repo.cameraSnapshotsActive) {
            CameraSnapshotCapture.start(this, repo.cameraSnapshotsMode)
        }
        if (commandListener == null) {
            repo.startAppBlockScheduleListener()
            commandListener = CommandListener(this, repo).also { it.start() }
            unpairHandler = DeviceUnpairHandler(this, repo).also { it.start() }
            scheduleWatcher = ScreenShareScheduleWatcher(this, repo).also { it.start() }
            ensureCallRecordingMonitor()
            scope.launch { refreshGeofences() }
        }
    }

    private fun startAsForeground() {
        val pending = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification: Notification = NotificationCompat.Builder(
            this,
            SareChildConstants.NOTIFICATION_CHANNEL_MONITORING
        )
            .setContentTitle(getString(R.string.monitoring_notification_title))
            .setContentText(getString(R.string.monitoring_notification_text))
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val type = resolveForegroundServiceType()
                ServiceCompat.startForeground(
                    this,
                    SareChildConstants.FGS_NOTIFICATION_ID,
                    notification,
                    type
                )
                if (type and ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA != 0) {
                    foregroundTypeFallback = false
                }
            } else {
                startForeground(SareChildConstants.FGS_NOTIFICATION_ID, notification)
            }
        } catch (e: SecurityException) {
            // API 34+: missing manifest FGS type or runtime permission — retry location-only
            // so CommandListener stays alive (camera snapshots need manifest camera type).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    ServiceCompat.startForeground(
                        this,
                        SareChildConstants.FGS_NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                    )
                    foregroundTypeFallback = true
                    Log.w(TAG, "FGS started location-only after SecurityException", e)
                } catch (e2: SecurityException) {
                    Log.e(TAG, "FGS start failed — stopping service", e2)
                    stopSelf()
                }
            } else {
                stopSelf()
            }
        }
    }

    private fun resolveForegroundServiceType(): Int {
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        if (repo.cameraSnapshotsActive && hasCameraPermission() && !foregroundTypeFallback) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        return type
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED

    fun refreshForegroundType() {
        if (!::repo.isInitialized) return
        foregroundTypeFallback = false
        startAsForeground()
    }

    private fun startLocationUpdates() {
        if (!hasLocationPermission()) return
        val fast = liveTrackingActive
        val interval = if (fast) {
            SareChildConstants.LIVE_TRACKING_GPS_INTERVAL_MS
        } else {
            SareChildConstants.LOCATION_INTERVAL_MS
        }
        val minInterval = if (fast) {
            SareChildConstants.LIVE_TRACKING_GPS_INTERVAL_MS
        } else {
            60_000L
        }
        val request = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            interval
        )
            .setMinUpdateIntervalMillis(minInterval)
            .setMaxUpdateDelayMillis(if (fast) interval else interval * 2)
            .build()
        try {
            fused.removeLocationUpdates(locationCallback)
            fused.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
            if (fast) {
                scope.launch {
                    runCatching {
                        val loc = fused.getCurrentLocation(
                            Priority.PRIORITY_HIGH_ACCURACY,
                            CancellationTokenSource().token
                        ).await()
                        if (loc != null) lastLocation = loc.toLatLngPoint()
                    }
                }
            }
        } catch (_: SecurityException) {
            // permission race
        }
    }

    private fun enableLiveTracking(durationMs: Long = SareChildConstants.LIVE_TRACKING_MAX_DURATION_MS) {
        liveTrackingActive = true
        liveTrackingExpiresAtMs = System.currentTimeMillis() + durationMs.coerceAtMost(
            SareChildConstants.LIVE_TRACKING_MAX_DURATION_MS
        )
        lastLivePublishMs = 0L
        startLocationUpdates()
        startLiveTrackingLoop()
        scope.launch { maybePublishLiveLocation(force = true) }
    }

    private fun disableLiveTracking() {
        if (!liveTrackingActive) return
        liveTrackingActive = false
        liveTrackingExpiresAtMs = 0L
        liveTrackingJob?.cancel()
        liveTrackingJob = null
        startLocationUpdates()
        scope.launch {
            runCatching {
                repo.updateHeartbeat(
                    batteryPercent = readBatteryPercent(),
                    charging = isCharging(),
                    location = lastLocation,
                    notificationAccess = isNotificationAccessEnabled(),
                    locationPermission = hasLocationPermission(),
                    monitoringActive = true,
                    todayScreenMinutes = lastTodayScreenMinutes,
                    liveTrackingActive = false,
                    screenSnapshotsActive = repo.screenSnapshotsActive,
                    cameraSnapshotsActive = repo.cameraSnapshotsActive
                )
            }
        }
    }

    private fun startLiveTrackingLoop() {
        liveTrackingJob?.cancel()
        liveTrackingJob = scope.launch {
            while (isActive && liveTrackingActive) {
                if (System.currentTimeMillis() > liveTrackingExpiresAtMs) {
                    disableLiveTracking()
                    break
                }
                runCatching { maybePublishLiveLocation(force = true) }
                delay(SareChildConstants.LIVE_TRACKING_INTERVAL_MS)
            }
        }
    }

    /** Pushes a fresh GPS fix to Firestore when a parent is watching Live Map (~every 5s). */
    private suspend fun maybePublishLiveLocation(force: Boolean) {
        if (!liveTrackingActive || !repo.isPaired) return
        val now = System.currentTimeMillis()
        if (!force && now - lastLivePublishMs < SareChildConstants.LIVE_TRACKING_INTERVAL_MS) return
        val point = fetchFreshLocation() ?: return
        lastLivePublishMs = now
        val battery = readBatteryPercent()
        val charging = isCharging()
        val networkAvailable = isNetworkAvailable()
        runCatching {
            repo.addLocationTrailSample(
                location = point,
                batteryPercent = battery,
                charging = charging,
                hadNetwork = networkAvailable
            )
        }
        runCatching {
            repo.updateHeartbeat(
                batteryPercent = battery,
                charging = charging,
                location = point,
                notificationAccess = isNotificationAccessEnabled(),
                locationPermission = hasLocationPermission(),
                monitoringActive = true,
                todayScreenMinutes = lastTodayScreenMinutes,
                whatsappMediaPermission = WhatsAppMonitor.hasMediaPermission(this),
                whatsappProtection = WhatsAppMonitor.protectionStatusMap(
                    consent = repo.whatsappMonitorConsent,
                    notificationAccess = isNotificationAccessEnabled(),
                    accessibilityAccess = isAccessibilityServiceEnabled(),
                    mediaPermission = WhatsAppMonitor.hasMediaPermission(this),
                    lastEventAtMs = repo.lastWhatsAppEventAtMs()
                ),
                callRecordingStatus = VoipCallRecordingHelper.protectionStatusMap(
                    consent = repo.callRecordingConsent,
                    enabled = repo.callRecordingEnabled,
                    micPermission = hasRecordAudioPermission(),
                    phoneStatePermission = hasPhoneStatePermission(),
                    lastRecordingAtMs = repo.lastCallRecordingAtMs()
                ),
                photoGalleryStatus = PhotoGallerySync.statusMap(this, repo),
                eventRecorderStatus = eventRecorderMonitor?.statusMap(
                    usageAccess = UsageMonitorHelper.hasUsageAccess(this),
                    accessibilityAccess = isAccessibilityServiceEnabled(),
                    notificationAccess = isNotificationAccessEnabled()
                ).orEmpty(),
                lockScreenStatus = repo.lockScreenStatusMap(this),
                liveTrackingActive = true,
                screenSnapshotsActive = repo.screenSnapshotsActive
            )
        }
    }

    private fun startHeartbeatLoop() {
        if (heartbeatJob?.isActive == true) return
        heartbeatJob = scope.launch {
            while (isActive) {
                runCatching { tick() }
                delay(SareChildConstants.HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private fun startUsageBlockLoop() {
        if (usageBlockJob?.isActive == true) return
        usageBlockJob = scope.launch {
            while (isActive) {
                runCatching {
                    if (repo.usageConsent) {
                        UsageMonitorHelper.enforceScheduledBlocks(this@MonitoringForegroundService, repo)
                    }
                }
                delay(SareChildConstants.USAGE_BLOCK_ENFORCE_INTERVAL_MS)
            }
        }
    }

    private suspend fun tick() {
        val battery = readBatteryPercent()
        val charging = isCharging()
        val notif = isNotificationAccessEnabled()
        val locPerm = hasLocationPermission()
        val accessibility = isAccessibilityServiceEnabled()
        val waMediaPerm = WhatsAppMonitor.hasMediaPermission(this)
        val lastEventAtMs = repo.lastWhatsAppEventAtMs()
        val waProtection = WhatsAppMonitor.protectionStatusMap(
            consent = repo.whatsappMonitorConsent,
            notificationAccess = notif,
            accessibilityAccess = accessibility,
            mediaPermission = waMediaPerm,
            lastEventAtMs = lastEventAtMs
        )
        val callRecProtection = VoipCallRecordingHelper.protectionStatusMap(
            consent = repo.callRecordingConsent,
            enabled = repo.callRecordingEnabled,
            micPermission = hasRecordAudioPermission(),
            phoneStatePermission = hasPhoneStatePermission(),
            lastRecordingAtMs = repo.lastCallRecordingAtMs()
        )
        val photoStatus = PhotoGallerySync.statusMap(this, repo)
        val eventRecStatus = eventRecorderMonitor?.statusMap(
            usageAccess = UsageMonitorHelper.hasUsageAccess(this),
            accessibilityAccess = isAccessibilityServiceEnabled(),
            notificationAccess = notif
        ).orEmpty()
        val lockScreenStatus = repo.lockScreenStatusMap(this)
        ensureWhatsAppMediaObserver(notif, waMediaPerm)
        ensurePhotoGallerySync()
        ensureCallRecordingMonitor()
        ensureEventRecorderMonitor()
        if (PhotoGallerySync.shouldRunPeriodicSync(repo)) {
            scope.launch { runCatching { photoGallerySync?.sync(forceFull = false) } }
        }
        if (eventRecorderMonitor?.shouldRunPeriodicSync() == true) {
            scope.launch { runCatching { eventRecorderMonitor?.sync(force = false) } }
        }

        if (lastNotifAccess == true && !notif) {
            repo.postPermissionRevoked("Notification access disabled")
        }
        if (lastLocationPerm == true && !locPerm) {
            repo.postPermissionRevoked("Location permission revoked")
        }
        lastNotifAccess = notif
        lastLocationPerm = locPerm

        if (battery in 0 until SareChildConstants.LOW_BATTERY_PERCENT) {
            val now = System.currentTimeMillis()
            if (now - lastLowBatteryAlertMs > 30 * 60_000L) {
                repo.postLowBattery(battery, lastLocation)
                lastLowBatteryAlertMs = now
            }
        }

        var screenMinutes = 0
        if (repo.usageConsent) {
            screenMinutes = UsageMonitorHelper.syncAndEnforce(this, repo)
        }
        lastTodayScreenMinutes = screenMinutes
        if (repo.isPaired) {
            runCatching { AppInventoryHelper.sync(this, repo) }
        }
        detectClockTampering()
        maybePromptScheduledCheckIn()
        val networkAvailable = isNetworkAvailable()
        lastLocation?.let {
            runCatching {
                repo.addLocationTrailSample(
                    location = it,
                    batteryPercent = battery,
                    charging = charging,
                    hadNetwork = networkAvailable
                )
            }
        }
        runCatching { OfflineEvidenceHelper.maybeRecordAudioEvidence(this, repo, networkAvailable) }
        runCatching { OfflineEvidenceHelper.flushWhenOnline(this, repo, networkAvailable) }
        runCatching { OfflineEvidenceHelper.maybePlaceOfflineAutoCall(this, repo, networkAvailable) }
        lastLocation?.let {
            runCatching {
                OfflineEvidenceHelper.maybeSendOfflineSmsFallback(
                    context = this,
                    repo = repo,
                    networkAvailable = networkAvailable,
                    lat = it.lat,
                    lng = it.lng
                )
            }
        }

        repo.updateHeartbeat(
            batteryPercent = battery,
            charging = charging,
            location = lastLocation,
            notificationAccess = notif,
            locationPermission = locPerm,
            monitoringActive = true,
            todayScreenMinutes = screenMinutes,
            whatsappMediaPermission = waMediaPerm,
            whatsappProtection = waProtection,
            callRecordingStatus = callRecProtection,
            photoGalleryStatus = photoStatus,
            eventRecorderStatus = eventRecStatus,
            lockScreenStatus = lockScreenStatus,
            liveTrackingActive = liveTrackingActive,
            screenSnapshotsActive = repo.screenSnapshotsActive,
            cameraSnapshotsActive = repo.cameraSnapshotsActive
        )
        scheduleWatcher?.tick()
    }

    private suspend fun maybePromptScheduledCheckIn() {
        val settings = repo.loadSafetySettings()
        val intervalMs = settings.checkInIntervalMinutes.coerceIn(30, 24 * 60) * 60_000L
        val now = System.currentTimeMillis()
        if (now - lastCheckInPromptMs < intervalMs) return
        lastCheckInPromptMs = now
        repo.postAlert(
            com.sarechild.shared.FamilyAlert(
                type = com.sarechild.shared.AlertType.CHECK_IN,
                severity = com.sarechild.shared.AlertSeverity.MEDIUM,
                title = "Scheduled check-in needed — ${repo.childName}",
                snippet = "No recent check-in. Ask child to tap 'I'm safe' in app."
            )
        )
    }

    private suspend fun detectClockTampering() {
        val nowWall = System.currentTimeMillis()
        val nowElapsed = SystemClock.elapsedRealtime()
        if (lastWallClockMs == 0L || lastElapsedRealtimeMs == 0L) {
            lastWallClockMs = nowWall
            lastElapsedRealtimeMs = nowElapsed
            return
        }
        val wallDelta = nowWall - lastWallClockMs
        val elapsedDelta = nowElapsed - lastElapsedRealtimeMs
        val drift = kotlin.math.abs(wallDelta - elapsedDelta)
        if (drift > 10 * 60_000L) {
            repo.postTamper(
                title = "Clock tamper suspected — ${repo.childName}",
                snippet = "Device clock changed significantly while monitoring."
            )
        }
        lastWallClockMs = nowWall
        lastElapsedRealtimeMs = nowElapsed
    }

    private suspend fun refreshGeofences() {
        if (!hasLocationPermission()) return
        val zones = repo.loadGeofences()
        runCatching { geofencingClient.removeGeofences(geofencePendingIntent()).await() }
        if (zones.isEmpty()) return
        val geofences = zones.map { zone ->
            Geofence.Builder()
                .setRequestId(zone.id)
                .setCircularRegion(zone.lat, zone.lng, zone.radiusM)
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
                .build()
        }
        val request = GeofencingRequest.Builder()
            .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
            .addGeofences(geofences)
            .build()
        try {
            geofencingClient.addGeofences(request, geofencePendingIntent()).await()
        } catch (_: SecurityException) {
        }
    }

    private fun geofencePendingIntent(): PendingIntent {
        val intent = Intent(this, GeofenceBroadcastReceiver::class.java)
        return PendingIntent.getBroadcast(
            this,
            2002,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
    }

    private fun readBatteryPercent(): Int {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val battery = registerReceiver(null, filter) ?: return -1
        val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return -1
        return (level * 100) / scale
    }

    private fun isCharging(): Boolean {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val battery = registerReceiver(null, filter) ?: return false
        val status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
    }

    private fun hasLocationPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    private fun ensureWhatsAppMediaObserver(notificationAccess: Boolean, mediaPermission: Boolean) {
        val shouldRun = repo.whatsappMonitorConsent && notificationAccess && mediaPermission
        if (shouldRun && whatsAppMediaObserver == null) {
            whatsAppMediaObserver = WhatsAppMediaObserver(this, repo).also { it.start() }
        } else if (!shouldRun && whatsAppMediaObserver != null) {
            whatsAppMediaObserver?.stop()
            whatsAppMediaObserver = null
        }
    }

    private fun ensurePhotoGallerySync() {
        val shouldRun = repo.photoGalleryConsent && PhotoGallerySync.hasPhotoPermission(this)
        if (shouldRun && photoGallerySync == null) {
            photoGallerySync = PhotoGallerySync(this, repo).also { it.start() }
        } else if (!shouldRun && photoGallerySync != null) {
            photoGallerySync?.stop()
            photoGallerySync = null
        }
    }

    private fun ensureCallRecordingMonitor() {
        val shouldRun = repo.callRecordingConsent && repo.callRecordingEnabled
        if (shouldRun && callRecordingMonitor == null) {
            callRecordingMonitor = CallRecordingMonitor(this, repo, scope).also { it.start() }
        } else if (!shouldRun && callRecordingMonitor != null) {
            callRecordingMonitor?.stop()
            callRecordingMonitor = null
        } else if (shouldRun) {
            callRecordingMonitor?.refresh()
        }
    }

    private fun ensureEventRecorderMonitor() {
        val shouldRun = repo.eventRecorderConsent && UsageMonitorHelper.hasUsageAccess(this)
        if (shouldRun && eventRecorderMonitor == null) {
            eventRecorderMonitor = EventRecorderMonitor(this, repo).also { it.start() }
            scope.launch { runCatching { eventRecorderMonitor?.sync(force = false) } }
        } else if (!shouldRun && eventRecorderMonitor != null) {
            eventRecorderMonitor?.stop()
            eventRecorderMonitor = null
        }
    }

    private fun hasRecordAudioPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasPhoneStatePermission(): Boolean =
        ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED

    private fun isNotificationAccessEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        return flat?.contains(packageName) == true
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val flat = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return flat.contains(packageName)
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        val network = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    override fun onDestroy() {
        commandListener?.stop()
        unpairHandler?.stop()
        scheduleWatcher?.stop()
        repo.stopAppBlockScheduleListener()
        whatsAppMediaObserver?.stop()
        photoGallerySync?.stop()
        photoGallerySync = null
        callRecordingMonitor?.stop()
        callRecordingMonitor = null
        eventRecorderMonitor?.stop()
        eventRecorderMonitor = null
        fused.removeLocationUpdates(locationCallback)
        heartbeatJob?.cancel()
        liveTrackingJob?.cancel()
        usageBlockJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "MonitoringFGS"

        /** API 34+ rejects a location foreground service until coarse/fine location is granted. */
        fun canStart(context: android.content.Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
            val fine = ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.ACCESS_FINE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
            val coarse = ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.ACCESS_COARSE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
            return fine || coarse
        }

        fun start(context: android.content.Context) {
            if (!canStart(context)) return
            try {
                val intent = Intent(context, MonitoringForegroundService::class.java)
                ContextCompat.startForegroundService(context, intent)
            } catch (_: Exception) {
                // Background FGS start restrictions or permission race — safe to retry later.
            }
        }

        fun refreshForegroundServiceType(context: android.content.Context) {
            val intent = Intent(context, MonitoringForegroundService::class.java)
            try {
                context.startService(intent)
            } catch (_: Exception) {
                // Service may not be running yet.
            }
        }
    }
}
