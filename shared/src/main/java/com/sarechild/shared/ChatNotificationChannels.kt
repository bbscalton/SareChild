package com.sarechild.shared

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build

/**
 * Creates the two family-chat notification channels shared by the parent and child apps.
 * Both apps must call [ensure] on process start (before any FCM message can arrive) because
 * Android freezes a channel's sound/importance/vibration the moment it's first created —
 * whatever we set here is what the user gets even when the app is killed and the system
 * tray shows the notification on our behalf.
 */
object ChatNotificationChannels {
    fun ensure(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return

        val chatAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val chatChannel = NotificationChannel(
            SareChildConstants.NOTIFICATION_CHANNEL_FAMILY_CHAT,
            "Family chat",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "New messages in your family's SareChild chat"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 250, 150, 250)
            enableLights(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), chatAttributes)
        }

        // Urgent variant: triggered when a chat message contains a safety/urgency keyword.
        // Uses the device's default ALARM tone (not a custom asset) so it reads as
        // meaningfully more serious than a normal chat "ding" without shipping audio files.
        val alarmAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val urgentChannel = NotificationChannel(
            SareChildConstants.NOTIFICATION_CHANNEL_CHAT_URGENT,
            "Urgent family chat",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "A family chat message that looks urgent or safety-related"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 400, 200, 400)
            enableLights(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            val alarmUri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            setSound(alarmUri, alarmAttributes)
        }

        nm.createNotificationChannel(chatChannel)
        nm.createNotificationChannel(urgentChannel)
    }
}
