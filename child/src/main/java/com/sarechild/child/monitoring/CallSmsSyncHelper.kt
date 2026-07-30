package com.sarechild.child.monitoring

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.os.Build
import android.provider.CallLog
import android.provider.Telephony
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.sarechild.child.R
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.CallSmsPreview
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants

object CallSmsSyncHelper {
    suspend fun sync(context: Context, repo: ChildRepository, commandId: String?) {
        if (!repo.callSmsConsent) {
            if (!commandId.isNullOrBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.FAILED, error = "No call/SMS consent")
            }
            return
        }
        ensureNotification(context)
        val items = mutableListOf<CallSmsPreview>()
        if (hasPerm(context, Manifest.permission.READ_CALL_LOG)) {
            items += readCalls(context)
        }
        if (hasPerm(context, Manifest.permission.READ_SMS)) {
            items += readSms(context)
        }
        repo.uploadCallSmsPreviews(items.take(SareChildConstants.CALL_SMS_SYNC_LIMIT))
        if (!commandId.isNullOrBlank()) {
            repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
        }
    }

    private fun hasPerm(context: Context, perm: String) =
        ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED

    private fun maskAddress(raw: String?): String {
        val s = raw?.filter { it.isDigit() || it == '+' }.orEmpty()
        if (s.length <= 4) return "****"
        return "*".repeat(s.length - 4) + s.takeLast(4)
    }

    private fun readCalls(context: Context): List<CallSmsPreview> {
        val out = mutableListOf<CallSmsPreview>()
        val cursor: Cursor? = context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
            null,
            null,
            "${CallLog.Calls.DATE} DESC"
        )
        cursor?.use {
            var n = 0
            while (it.moveToNext() && n < 20) {
                val number = it.getString(0)
                val type = when (it.getInt(1)) {
                    CallLog.Calls.INCOMING_TYPE -> "IN"
                    CallLog.Calls.OUTGOING_TYPE -> "OUT"
                    CallLog.Calls.MISSED_TYPE -> "MISSED"
                    else -> "OTHER"
                }
                val date = it.getLong(2)
                val duration = it.getLong(3)
                out += CallSmsPreview(
                    kind = "CALL",
                    direction = type,
                    addressMasked = maskAddress(number),
                    snippet = "Duration ${duration}s",
                    atMs = date
                )
                n++
            }
        }
        return out
    }

    private fun readSms(context: Context): List<CallSmsPreview> {
        val out = mutableListOf<CallSmsPreview>()
        val cursor: Cursor? = context.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
            null,
            null,
            "${Telephony.Sms.DATE} DESC"
        )
        cursor?.use {
            var n = 0
            while (it.moveToNext() && n < 20) {
                val address = it.getString(0)
                val body = it.getString(1).orEmpty()
                val date = it.getLong(2)
                val type = when (it.getInt(3)) {
                    Telephony.Sms.MESSAGE_TYPE_INBOX -> "IN"
                    Telephony.Sms.MESSAGE_TYPE_SENT -> "OUT"
                    else -> "OTHER"
                }
                val snippet = body.take(SareChildConstants.SMS_SNIPPET_MAX)
                out += CallSmsPreview(
                    kind = "SMS",
                    direction = type,
                    addressMasked = maskAddress(address),
                    snippet = snippet,
                    atMs = date
                )
                n++
            }
        }
        return out
    }

    private fun ensureNotification(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                    "Visible safety checks",
                    NotificationManager.IMPORTANCE_LOW
                )
            )
        }
        val n = NotificationCompat.Builder(context, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Call & SMS monitoring on")
            .setContentText("Protected by SareChild — syncing short summaries (not full archives)")
            .setOngoing(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.CALL_SMS_NOTIFICATION_ID, n)
    }
}
