package com.sarechild.child.monitoring

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.sarechild.child.data.ChildRepository

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        val repo = ChildRepository(context)
        if (repo.isPaired && repo.consentDone) {
            MonitoringForegroundService.start(context)
        }
    }
}
