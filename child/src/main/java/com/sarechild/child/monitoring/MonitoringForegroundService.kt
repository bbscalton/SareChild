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
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
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
    private lateinit var repo: ChildRepository
    private lateinit var fused: com.google.android.gms.location.FusedLocationProviderClient
    private lateinit var geofencingClient: GeofencingClient
    private var heartbeatJob: Job? = null
    private var usageBlockJob: Job? = null
    private var lastLocation: LatLngPoint? = null
    private var lastLowBatteryAlertMs = 0L
    private var lastNotifAccess: Boolean? = null
    private var lastLocationPerm: Boolean? = null
    private var commandListener: CommandListener? = null
    private var scheduleWatcher: ScreenShareScheduleWatcher? = null
    private var lastWallClockMs: Long = 0L
    private var lastElapsedRealtimeMs: Long = 0L
    private var lastCheckInPromptMs: Long = 0L

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val loc = result.lastLocation ?: return
            lastLocation = LatLngPoint(loc.latitude, loc.longitude, loc.accuracy, System.currentTimeMillis())
        }
    }

    override fun onCreate() {
        super.onCreate()
        repo = ChildRepository(this)
        fused = LocationServices.getFusedLocationProviderClient(this)
        geofencingClient = LocationServices.getGeofencingClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        startLocationUpdates()
        startHeartbeatLoop()
        startUsageBlockLoop()
        commandListener = CommandListener(this, repo).also { it.start() }
        scheduleWatcher = ScreenShareScheduleWatcher(this, repo).also { it.start() }
        scope.launch { refreshGeofences() }
        return START_STICKY
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

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                SareChildConstants.FGS_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(SareChildConstants.FGS_NOTIFICATION_ID, notification)
        }
    }

    private fun startLocationUpdates() {
        if (!hasLocationPermission()) return
        val request = LocationRequest.Builder(
            Priority.PRIORITY_BALANCED_POWER_ACCURACY,
            SareChildConstants.LOCATION_INTERVAL_MS
        ).setMinUpdateIntervalMillis(60_000L).build()
        try {
            fused.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
        } catch (_: SecurityException) {
            // permission race
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
            todayScreenMinutes = screenMinutes
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

    private fun isNotificationAccessEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        return flat?.contains(packageName) == true
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        val network = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    override fun onDestroy() {
        commandListener?.stop()
        scheduleWatcher?.stop()
        fused.removeLocationUpdates(locationCallback)
        heartbeatJob?.cancel()
        usageBlockJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        fun start(context: android.content.Context) {
            val intent = Intent(context, MonitoringForegroundService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
