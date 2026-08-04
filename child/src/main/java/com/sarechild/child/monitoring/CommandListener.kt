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
import com.sarechild.child.LiveViewRequestActivity
import com.sarechild.child.PermissionsActivity
import com.sarechild.child.R
import com.sarechild.child.RingDeviceActivity
import com.sarechild.child.SafetyRequestActivity
import com.sarechild.child.ScreenLockHelper
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

/**
 * Listens for parent-initiated commands and either:
 *  1. Completes them silently when everything needed is already granted (the
 *     common case once a family has finished Enable Protections once), or
 *  2. For a live, in-the-moment session (screen share / camera / mic / live view),
 *     hands off to a headless gate Activity that surfaces only the one real
 *     Android system dialog required — never a custom Accept/Decline screen, or
 *  3. For a feature that still needs child setup, marks the command FAILED with
 *     a clear reason and brings the child to Enable Protections with that exact
 *     row highlighted — again, no custom Accept UI, ever.
 */
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
        if (tryCompleteIfAlreadyGranted(command)) return
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
            SafetyCommandType.REQUEST_DEVICE_ADMIN ->
                return redirectToEnableProtections(command, "device_admin", "Device Administrator")
            SafetyCommandType.REQUEST_WHATSAPP_PROTECTION ->
                return redirectToEnableProtections(command, "whatsapp", "WhatsApp protection")
            SafetyCommandType.REQUEST_CALL_RECORDING ->
                return redirectToEnableProtections(command, "call_recording", "call recording")
            SafetyCommandType.REQUEST_PHOTO_ACCESS ->
                return redirectToEnableProtections(command, "photo_gallery", "photo gallery access")
            SafetyCommandType.REQUEST_EVENT_RECORDER_ACCESS ->
                return redirectToEnableProtections(command, "event_recorder", "the activity timeline")
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
                    .setContentText("Connecting…")
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

        // Only SCREEN_SHARE, CAMERA_CHECK, and MIC_CHECK reach here — every other
        // SafetyCommandType is fully handled above. See SafetyRequestActivity: it is
        // a headless gate, never a custom Accept/Decline screen.
        val title = when (command.type) {
            SafetyCommandType.SCREEN_SHARE -> "Parent requests screen sharing"
            SafetyCommandType.CAMERA_CHECK -> "Parent requests a camera check"
            SafetyCommandType.MIC_CHECK -> "Parent requests a voice check"
            else -> return
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
            .setContentText("Connecting…")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(pending)
            // Reliably pops the gate screen full-screen even over the lock screen or
            // while the app is backgrounded — the "child can't reach the phone" /
            // emergency case this exists for. A plain startActivity() call from a
            // service can be silently blocked by modern Android's background-activity
            // -launch restrictions, so this is the OS-blessed fallback that still gets
            // through. The gate screen itself never asks the child to Accept anything —
            // it only ever surfaces a real Android system dialog.
            .setFullScreenIntent(pending, true)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.SAFETY_NOTIFICATION_ID + command.id.hashCode().and(0xff), notification)
        context.startActivity(intent)
    }

    /**
     * When consent and required OS permissions are already in place, complete the
     * parent command silently instead of launching anything on the child device.
     */
    private fun tryCompleteIfAlreadyGranted(command: SafetyCommand): Boolean {
        when (command.type) {
            SafetyCommandType.REQUEST_DEVICE_ADMIN -> {
                if (!FeatureAccessGate.isDeviceAdminReady(context)) return false
                scope.launch {
                    runCatching { repo.updateLockScreenStatus(context) }
                    repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                }
                MonitoringForegroundService.start(context)
                return true
            }
            SafetyCommandType.REQUEST_WHATSAPP_PROTECTION -> {
                if (!FeatureAccessGate.isWhatsAppProtectionReady(context, repo)) return false
                scope.launch {
                    repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                }
                MonitoringForegroundService.start(context)
                return true
            }
            SafetyCommandType.REQUEST_CALL_RECORDING -> {
                if (!FeatureAccessGate.isCallRecordingReady(context, repo)) return false
                scope.launch {
                    repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                }
                MonitoringForegroundService.start(context)
                return true
            }
            SafetyCommandType.REQUEST_PHOTO_ACCESS -> {
                if (!FeatureAccessGate.isPhotoGalleryReady(context, repo)) return false
                scope.launch {
                    runCatching {
                        PhotoGallerySync(context, repo).sync(forceFull = true)
                    }
                    repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                }
                MonitoringForegroundService.start(context)
                return true
            }
            SafetyCommandType.REQUEST_EVENT_RECORDER_ACCESS -> {
                if (!FeatureAccessGate.isEventRecorderReady(context, repo)) return false
                scope.launch {
                    runCatching {
                        val monitor = EventRecorderMonitor(context, repo)
                        monitor.start()
                        monitor.sync(force = true)
                    }
                    repo.updateCommand(command.id, SafetyCommandStatus.COMPLETED)
                }
                MonitoringForegroundService.start(context)
                return true
            }
            SafetyCommandType.SCREEN_SHARE -> {
                if (!FeatureAccessGate.isScreenShareReady(repo)) return false
                return false // still needs the per-session MediaProjection system dialog
            }
            SafetyCommandType.CAMERA_CHECK, SafetyCommandType.MIC_CHECK -> return false
            else -> return false
        }
    }

    /**
     * A parent-requested feature isn't fully set up on this device yet. Never shows a
     * custom Accept screen — marks the command FAILED with a clear reason (so the
     * parent dashboard knows what happened) and brings the child straight to Enable
     * Protections with the exact row highlighted.
     */
    private fun redirectToEnableProtections(command: SafetyCommand, itemId: String, humanLabel: String) {
        scope.launch {
            repo.updateCommand(
                command.id,
                SafetyCommandStatus.FAILED,
                error = "Needs setup on this device's Enable Protections page"
            )
        }
        val intent = Intent(context, PermissionsActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(SareChildConstants.EXTRA_HIGHLIGHT_ITEM_ID, itemId)
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
            .setContentTitle("Finish setup for $humanLabel")
            .setContentText("Tap to open Enable Protections on this phone.")
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
