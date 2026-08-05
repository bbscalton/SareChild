package com.sarechild.child

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityDeviceLockBinding
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/** Visible full-screen lock — child cannot dismiss; parent sends UNLOCK_DEVICE. */
class DeviceLockActivity : AppCompatActivity() {
    private lateinit var binding: ActivityDeviceLockBinding
    private var commandId: String = ""
    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == SareChildConstants.ACTION_DEVICE_UNLOCK) {
                finishAndUnlock()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        )
        binding = ActivityDeviceLockBinding.inflate(layoutInflater)
        setContentView(binding.root)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()

        val repo = ChildRepository(this)
        repo.deviceLocked = true
        ensureChannel()
        showLockNotification()

        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
            }
            repo.setActiveSessionRemote("locked")
            repo.postAlert(
                FamilyAlert(
                    type = AlertType.DEVICE_LOCKED,
                    severity = AlertSeverity.HIGH,
                    title = "Device locked — ${repo.childName}",
                    snippet = "Visible safety lock is active on the child phone",
                    commandId = commandId.ifBlank { null }
                )
            )
        }

        val filter = IntentFilter(SareChildConstants.ACTION_DEVICE_UNLOCK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(unlockReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(unlockReceiver, filter)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Intentionally blocked while locked
    }

    override fun onResume() {
        super.onResume()
        // Self-heal: the unlock is applied authoritatively by CommandListener (see
        // DeviceLockActivity.unlock) as soon as the parent's UNLOCK_DEVICE command is
        // received, even if no DeviceLockActivity instance was alive to catch the
        // broadcast at that moment. If this instance is resumed (or recreated by the
        // system) after that already happened, close the lock screen immediately
        // instead of leaving the child stuck behind a stale lock.
        if (!ChildRepository(this).deviceLocked) {
            finish()
        }
    }

    private fun finishAndUnlock() {
        // Persisted state, the "unlocked" notification, and the family alert are all
        // already applied by DeviceLockActivity.unlock() (called from CommandListener)
        // before this broadcast was even sent — this just dismisses the live screen
        // and closes out the original LOCK_DEVICE command's own status.
        val repo = ChildRepository(this)
        repo.deviceLocked = false
        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
            }
            repo.setActiveSessionRemote(null)
        }
        finish()
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(unlockReceiver) }
        super.onDestroy()
    }

    private fun showLockNotification() {
        val n = NotificationCompat.Builder(this, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Device locked by parent")
            .setContentText("Protected by SareChild — visible safety lock")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.DEVICE_LOCK_NOTIFICATION_ID, n)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                    "Visible safety checks",
                    NotificationManager.IMPORTANCE_HIGH
                )
            )
        }
    }

    companion object {
        /**
         * Authoritative unlock, called from CommandListener (which runs inside the
         * always-on MonitoringForegroundService) as soon as the parent's UNLOCK_DEVICE
         * command arrives. Clearing the persisted `deviceLocked` flag and the ongoing
         * notification here — instead of only inside a live DeviceLockActivity instance —
         * guarantees the unlock actually takes effect even if that Activity was killed
         * by the OS while the phone sat locked (previously the only unlock path was a
         * broadcast to that specific instance, so it could silently do nothing).
         * The broadcast below is kept so a currently visible lock screen dismisses
         * itself instantly instead of waiting for its next onResume.
         */
        fun unlock(context: Context, repo: ChildRepository) {
            repo.deviceLocked = false
            // Replaces the ongoing "locked" notification (same id) with a dismissible
            // "unlocked" one — visible confirmation for the child, matching the lock flow.
            showUnlockedNotification(context)
            context.sendBroadcast(Intent(SareChildConstants.ACTION_DEVICE_UNLOCK))
        }

        private fun showUnlockedNotification(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                    NotificationChannel(
                        SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                        "Visible safety checks",
                        NotificationManager.IMPORTANCE_HIGH
                    )
                )
            }
            val notification = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle("Device unlocked by parent")
                .setContentText("Protected by SareChild — visible safety unlock")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .build()
            context.getSystemService(NotificationManager::class.java)
                .notify(SareChildConstants.DEVICE_LOCK_NOTIFICATION_ID, notification)
        }
    }
}
