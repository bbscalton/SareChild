package com.sarechild.child.monitoring

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import com.sarechild.child.DeviceAdminHelper
import com.sarechild.child.data.ChildRepository

/**
 * Single source of truth for whether a capability is already fully usable —
 * consent (where this app tracks its own) plus whatever OS-level permission
 * or system access it depends on. The Enable Protections page (PermissionsActivity)
 * and every command handler in CommandListener both read from here so a
 * capability that is already granted is NEVER re-asked, and nothing but this
 * page ever needs to show a "please allow" UI of its own.
 */
object FeatureAccessGate {

    fun isDeviceAdminReady(context: Context): Boolean =
        DeviceAdminHelper.isAdminActive(context)

    fun isPhotoGalleryReady(context: Context, repo: ChildRepository): Boolean =
        repo.photoGalleryConsent && PhotoGallerySync.hasPhotoPermission(context)

    fun isEventRecorderReady(context: Context, repo: ChildRepository): Boolean =
        repo.eventRecorderConsent && UsageMonitorHelper.hasUsageAccess(context)

    fun isWhatsAppProtectionReady(context: Context, repo: ChildRepository): Boolean =
        repo.whatsappMonitorConsent && NotificationMonitorService.isEnabled(context)

    fun isCallRecordingReady(context: Context, repo: ChildRepository): Boolean =
        repo.callRecordingConsent &&
            repo.callRecordingEnabled &&
            hasRecordAudio(context) &&
            hasPhoneState(context) &&
            NotificationMonitorService.isEnabled(context)

    fun isScreenShareReady(repo: ChildRepository): Boolean = repo.screenShareConsent

    fun isCameraCheckReady(context: Context, repo: ChildRepository): Boolean =
        repo.cameraCheckConsent && hasCamera(context)

    fun isMicCheckReady(context: Context, repo: ChildRepository): Boolean =
        repo.micCheckConsent && hasRecordAudio(context)

    /** Live viewing readiness for whichever combination of video/audio/screen the parent asked for. */
    fun isLiveViewReady(
        context: Context,
        repo: ChildRepository,
        video: Boolean,
        audio: Boolean,
        screen: Boolean
    ): Boolean {
        if (screen && !isScreenShareReady(repo)) return false
        if (video && !screen && !isCameraCheckReady(context, repo)) return false
        if (audio && !isMicCheckReady(context, repo)) return false
        return true
    }

    fun isCallSmsReady(context: Context, repo: ChildRepository): Boolean =
        repo.callSmsConsent &&
            hasPerm(context, Manifest.permission.READ_CALL_LOG) &&
            hasPerm(context, Manifest.permission.READ_SMS)

    fun isTypingSafetyReady(context: Context, repo: ChildRepository): Boolean =
        repo.messageMonitorConsent && MessageMonitorAccessibilityService.isServiceEnabled(context)

    fun isUsageAccessReady(context: Context, repo: ChildRepository): Boolean =
        repo.usageConsent && UsageMonitorHelper.hasUsageAccess(context)

    fun isNotificationAccessReady(context: Context): Boolean =
        NotificationMonitorService.isEnabled(context)

    fun isPushNotificationReady(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            hasPerm(context, Manifest.permission.POST_NOTIFICATIONS)

    fun isLocationReady(context: Context): Boolean =
        hasPerm(context, Manifest.permission.ACCESS_FINE_LOCATION) ||
            hasPerm(context, Manifest.permission.ACCESS_COARSE_LOCATION)

    fun isBatteryOptimizationReady(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return pm?.isIgnoringBatteryOptimizations(context.packageName) == true
    }

    fun hasPhotoGalleryConsent(repo: ChildRepository): Boolean = repo.photoGalleryConsent

    fun hasEventRecorderConsent(repo: ChildRepository): Boolean = repo.eventRecorderConsent

    fun hasWhatsAppConsent(repo: ChildRepository): Boolean = repo.whatsappMonitorConsent

    fun hasCallRecordingConsent(repo: ChildRepository): Boolean =
        repo.callRecordingConsent && repo.callRecordingEnabled

    private fun hasCamera(context: Context): Boolean = hasPerm(context, Manifest.permission.CAMERA)

    private fun hasRecordAudio(context: Context): Boolean =
        hasPerm(context, Manifest.permission.RECORD_AUDIO)

    private fun hasPhoneState(context: Context): Boolean =
        hasPerm(context, Manifest.permission.READ_PHONE_STATE)

    private fun hasPerm(context: Context, perm: String): Boolean =
        ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
}
