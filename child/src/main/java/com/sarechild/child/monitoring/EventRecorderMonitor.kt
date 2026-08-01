package com.sarechild.child.monitoring

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Build
import androidx.core.content.ContextCompat
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.ActivityEvent
import com.sarechild.shared.ActivityEventType
import com.sarechild.shared.SareChildConstants
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/**
 * Consent-gated structured activity logger: app foreground sessions, screen on/off, idle,
 * media playback metadata (MediaSession + notification fallback), and best-effort browser
 * URL/title inference via the existing accessibility service. Batches uploads to Firestore.
 */
class EventRecorderMonitor(
    private val context: Context,
    private val repo: ChildRepository
) {
    private val pending = ConcurrentLinkedQueue<ActivityEvent>()
    private val appLabelCache = mutableMapOf<String, String>()
    private var screenReceiver: BroadcastReceiver? = null
    private var screenOn = true
    private var idleActive = false
    private var idleStartMs: Long = 0L
    private var foregroundPkg: String? = null
    private var foregroundStartMs: Long = 0L
    private var lastMediaKey: String? = null
    private var lastMediaTitle: String? = null
    private var lastMediaAtMs: Long = 0L
    private val a11yTimestamps = ArrayDeque<Long>()
    private val events24h = AtomicInteger(0)
    private var events24hWindowStartMs: Long = System.currentTimeMillis()

    fun start() {
        bind(this)
        registerScreenReceiver()
    }

    fun stop() {
        screenReceiver?.let { runCatching { context.unregisterReceiver(it) } }
        screenReceiver = null
        unbind(this)
    }

    fun shouldRunPeriodicSync(): Boolean {
        if (!repo.eventRecorderConsent) return false
        val last = repo.lastEventRecorderSyncMs
        return System.currentTimeMillis() - last >= SareChildConstants.EVENT_RECORDER_SYNC_INTERVAL_MS
    }

    fun statusMap(
        usageAccess: Boolean,
        accessibilityAccess: Boolean,
        notificationAccess: Boolean
    ): Map<String, Any?> {
        val now = System.currentTimeMillis()
        return mapOf(
            "consent" to repo.eventRecorderConsent,
            "usageAccess" to usageAccess,
            "accessibilityAccess" to accessibilityAccess,
            "notificationAccess" to notificationAccess,
            "lastSyncAtMs" to repo.lastEventRecorderSyncMs,
            "eventCount24h" to repo.eventRecorderEventCount24h,
            "screenOn" to screenOn,
            "updatedAtMs" to now
        )
    }

    suspend fun sync(force: Boolean = false) {
        if (!repo.eventRecorderConsent) return
        pollUsageForegroundEvents()
        pollMediaSessions()
        checkIdleTimeout()
        if (force || pending.size >= SareChildConstants.EVENT_RECORDER_BATCH_MAX) {
            flushPending(force)
        } else if (shouldRunPeriodicSync()) {
            flushPending(force = false)
        }
        updateStatus()
    }

    fun onScreenOn() {
        if (!repo.eventRecorderConsent) return
        screenOn = true
        enqueue(ActivityEventType.SCREEN_ON, details = "Screen turned on")
        if (idleActive) {
            idleActive = false
            enqueue(
                ActivityEventType.IDLE_END,
                startedAtMs = idleStartMs,
                endedAtMs = System.currentTimeMillis(),
                durationMs = System.currentTimeMillis() - idleStartMs
            )
        }
        touchActivity()
    }

    fun onScreenOff() {
        if (!repo.eventRecorderConsent) return
        screenOn = false
        closeForegroundSession(System.currentTimeMillis())
        enqueue(ActivityEventType.SCREEN_OFF, details = "Screen turned off")
        if (!idleActive) {
            idleActive = true
            idleStartMs = System.currentTimeMillis()
            enqueue(ActivityEventType.IDLE_START, startedAtMs = idleStartMs, details = "Screen off")
        }
    }

    /** Called from MessageMonitorAccessibilityService on window changes. */
    fun onWindowChanged(packageName: String, className: String?, titleHint: String?) {
        if (!repo.eventRecorderConsent || !allowA11yEvent()) return
        touchActivity()
        val label = resolveLabel(packageName)
        val details = listOfNotNull(className?.substringAfterLast('.'), titleHint?.take(120))
            .filter { it.isNotBlank() }
            .joinToString(" · ")
            .ifBlank { null }
        enqueue(
            ActivityEventType.WINDOW_CHANGED,
            packageName = packageName,
            appLabel = label,
            title = titleHint?.take(160),
            details = details
        )
        maybeInferWebVisit(packageName, titleHint, details)
    }

    /** Rate-limited tap/interaction summary — not raw keylogging. */
    fun onInteraction(packageName: String, contentDescription: String?) {
        if (!repo.eventRecorderConsent || !allowA11yEvent()) return
        touchActivity()
        enqueue(
            ActivityEventType.INTERACTION,
            packageName = packageName,
            appLabel = resolveLabel(packageName),
            details = contentDescription?.take(80)
        )
    }

    fun onNotificationMedia(packageName: String, title: String, text: String) {
        if (!repo.eventRecorderConsent) return
        val combined = listOf(title, text).filter { it.isNotBlank() }.joinToString(" — ")
        if (combined.isBlank()) return
        val key = "$packageName|$combined"
        val now = System.currentTimeMillis()
        if (key == lastMediaKey && now - lastMediaAtMs < 60_000L) return
        lastMediaKey = key
        lastMediaAtMs = now
        touchActivity()
        enqueue(
            ActivityEventType.NOTIFICATION_MEDIA,
            packageName = packageName,
            appLabel = resolveLabel(packageName),
            title = title.take(160),
            details = text.take(200)
        )
    }

    private fun registerScreenReceiver() {
        if (screenReceiver != null) return
        screenReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_ON -> onScreenOn()
                    Intent.ACTION_SCREEN_OFF -> onScreenOff()
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        ContextCompat.registerReceiver(context, screenReceiver!!, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun pollUsageForegroundEvents() {
        if (!UsageMonitorHelper.hasUsageAccess(context)) return
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val end = System.currentTimeMillis()
        val begin = maxOf(repo.lastUsageEventPollMs, end - 24 * 60 * 60_000L)
        val events = usm.queryEvents(begin, end)
        val event = UsageEvents.Event()
        var lastPoll = begin
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            lastPoll = maxOf(lastPoll, event.timeStamp)
            val pkg = event.packageName ?: continue
            if (UsageMonitorHelper.isProtectedPackage(pkg)) continue
            when (event.eventType) {
                UsageEvents.Event.MOVE_TO_FOREGROUND,
                UsageEvents.Event.ACTIVITY_RESUMED -> onAppForeground(pkg, event.timeStamp)
                UsageEvents.Event.MOVE_TO_BACKGROUND,
                UsageEvents.Event.ACTIVITY_PAUSED -> {
                    if (pkg == foregroundPkg) {
                        closeForegroundSession(event.timeStamp)
                    }
                    enqueue(
                        ActivityEventType.APP_BACKGROUND,
                        packageName = pkg,
                        appLabel = resolveLabel(pkg),
                        startedAtMs = event.timeStamp
                    )
                }
            }
        }
        repo.lastUsageEventPollMs = lastPoll
    }

    private fun onAppForeground(packageName: String, atMs: Long) {
        touchActivity(atMs)
        if (foregroundPkg == packageName) return
        closeForegroundSession(atMs)
        foregroundPkg = packageName
        foregroundStartMs = atMs
        enqueue(
            ActivityEventType.APP_FOREGROUND,
            packageName = packageName,
            appLabel = resolveLabel(packageName),
            startedAtMs = atMs
        )
    }

    private fun closeForegroundSession(endMs: Long) {
        val pkg = foregroundPkg ?: return
        val start = foregroundStartMs
        if (start <= 0L) {
            foregroundPkg = null
            return
        }
        val duration = endMs - start
        if (duration >= SareChildConstants.EVENT_RECORDER_MIN_FOREGROUND_MS) {
            enqueue(
                ActivityEventType.APP_BACKGROUND,
                packageName = pkg,
                appLabel = resolveLabel(pkg),
                startedAtMs = start,
                endedAtMs = endMs,
                durationMs = duration
            )
        }
        foregroundPkg = null
        foregroundStartMs = 0L
    }

    private fun pollMediaSessions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return
        val msm = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager ?: return
        val controllers = runCatching {
            msm.getActiveSessions(null)
        }.getOrNull().orEmpty()
        val now = System.currentTimeMillis()
        for (controller in controllers) {
            val pkg = controller.packageName ?: continue
            val metadata = controller.metadata ?: continue
            val title = metadata.getString(android.media.MediaMetadata.METADATA_KEY_TITLE)
                ?: metadata.getString(android.media.MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
                ?: continue
            val artist = metadata.getString(android.media.MediaMetadata.METADATA_KEY_ARTIST)
            val state = controller.playbackState?.state ?: continue
            val playing = state == PlaybackState.STATE_PLAYING
            val key = "$pkg|$title|$playing"
            if (key == lastMediaKey && now - lastMediaAtMs < 45_000L) continue
            lastMediaKey = key
            lastMediaTitle = title
            lastMediaAtMs = now
            touchActivity(now)
            val type = if (playing) ActivityEventType.MEDIA_PLAY else ActivityEventType.MEDIA_PAUSE
            enqueue(
                type,
                packageName = pkg,
                appLabel = resolveLabel(pkg),
                title = title.take(160),
                details = artist?.take(120)
            )
        }
    }

    private fun maybeInferWebVisit(packageName: String, titleHint: String?, details: String?) {
        if (!isBrowserPackage(packageName)) return
        val blob = listOfNotNull(titleHint, details).joinToString(" ")
        val url = extractUrl(blob) ?: return
        val now = System.currentTimeMillis()
        enqueue(
            ActivityEventType.WEB_VISIT_INFERRED,
            packageName = packageName,
            appLabel = resolveLabel(packageName),
            title = titleHint?.take(160),
            url = url,
            inferred = true,
            startedAtMs = now,
            details = "Best-effort URL from on-screen text"
        )
    }

    private fun checkIdleTimeout() {
        if (!screenOn || idleActive) return
        val last = repo.lastActivityAtMs
        if (last <= 0L) return
        val now = System.currentTimeMillis()
        if (now - last < SareChildConstants.EVENT_RECORDER_IDLE_MS) return
        if (!idleActive) {
            idleActive = true
            idleStartMs = last + SareChildConstants.EVENT_RECORDER_IDLE_MS
            enqueue(ActivityEventType.IDLE_START, startedAtMs = idleStartMs, details = "No activity timeout")
        }
    }

    private fun touchActivity(atMs: Long = System.currentTimeMillis()) {
        repo.lastActivityAtMs = atMs
        if (idleActive && screenOn) {
            idleActive = false
            enqueue(
                ActivityEventType.IDLE_END,
                startedAtMs = idleStartMs,
                endedAtMs = atMs,
                durationMs = atMs - idleStartMs
            )
        }
    }

    private suspend fun flushPending(force: Boolean) {
        if (pending.isEmpty()) {
            if (force) repo.lastEventRecorderSyncMs = System.currentTimeMillis()
            return
        }
        val batch = mutableListOf<ActivityEvent>()
        while (pending.isNotEmpty() && batch.size < SareChildConstants.EVENT_RECORDER_BATCH_MAX) {
            pending.poll()?.let { batch.add(it) }
        }
        if (batch.isEmpty()) return
        runCatching {
            repo.postActivityEvents(batch)
            repo.lastEventRecorderSyncMs = System.currentTimeMillis()
            bump24hCount(batch.size)
        }
    }

    private suspend fun updateStatus() {
        val notif = NotificationMonitorService.isEnabled(context)
        val a11y = MessageMonitorAccessibilityService.isServiceEnabled(context)
        repo.updateEventRecorderStatus(
            statusMap(
                usageAccess = UsageMonitorHelper.hasUsageAccess(context),
                accessibilityAccess = a11y,
                notificationAccess = notif
            )
        )
    }

    private fun bump24hCount(count: Int) {
        val now = System.currentTimeMillis()
        if (now - events24hWindowStartMs > 24 * 60 * 60_000L) {
            events24hWindowStartMs = now
            events24h.set(0)
        }
        val total = events24h.addAndGet(count)
        repo.eventRecorderEventCount24h = total.coerceAtLeast(repo.eventRecorderEventCount24h)
    }

    private fun allowA11yEvent(): Boolean {
        val now = System.currentTimeMillis()
        while (a11yTimestamps.isNotEmpty() && now - a11yTimestamps.first() > 60_000L) {
            a11yTimestamps.removeFirst()
        }
        if (a11yTimestamps.size >= SareChildConstants.EVENT_RECORDER_A11Y_RATE_PER_MIN) return false
        a11yTimestamps.addLast(now)
        return true
    }

    private fun enqueue(
        type: ActivityEventType,
        packageName: String? = null,
        appLabel: String? = null,
        title: String? = null,
        details: String? = null,
        url: String? = null,
        inferred: Boolean = false,
        startedAtMs: Long? = null,
        endedAtMs: Long? = null,
        durationMs: Long? = null
    ) {
        pending.add(
            ActivityEvent(
                type = type,
                packageName = packageName,
                appLabel = appLabel,
                title = title,
                details = details,
                url = url,
                inferred = inferred,
                startedAtMs = startedAtMs,
                endedAtMs = endedAtMs,
                durationMs = durationMs
            )
        )
    }

    private fun resolveLabel(packageName: String): String =
        appLabelCache.getOrPut(packageName) {
            runCatching {
                val pm = context.packageManager
                pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
            }.getOrDefault(packageName)
        }

    private fun isBrowserPackage(pkg: String): Boolean =
        pkg in BROWSER_PACKAGES || pkg.contains("browser", ignoreCase = true)

    private fun extractUrl(text: String): String? {
        val match = URL_REGEX.find(text) ?: return null
        return match.value.take(500)
    }

    companion object {
        @Volatile
        private var activeMonitor: EventRecorderMonitor? = null

        fun bind(monitor: EventRecorderMonitor) {
            activeMonitor = monitor
        }

        fun unbind(monitor: EventRecorderMonitor) {
            if (activeMonitor === monitor) activeMonitor = null
        }

        fun current(): EventRecorderMonitor? = activeMonitor

        private val URL_REGEX = Regex("""https?://[^\s<>"]+""", RegexOption.IGNORE_CASE)
        private val BROWSER_PACKAGES = setOf(
            "com.android.chrome",
            "com.google.android.apps.chrome",
            "org.mozilla.firefox",
            "com.microsoft.emmx",
            "com.opera.browser",
            "com.brave.browser",
            "com.sec.android.app.sbrowser",
            "com.samsung.android.app.sbrowser"
        )

        fun isMediaNotificationPackage(packageName: String): Boolean =
            packageName in MEDIA_PACKAGES ||
                packageName.contains("youtube", ignoreCase = true) ||
                packageName.contains("spotify", ignoreCase = true)

        private val MEDIA_PACKAGES = setOf(
            "com.google.android.youtube",
            "com.google.android.apps.youtube.music",
            "com.spotify.music",
            "com.netflix.mediaclient",
            "com.amazon.avod.thirdpartyclient"
        )
    }
}
