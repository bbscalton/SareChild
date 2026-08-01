package com.sarechild.child

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.monitoring.MonitoringForegroundService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** Device Administrator receiver — enables parent remote lock via lockNow(). */
class SareChildDeviceAdminReceiver : DeviceAdminReceiver() {
    private val scope = CoroutineScope(Dispatchers.IO)

    override fun onEnabled(context: Context, intent: Intent) {
        syncStatus(context)
    }

    override fun onDisabled(context: Context, intent: Intent) {
        syncStatus(context)
    }

    private fun syncStatus(context: Context) {
        val repo = ChildRepository(context)
        if (!repo.isPaired) return
        scope.launch {
            runCatching { repo.updateLockScreenStatus(context) }
        }
        MonitoringForegroundService.start(context)
    }
}
