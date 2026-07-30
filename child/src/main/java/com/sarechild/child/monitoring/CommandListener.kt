package com.sarechild.child.monitoring

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.firestore.ListenerRegistration
import com.sarechild.child.DeviceLockActivity
import com.sarechild.child.R
import com.sarechild.child.RingDeviceActivity
import com.sarechild.child.SafetyRequestActivity
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.SafetyCommand
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SafetyCommandType
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class CommandListener(
    private val context: Context,
    private val repo: ChildRepository
) {
    private var registration: ListenerRegistration? = null
    private val seen = ConcurrentHashMap.newKeySet<String>()
    private val scope = CoroutineScope(Dispatchers.IO)

    fun start() {
        stop()
        ensureChannel()
        registration = repo.listenPendingCommands { command ->
            if (!seen.add(command.id)) return@listenPendingCommands
            if (seen.size > 50) seen.clear()
            notifyAndLaunch(command)
        }
    }

    fun stop() {
        registration?.remove()
        registration = null
    }

    private fun notifyAndLaunch(command: SafetyCommand) {
        when (command.type) {
            SafetyCommandType.STOP_SCREEN_SHARE -> {
                context.stopService(Intent(context, ScreenShareService::class.java))
                scope.launch { repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED) }
                return
            }
            SafetyCommandType.RING_DEVICE -> {
                val intent = Intent(context, RingDeviceActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
                }
                context.startActivity(intent)
                return
            }
            SafetyCommandType.SYNC_CALL_SMS -> {
                scope.launch {
                    repo.updateCommand(command.id, SafetyCommandStatus.RUNNING)
                    CallSmsSyncHelper.sync(context, repo, command.id)
                }
                return
            }
            SafetyCommandType.LOCK_DEVICE -> {
                val intent = Intent(context, DeviceLockActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
                }
                context.startActivity(intent)
                scope.launch { repo.updateCommand(command.id, SafetyCommandStatus.RUNNING) }
                return
            }
            SafetyCommandType.UNLOCK_DEVICE -> {
                DeviceLockActivity.unlock(context)
                scope.launch { repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED) }
                return
            }
            else -> Unit
        }

        val title = when (command.type) {
            SafetyCommandType.SCREEN_SHARE -> "Parent requests screen sharing"
            SafetyCommandType.CAMERA_CHECK -> "Parent requests a camera check"
            SafetyCommandType.MIC_CHECK -> "Parent requests a voice check"
            else -> "Parent safety request"
        }

        val intent = Intent(context, SafetyRequestActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
            putExtra(SareChildConstants.EXTRA_COMMAND_TYPE, command.type.name)
            command.durationMinutes?.let {
                putExtra(SareChildConstants.EXTRA_DURATION_MINUTES, it)
            }
        }
        val pending = PendingIntent.getActivity(
            context,
            command.id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText("Tap to Accept or Decline. This is visible on purpose.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + command.id.hashCode().and(0xff), notification)
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
