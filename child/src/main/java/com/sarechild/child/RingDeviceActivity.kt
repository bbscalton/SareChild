package com.sarechild.child

import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityRingDeviceBinding
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/** Overt find-my-child ring — full screen + loud alarm + notification. */
class RingDeviceActivity : AppCompatActivity() {
    private lateinit var binding: ActivityRingDeviceBinding
    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null
    private var commandId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        )
        binding = ActivityRingDeviceBinding.inflate(layoutInflater)
        setContentView(binding.root)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()
        ensureChannel()
        showNotification()
        startAlarm()

        val repo = ChildRepository(this)
        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
            }
            repo.postAlert(
                FamilyAlert(
                    type = AlertType.RING_DEVICE,
                    severity = AlertSeverity.HIGH,
                    title = "Ringing ${repo.childName}'s device",
                    snippet = "Visible locate alarm is playing on the child phone",
                    commandId = commandId.ifBlank { null }
                )
            )
        }

        binding.dismiss.setOnClickListener { stopAndFinish(repo) }
    }

    private fun startAlarm() {
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        ringtone = RingtoneManager.getRingtone(this, uri)?.also {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                it.isLooping = true
            }
            it.play()
        }
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(VIBRATOR_SERVICE) as? Vibrator
        }
        vibrator?.let { v ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 500, 500), 0))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(longArrayOf(0, 500, 500), 0)
            }
        }
    }

    private fun stopAndFinish(repo: ChildRepository) {
        ringtone?.stop()
        vibrator?.cancel()
        getSystemService(NotificationManager::class.java)
            .cancel(SareChildConstants.RING_NOTIFICATION_ID)
        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
            }
            finish()
        }
    }

    private fun showNotification() {
        val n = NotificationCompat.Builder(this, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Parent is ringing this device")
            .setContentText("Protected by SareChild — visible locate alarm")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .build()
        getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.RING_NOTIFICATION_ID, n)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                    "Visible safety checks",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .build()
                    )
                }
            )
        }
    }

    override fun onDestroy() {
        ringtone?.stop()
        vibrator?.cancel()
        super.onDestroy()
    }
}
