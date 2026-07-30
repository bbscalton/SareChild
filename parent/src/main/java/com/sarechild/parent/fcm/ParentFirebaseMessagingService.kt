package com.sarechild.parent.fcm

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.sarechild.parent.MainActivity
import com.sarechild.parent.R
import com.sarechild.parent.data.ParentRepository
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class ParentFirebaseMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val repo = ParentRepository()

    override fun onNewToken(token: String) {
        scope.launch {
            runCatching { repo.saveFcmToken(token) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.data["title"]
            ?: message.notification?.title
            ?: "SareChild alert"
        val body = message.data["body"]
            ?: message.notification?.body
            ?: "Open the app for details"

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, SareChildConstants.NOTIFICATION_CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(this).notify(System.currentTimeMillis().toInt(), notification)
    }
}
