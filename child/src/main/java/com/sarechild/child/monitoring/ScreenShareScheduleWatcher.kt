package com.sarechild.child.monitoring

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.firestore.ListenerRegistration
import com.sarechild.child.R
import com.sarechild.child.SafetyRequestActivity
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.ScreenShareSchedule
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Watches parent-configured screen-share schedules and prompts the child at the scheduled time.
 */
class ScreenShareScheduleWatcher(
    private val context: Context,
    private val repo: ChildRepository
) {
    private var registration: ListenerRegistration? = null
    private val scope = CoroutineScope(Dispatchers.IO)
    private var schedules: List<ScreenShareSchedule> = emptyList()
    private val firedToday = ConcurrentHashMap.newKeySet<String>()

    fun start() {
        stop()
        registration = repo.listenScreenShareSchedules { list ->
            schedules = list
        }
    }

    fun stop() {
        registration?.remove()
        registration = null
    }

    fun tick() {
        if (!repo.screenShareConsent || schedules.isEmpty()) return
        val now = System.currentTimeMillis()
        schedules.forEach { schedule ->
            if (!schedule.isDueNow(now)) return@forEach
            val key = "${schedule.id}_${schedule.dayKey(now)}"
            if (!firedToday.add(key)) return@forEach
            if (schedule.lastTriggeredDayKey == schedule.dayKey(now)) return@forEach
            scope.launch {
                repo.markScheduleTriggered(schedule.id, schedule.dayKey(now))
                promptScheduledShare(schedule)
            }
        }
        if (firedToday.size > 100) firedToday.clear()
    }

    private fun promptScheduledShare(schedule: ScreenShareSchedule) {
        ensureChannel()
        val intent = Intent(context, SafetyRequestActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(SareChildConstants.EXTRA_COMMAND_TYPE, "SCREEN_SHARE")
            putExtra(SareChildConstants.EXTRA_DURATION_MINUTES, schedule.durationMinutes)
            putExtra(SareChildConstants.EXTRA_SCHEDULE_ID, schedule.id)
        }
        val pending = PendingIntent.getActivity(
            context,
            schedule.id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Scheduled screen share: ${schedule.label}")
            .setContentText("Starting screen share… Protected by SareChild.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + schedule.id.hashCode().and(0xff), notification)
        context.startActivity(intent)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                    "Visible safety checks",
                    NotificationManager.IMPORTANCE_HIGH
                )
            )
        }
    }
}
