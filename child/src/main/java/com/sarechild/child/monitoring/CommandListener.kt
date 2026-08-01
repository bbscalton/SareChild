package com.sarechild.child.monitoring

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.firestore.ListenerRegistration
import com.sarechild.child.CallRecordingRequestActivity
import com.sarechild.child.DeviceAdminRequestActivity
import com.sarechild.child.DeviceLockActivity
import com.sarechild.child.LiveViewRequestActivity
import com.sarechild.child.R
import com.sarechild.child.EventRecorderRequestActivity
import com.sarechild.child.PhotoGalleryRequestActivity
import com.sarechild.child.RingDeviceActivity
import com.sarechild.child.ScreenLockHelper
import com.sarechild.child.SafetyRequestActivity
import com.sarechild.child.WhatsAppProtectionRequestActivity
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
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
            SafetyCommandType.STOP_LIVE_VIEW -> {
                context.stopService(Intent(context, LiveViewService::class.java))
                scope.launch {
                    repo.setActiveSessionRemote(null)
                    repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                }
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
            SafetyCommandType.REQUEST_APP_INVENTORY -> {
                scope.launch {
                    repo.updateCommand(command.id, SafetyCommandStatus.RUNNING)
                    runCatching {
                        AppInventoryHelper.sync(context, repo, force = true)
                        repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                    }.onFailure { e ->
                        repo.updateCommand(
                            command.id,
                            SafetyCommandStatus.FAILED,
                            error = e.message ?: "Inventory sync failed"
                        )
                    }
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
                // Authoritative unlock — see DeviceLockActivity.unlock() doc for why this
                // must not depend on a specific DeviceLockActivity instance still being alive.
                DeviceLockActivity.unlock(context, repo)
                scope.launch {
                    repo.setActiveSessionRemote(null)
                    repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                    repo.postAlert(
                        FamilyAlert(
                            type = AlertType.DEVICE_UNLOCKED,
                            severity = AlertSeverity.MEDIUM,
                            title = "Device unlocked — ${repo.childName}",
                            snippet = "Visible safety lock was removed by parent request",
                            commandId = command.id
                        )
                    )
                }
                return
            }
            SafetyCommandType.LOCK_SCREEN -> {
                ScreenLockHelper.execute(context, repo, command.id, scope)
                return
            }
            SafetyCommandType.REQUEST_DEVICE_ADMIN -> {
                val intent = Intent(context, DeviceAdminRequestActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
                }
                val pending = PendingIntent.getActivity(
                    context,
                    command.id.hashCode(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentTitle("Parent requests Device Administrator")
                    .setContentText("Tap to enable remote lock screen. Android will ask you to confirm.")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentIntent(pending)
                    .setFullScreenIntent(pending, true)
                    .setAutoCancel(true)
                    .build()
                context.getSystemService(NotificationManager::class.java)
                    .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + command.id.hashCode().and(0xff), notification)
                context.startActivity(intent)
                scope.launch { repo.updateCommand(command.id, SafetyCommandStatus.RUNNING) }
                return
            }
            SafetyCommandType.REQUEST_WHATSAPP_PROTECTION -> {
                val intent = Intent(context, WhatsAppProtectionRequestActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
                }
                val pending = PendingIntent.getActivity(
                    context,
                    command.id.hashCode(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentTitle("Parent requests WhatsApp protection")
                    .setContentText("Tap to Accept and enable notification + accessibility access.")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentIntent(pending)
                    .setFullScreenIntent(pending, true)
                    .setAutoCancel(true)
                    .build()
                context.getSystemService(NotificationManager::class.java)
                    .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + command.id.hashCode().and(0xff), notification)
                context.startActivity(intent)
                return
            }
            SafetyCommandType.REQUEST_CALL_RECORDING -> {
                val intent = Intent(context, CallRecordingRequestActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
                }
                val pending = PendingIntent.getActivity(
                    context,
                    command.id.hashCode(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentTitle("Parent requests call recording")
                    .setContentText("Tap to Accept. A timer will auto-allow if you can't respond.")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentIntent(pending)
                    .setFullScreenIntent(pending, true)
                    .setAutoCancel(true)
                    .build()
                context.getSystemService(NotificationManager::class.java)
                    .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + command.id.hashCode().and(0xff), notification)
                context.startActivity(intent)
                return
            }
            SafetyCommandType.REQUEST_PHOTO_ACCESS -> {
                val intent = Intent(context, PhotoGalleryRequestActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
                }
                val pending = PendingIntent.getActivity(
                    context,
                    command.id.hashCode(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentTitle("Parent requests photo gallery access")
                    .setContentText("Tap to Accept. A timer will auto-allow if you can't respond.")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentIntent(pending)
                    .setFullScreenIntent(pending, true)
                    .setAutoCancel(true)
                    .build()
                context.getSystemService(NotificationManager::class.java)
                    .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + command.id.hashCode().and(0xff), notification)
                context.startActivity(intent)
                return
            }
            SafetyCommandType.REQUEST_PHOTO_SYNC -> {
                scope.launch {
                    repo.updateCommand(command.id, SafetyCommandStatus.RUNNING)
                    runCatching {
                        if (!repo.photoGalleryConsent) {
                            error("Photo gallery consent not granted")
                        }
                        if (!PhotoGallerySync.hasPhotoPermission(context)) {
                            error("Photo permission not granted")
                        }
                        repo.lastPhotoModifiedMs = 0L
                        PhotoGallerySync(context, repo).sync(forceFull = true)
                        repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                    }.onFailure { e ->
                        repo.updateCommand(
                            command.id,
                            SafetyCommandStatus.FAILED,
                            error = e.message ?: "Photo sync failed"
                        )
                    }
                }
                return
            }
            SafetyCommandType.REQUEST_EVENT_RECORDER_ACCESS -> {
                val intent = Intent(context, EventRecorderRequestActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
                }
                val pending = PendingIntent.getActivity(
                    context,
                    command.id.hashCode(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentTitle("Parent requests Event Recorder")
                    .setContentText("Tap to Accept. A timer will auto-allow if you can't respond.")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentIntent(pending)
                    .setFullScreenIntent(pending, true)
                    .setAutoCancel(true)
                    .build()
                context.getSystemService(NotificationManager::class.java)
                    .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + command.id.hashCode().and(0xff), notification)
                context.startActivity(intent)
                return
            }
            SafetyCommandType.REQUEST_EVENT_RECORDER_SYNC -> {
                scope.launch {
                    repo.updateCommand(command.id, SafetyCommandStatus.RUNNING)
                    runCatching {
                        if (!repo.eventRecorderConsent) {
                            error("Event Recorder consent not granted")
                        }
                        if (!UsageMonitorHelper.hasUsageAccess(context)) {
                            error("Usage access not granted")
                        }
                        val monitor = EventRecorderMonitor(context, repo)
                        monitor.start()
                        monitor.sync(force = true)
                        repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                    }.onFailure { e ->
                        repo.updateCommand(
                            command.id,
                            SafetyCommandStatus.FAILED,
                            error = e.message ?: "Event Recorder sync failed"
                        )
                    }
                }
                return
            }
            SafetyCommandType.START_LIVE_VIEW -> {
                val sessionId = command.liveSessionId.orEmpty()
                val intent = Intent(context, LiveViewRequestActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(SareChildConstants.EXTRA_COMMAND_ID, command.id)
                    putExtra(SareChildConstants.EXTRA_LIVE_SESSION_ID, sessionId)
                    command.durationMinutes?.let {
                        putExtra(SareChildConstants.EXTRA_DURATION_MINUTES, it)
                    }
                    command.liveVideo?.let { putExtra(SareChildConstants.EXTRA_LIVE_VIDEO, it) }
                    command.liveAudio?.let { putExtra(SareChildConstants.EXTRA_LIVE_AUDIO, it) }
                    command.liveScreen?.let { putExtra(SareChildConstants.EXTRA_LIVE_SCREEN, it) }
                    command.liveRecord?.let { putExtra(SareChildConstants.EXTRA_LIVE_RECORD, it) }
                    command.cameraFront?.let { putExtra(SareChildConstants.EXTRA_CAMERA_FACING, it) }
                }
                val pending = PendingIntent.getActivity(
                    context,
                    command.id.hashCode(),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentTitle("Parent requests live viewing")
                    .setContentText("Tap to Allow or Not now. Timer auto-allows if you can't respond.")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setContentIntent(pending)
                    .setFullScreenIntent(pending, true)
                    .setAutoCancel(true)
                    .build()
                context.getSystemService(NotificationManager::class.java)
                    .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + command.id.hashCode().and(0xff), notification)
                context.startActivity(intent)
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
            .setContentText("A timer will auto-allow this if you can't respond. Tap to Allow or Not now.")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(pending)
            // Reliably pops the Allow screen full-screen even over the lock screen or
            // while the app is backgrounded — the "child can't reach the phone" /
            // emergency case this whole countdown flow exists for. A plain
            // startActivity() call from a service can be silently blocked by modern
            // Android's background-activity-launch restrictions, so this is the
            // OS-blessed fallback that still gets through.
            .setFullScreenIntent(pending, true)
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
