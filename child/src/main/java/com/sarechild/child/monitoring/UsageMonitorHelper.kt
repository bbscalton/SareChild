package com.sarechild.child.monitoring

import android.app.AppOpsManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.provider.Settings
import androidx.core.app.NotificationCompat
import com.sarechild.child.AppBlockActivity
import com.sarechild.child.R
import com.sarechild.child.UsageLimitActivity
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.AppBlockSchedule
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SareChildConstants
import com.sarechild.shared.UsageAppEntry
import java.util.Calendar

object UsageMonitorHelper {
    private var lastBlockKey: String = ""
    private var lastBlockAtMs: Long = 0L
    private var lastBlockAlertAtMs: Long = 0L
    private var activeBlockPackage: String? = null

    /** Never block SareChild itself or critical phone/settings apps by default. */
    private val PROTECTED_PACKAGES = setOf(
        "com.sarechild.child",
        "com.android.settings",
        "com.android.dialer",
        "com.google.android.dialer",
        "com.samsung.android.dialer",
        "com.android.phone",
        "com.android.contacts",
        "com.google.android.contacts",
        "com.android.emergency"
    )

    fun hasUsageAccess(context: Context): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun openUsageSettings(context: Context) {
        context.startActivity(
            Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    fun isProtectedPackage(packageName: String): Boolean =
        packageName in PROTECTED_PACKAGES ||
            packageName.startsWith("com.android.providers.")

    suspend fun syncAndEnforce(context: Context, repo: ChildRepository): Int {
        if (!repo.usageConsent || !hasUsageAccess(context)) return 0
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val cal = Calendar.getInstance()
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        val start = cal.timeInMillis
        val end = System.currentTimeMillis()
        val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end) ?: emptyList()
        val pm = context.packageManager
        val apps = stats
            .filter { it.totalTimeInForeground > 60_000L }
            .sortedByDescending { it.totalTimeInForeground }
            .take(25)
            .map { s ->
                val label = runCatching {
                    pm.getApplicationLabel(pm.getApplicationInfo(s.packageName, 0)).toString()
                }.getOrDefault(s.packageName)
                UsageAppEntry(
                    packageName = s.packageName,
                    label = label,
                    minutes = (s.totalTimeInForeground / 60_000L).toInt()
                )
            }
        val total = apps.sumOf { it.minutes }
        repo.uploadUsageDaily(total, apps)

        val limits = repo.loadAppLimits()
        for (limit in limits) {
            val used = apps.firstOrNull { it.packageName == limit.packageName }?.minutes ?: 0
            if (used >= limit.dailyLimitMinutes) {
                notifyLimit(context, limit.label.ifBlank { limit.packageName }, used, limit.dailyLimitMinutes)
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.USAGE_LIMIT,
                        severity = AlertSeverity.MEDIUM,
                        title = "App limit reached — ${repo.childName}",
                        snippet = "${limit.label.ifBlank { limit.packageName }}: ${used}m / ${limit.dailyLimitMinutes}m"
                    )
                )
                context.startActivity(
                    Intent(context, UsageLimitActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        putExtra("label", limit.label.ifBlank { limit.packageName })
                        putExtra("minutes", used)
                        putExtra("limit", limit.dailyLimitMinutes)
                    }
                )
            }
        }
        enforceScheduledBlocks(context, repo)
        return total
    }

    suspend fun enforceScheduledBlocks(context: Context, repo: ChildRepository) {
        if (!repo.usageConsent || !hasUsageAccess(context)) return
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val foregroundPackage = currentForegroundPackage(usm) ?: run {
            activeBlockPackage = null
            return
        }
        if (isProtectedPackage(foregroundPackage) || foregroundPackage == context.packageName) {
            activeBlockPackage = null
            return
        }
        val schedules = repo.getCachedAppBlockSchedules().ifEmpty { repo.loadAppBlockSchedules() }
        val activeRule = schedules.firstOrNull {
            it.packageName == foregroundPackage && it.isActiveNow()
        }
        if (activeRule == null) {
            activeBlockPackage = null
            return
        }
        showScheduledBlock(context, repo, foregroundPackage, activeRule)
    }

    private suspend fun showScheduledBlock(
        context: Context,
        repo: ChildRepository,
        packageName: String,
        activeRule: AppBlockSchedule
    ) {
        val now = System.currentTimeMillis()
        val key = "${activeRule.id}_${packageName}_${now / 30_000L}"
        val repeatSameApp = activeBlockPackage == packageName
        if (lastBlockKey == key && now - lastBlockAtMs < 15_000L && repeatSameApp) return
        lastBlockKey = key
        lastBlockAtMs = now
        activeBlockPackage = packageName

        val label = activeRule.label.ifBlank { activeRule.packageName }
        val window = formatWindow(activeRule.startMinute, activeRule.endMinute)
        val message = activeRule.message.ifBlank { "Application has been blocked." }
        notifyBlock(context, label, window)
        if (now - lastBlockAlertAtMs > 5 * 60_000L) {
            lastBlockAlertAtMs = now
            repo.postAlert(
                FamilyAlert(
                    type = AlertType.APP_BLOCKED,
                    severity = AlertSeverity.MEDIUM,
                    title = "Scheduled app block — ${repo.childName}",
                    snippet = "$label blocked during $window"
                )
            )
        }
        context.startActivity(
            Intent(context, AppBlockActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra(AppBlockActivity.EXTRA_LABEL, label)
                putExtra(AppBlockActivity.EXTRA_MESSAGE, message)
                putExtra(AppBlockActivity.EXTRA_WINDOW, window)
                putExtra(AppBlockActivity.EXTRA_PACKAGE, packageName)
            }
        )
        // Nudge away from the blocked app — child can still return, but the enforce loop
        // will immediately re-show the block screen.
        context.startActivity(
            Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
        )
    }

    private fun currentForegroundPackage(usm: UsageStatsManager): String? {
        val end = System.currentTimeMillis()
        val begin = end - 2 * 60_000L
        val events = usm.queryEvents(begin, end)
        val event = UsageEvents.Event()
        var lastPkg: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (
                event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                    event.eventType == UsageEvents.Event.ACTIVITY_RESUMED)
            ) {
                val pkg = event.packageName
                if (!pkg.isNullOrBlank()) lastPkg = pkg
            }
        }
        return lastPkg
    }

    private fun formatWindow(startMinute: Int, endMinute: Int): String {
        fun fmt(m: Int): String {
            val h = (m / 60) % 24
            val min = m % 60
            return "%02d:%02d".format(h, min)
        }
        return "${fmt(startMinute)}-${fmt(endMinute)}"
    }

    private fun notifyLimit(context: Context, label: String, used: Int, limit: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                    "Visible safety checks",
                    NotificationManager.IMPORTANCE_HIGH
                )
            )
        }
        val n = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Screen time limit — $label")
            .setContentText("Used ${used}m of ${limit}m today. Protected by SareChild.")
            .setOngoing(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.USAGE_NOTIFICATION_ID, n)
    }

    private fun notifyBlock(context: Context, label: String, window: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                    "Visible safety checks",
                    NotificationManager.IMPORTANCE_HIGH
                )
            )
        }
        val n = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Scheduled app block — $label")
            .setContentText("Blocked during $window. Protected by SareChild.")
            .setOngoing(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.USAGE_NOTIFICATION_ID, n)
    }
}
