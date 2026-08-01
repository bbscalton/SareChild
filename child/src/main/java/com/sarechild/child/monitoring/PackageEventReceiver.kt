package com.sarechild.child.monitoring

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import com.sarechild.child.data.ChildRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class PackageEventReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val installed = action == Intent.ACTION_PACKAGE_ADDED
        val uninstalled = action == Intent.ACTION_PACKAGE_REMOVED
        if (!installed && !uninstalled) return
        if (intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return
        val pkg = intent.data?.schemeSpecificPart ?: return
        if (pkg == context.packageName) return
        val repo = ChildRepository(context)
        if (!repo.installMonitorConsent || !repo.isPaired) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val label = runCatching {
                    val ai = context.packageManager.getApplicationInfo(pkg, 0)
                    context.packageManager.getApplicationLabel(ai).toString()
                }.getOrDefault(pkg)
                repo.postAppEvent(installed, pkg, label)
                if (installed) {
                    AppInventoryHelper.sync(context, repo, force = true)
                }
            } catch (_: PackageManager.NameNotFoundException) {
                repo.postAppEvent(installed, pkg, pkg)
            } finally {
                pending.finish()
            }
        }
    }
}
