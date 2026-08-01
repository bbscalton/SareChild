package com.sarechild.child

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Executes parent LOCK_SCREEN commands via DevicePolicyManager.lockNow(). */
object ScreenLockHelper {
    private const val LOCK_SCREEN_NOTIFICATION_ID = 1012

    fun execute(
        context: Context,
        repo: ChildRepository,
        commandId: String,
        scope: CoroutineScope,
    ) {
        scope.launch {
            repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
            if (!DeviceAdminHelper.isAdminActive(context)) {
                repo.recordLockScreenResult(context, success = false, message = "device_admin_disabled")
                repo.updateCommand(
                    commandId,
                    SafetyCommandStatus.FAILED,
                    error = "Device Administrator is not enabled on the child phone"
                )
                showNeedsAdminNotification(context)
                return@launch
            }

            val result = runCatching { DeviceAdminHelper.lockNow(context) }
            if (result.isSuccess) {
                repo.recordLockScreenResult(context, success = true, message = "success")
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
                showLockedNotification(context)
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.SCREEN_LOCKED,
                        severity = AlertSeverity.MEDIUM,
                        title = "Screen locked — ${repo.childName}",
                        snippet = "Phone locked to system lock screen by parent request",
                        commandId = commandId
                    )
                )
            } else {
                val msg = result.exceptionOrNull()?.message ?: "lockNow failed"
                repo.recordLockScreenResult(context, success = false, message = msg)
                repo.updateCommand(commandId, SafetyCommandStatus.FAILED, error = msg)
            }
        }
    }

    private fun showLockedNotification(context: Context) {
        ensureChannel(context)
        val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Screen locked by parent")
            .setContentText("Protected by SareChild — use your PIN, pattern, or fingerprint to unlock")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(LOCK_SCREEN_NOTIFICATION_ID, notification)
    }

    private fun showNeedsAdminNotification(context: Context) {
        ensureChannel(context)
        val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Remote lock needs setup")
            .setContentText("Ask your parent to send \"Request Device Admin\" — then enable it in Settings")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(LOCK_SCREEN_NOTIFICATION_ID, notification)
    }

    private fun ensureChannel(context: Context) {
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
