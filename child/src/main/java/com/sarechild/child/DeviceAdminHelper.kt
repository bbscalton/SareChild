package com.sarechild.child

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/** Device Administrator helpers for parent-initiated system lock screen (lockNow). */
object DeviceAdminHelper {
    fun adminComponent(context: Context): ComponentName =
        ComponentName(context, SareChildDeviceAdminReceiver::class.java)

    fun isAdminActive(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isAdminActive(adminComponent(context))
    }

    fun lockNow(context: Context): Result<Unit> {
        if (!isAdminActive(context)) {
            return Result.failure(IllegalStateException("Device Administrator is not enabled"))
        }
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        dpm.lockNow()
        return Result.success(Unit)
    }

    fun createEnableAdminIntent(context: Context): Intent =
        Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
            putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComponent(context))
            putExtra(
                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "SareChild needs Device Administrator so your parent can remotely lock this phone " +
                    "to its normal lock screen (PIN, pattern, or fingerprint). " +
                    "This does not change your lock method — it only lets a trusted parent trigger it."
            )
        }
}
