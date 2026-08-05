package com.sarechild.child.fcm

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.sarechild.child.FamilyChatActivity
import com.sarechild.child.MainActivity
import com.sarechild.child.R
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.monitoring.DeviceUnpairHandler
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Delivers family chat pushes (and, going forward, any other FCM alert) to the child
 * device. Registered in the manifest so Android also wakes it for high-priority
 * data-only messages while the app is backgrounded — see onAlertCreated /
 * onFamilyChatMessageCreated in functions/src/index.ts for the server side.
 */
class ChildFirebaseMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val repo by lazy { ChildRepository(this) }

    override fun onNewToken(token: String) {
        scope.launch {
            runCatching { repo.saveFcmToken(token) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data[SareChildConstants.FCM_DATA_TYPE] == SareChildConstants.FCM_TYPE_UNPAIR) {
            // Silent action, not a user-visible notification — a parent just removed this
            // device. See functions/src/deviceDelete.ts and DeviceUnpairHandler.
            DeviceUnpairHandler.handleFcmUnpair(this, repo)
            return
        }
        val isFamilyChat = data[SareChildConstants.FCM_DATA_TYPE] == SareChildConstants.FCM_TYPE_FAMILY_CHAT
        val urgent = data[SareChildConstants.FCM_DATA_URGENT] == "true"

        val title = data["title"] ?: message.notification?.title ?: "SareChild"
        val body = data["body"] ?: message.notification?.body ?: "Open the app for details"

        val channelId = if (isFamilyChat && urgent) {
            SareChildConstants.NOTIFICATION_CHANNEL_CHAT_URGENT
        } else if (isFamilyChat) {
            SareChildConstants.NOTIFICATION_CHANNEL_FAMILY_CHAT
        } else {
            SareChildConstants.NOTIFICATION_CHANNEL_SAFETY
        }

        val targetActivity = if (isFamilyChat) FamilyChatActivity::class.java else MainActivity::class.java
        val intent = Intent(this, targetActivity).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (isFamilyChat) {
                putExtra(SareChildConstants.EXTRA_OPEN_CHAT, true)
            }
        }
        val pending = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(if (urgent) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pending)
            .setAutoCancel(true)

        if (urgent) {
            builder.setVibrate(longArrayOf(0, 400, 200, 400, 200, 400, 200, 400))
        } else if (isFamilyChat) {
            builder.setVibrate(longArrayOf(0, 250, 150, 250))
        }

        NotificationManagerCompat.from(this)
            .notify(SareChildConstants.CHAT_NOTIFICATION_ID, builder.build())
    }
}
