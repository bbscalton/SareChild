package com.sarechild.child.monitoring

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.sarechild.child.DeviceAdminHelper
import com.sarechild.child.data.ChildRepository

/**
 * Central checks for whether a parent "request access" command can be satisfied
 * without showing the child a consent dialog again.
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

    fun hasPhotoGalleryConsent(repo: ChildRepository): Boolean = repo.photoGalleryConsent

    fun hasEventRecorderConsent(repo: ChildRepository): Boolean = repo.eventRecorderConsent

    fun hasWhatsAppConsent(repo: ChildRepository): Boolean = repo.whatsappMonitorConsent

    fun hasCallRecordingConsent(repo: ChildRepository): Boolean =
        repo.callRecordingConsent && repo.callRecordingEnabled

    private fun hasRecordAudio(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasPhoneState(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED
}
