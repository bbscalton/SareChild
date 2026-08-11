package com.sarechild.child.monitoring

import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.withResumed
import kotlinx.coroutines.launch

/**
 * Builds MediaProjection consent intents that always target the full default display.
 *
 * On Android 14+ (API 34), [MediaProjectionConfig.createConfigForDefaultDisplay] skips the
 * "single app vs entire screen" chooser — the user only sees the mandatory "Start now"
 * confirmation. On older Android versions the OS may still show the legacy picker.
 */
object ScreenCaptureHelper {
    fun createFullScreenCaptureIntent(mpm: MediaProjectionManager): Intent {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            mpm.createScreenCaptureIntent(
                MediaProjectionConfig.createConfigForDefaultDisplay()
            )
        } else {
            mpm.createScreenCaptureIntent()
        }
    }

    /**
     * Launch the system MediaProjection consent dialog once the activity is RESUMED.
     * Launching from [ComponentActivity.onCreate] before resume is unreliable on many
     * devices and leaves the child stuck on the gate screen without the system prompt.
     */
    fun launchFullScreenCaptureWhenReady(
        activity: ComponentActivity,
        launcher: ActivityResultLauncher<Intent>,
        onAlreadyLaunched: () -> Unit = {},
    ) {
        activity.lifecycleScope.launch {
            activity.lifecycle.withResumed {
                val mpm = activity.getSystemService(MediaProjectionManager::class.java) ?: return@withResumed
                onAlreadyLaunched()
                launcher.launch(createFullScreenCaptureIntent(mpm))
            }
        }
    }
}
