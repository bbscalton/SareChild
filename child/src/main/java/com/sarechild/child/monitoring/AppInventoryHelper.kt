package com.sarechild.child.monitoring

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.InstalledApp

object AppInventoryHelper {
    /** Packages that should never appear in the parent inventory picker. */
    private val SKIP_PACKAGES = setOf(
        "android",
        "com.android.systemui",
        "com.android.providers.settings"
    )

    suspend fun sync(context: Context, repo: ChildRepository, force: Boolean = false) {
        val now = System.currentTimeMillis()
        val last = repo.lastAppInventorySyncMs
        if (!force && now - last < com.sarechild.shared.SareChildConstants.APP_INVENTORY_SYNC_INTERVAL_MS) {
            return
        }
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            PackageManager.MATCH_UNINSTALLED_PACKAGES or PackageManager.MATCH_DISABLED_COMPONENTS
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_UNINSTALLED_PACKAGES
        }
        val installed = pm.getInstalledApplications(flags)
        val entries = installed
            .asSequence()
            .filter { it.packageName !in SKIP_PACKAGES }
            .filter { shouldInclude(pm, it) }
            .mapNotNull { info -> toEntry(pm, info) }
            .sortedBy { it.name.lowercase() }
            .toList()
        repo.uploadInstalledApps(entries)
        repo.lastAppInventorySyncMs = now
    }

    private fun shouldInclude(pm: PackageManager, info: ApplicationInfo): Boolean {
        val isUserApp = (info.flags and ApplicationInfo.FLAG_SYSTEM) == 0
        if (isUserApp) return true
        val launch = pm.getLaunchIntentForPackage(info.packageName) ?: return false
        return launch.action == Intent.ACTION_MAIN
    }

    private fun toEntry(pm: PackageManager, info: ApplicationInfo): InstalledApp? {
        val pkg = info.packageName ?: return null
        val label = runCatching {
            pm.getApplicationLabel(info).toString()
        }.getOrDefault(pkg)
        val pkgInfo = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(pkg, 0)
            }
        }.getOrNull()
        val versionName = pkgInfo?.versionName.orEmpty()
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pkgInfo?.longVersionCode ?: 0L
        } else {
            @Suppress("DEPRECATION")
            (pkgInfo?.versionCode ?: 0).toLong()
        }
        val apkSize = runCatching {
            val sourceDir = info.sourceDir ?: return@runCatching 0L
            java.io.File(sourceDir).length()
        }.getOrDefault(0L)
        return InstalledApp(
            packageName = pkg,
            name = label,
            versionName = versionName,
            versionCode = versionCode,
            apkSizeBytes = apkSize,
            firstInstallTime = pkgInfo?.firstInstallTime ?: 0L,
            lastUpdateTime = pkgInfo?.lastUpdateTime ?: 0L
        )
    }
}
