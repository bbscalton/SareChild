package com.sarechild.child.monitoring

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.sarechild.child.HomeActivity
import com.sarechild.child.R
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer

class ScreenShareService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var frameJob: Job? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        repo = ChildRepository(this)
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        commandId = intent?.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            ?: Activity.RESULT_CANCELED
        @Suppress("DEPRECATION")
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }
        startAsForeground()
        if (resultCode != Activity.RESULT_OK || data == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        val mpm = getSystemService(MediaProjectionManager::class.java)
        mediaProjection = mpm.getMediaProjection(resultCode, data)
        mediaProjection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                stopSharing("Projection stopped")
            }
        }, mainHandler)
        setupVirtualDisplay()
        val durationMinutes = (
            intent?.getIntExtra(
                SareChildConstants.EXTRA_DURATION_MINUTES,
                SareChildConstants.SCREEN_SHARE_DEFAULT_MINUTES
            ) ?: SareChildConstants.SCREEN_SHARE_DEFAULT_MINUTES
        ).coerceIn(
            SareChildConstants.SCREEN_SHARE_MIN_MINUTES,
            SareChildConstants.SCREEN_SHARE_MAX_MINUTES
        )
        val maxFrames = (durationMinutes * 60_000L / SareChildConstants.SCREEN_FRAME_INTERVAL_MS).toInt()
        frameJob = scope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
            }
            repo.setActiveSessionRemote("screen")
            var uploads = 0
            while (isActive && uploads < maxFrames) {
                captureAndUpload()
                uploads++
                delay(SareChildConstants.SCREEN_FRAME_INTERVAL_MS)
            }
            stopSharing(null)
        }
        return START_STICKY
    }

    private fun setupVirtualDisplay() {
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        val width = metrics.widthPixels.coerceAtMost(720)
        val height = (metrics.heightPixels.toFloat() / metrics.widthPixels * width).toInt()
        val density = metrics.densityDpi
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "SareChildScreenShare",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface,
            null,
            mainHandler
        )
    }

    private suspend fun captureAndUpload() {
        val reader = imageReader ?: return
        val image = reader.acquireLatestImage() ?: return
        try {
            val plane = image.planes[0]
            val buffer: ByteBuffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * image.width
            val bitmap = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height,
                Bitmap.Config.ARGB_8888
            )
            bitmap.copyPixelsFromBuffer(buffer)
            val cropped = Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height)
            val file = File(cacheDir, "frame_${System.currentTimeMillis()}.jpg")
            FileOutputStream(file).use { out ->
                cropped.compress(Bitmap.CompressFormat.JPEG, 55, out)
            }
            val (_, url) = repo.uploadMedia(file, "screen", "image/jpeg")
            repo.setLatestFrameUrl(url)
            file.delete()
            cropped.recycle()
            bitmap.recycle()
        } catch (_: Exception) {
        } finally {
            image.close()
        }
    }

    private fun stopSharing(error: String?) {
        frameJob?.cancel()
        virtualDisplay?.release()
        imageReader?.close()
        mediaProjection?.stop()
        virtualDisplay = null
        imageReader = null
        mediaProjection = null
        scope.launch {
            if (error == null) {
                if (commandId.isNotBlank()) {
                    repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
                }
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.SCREEN_SHARE,
                        severity = AlertSeverity.HIGH,
                        title = "Screen share ended — ${repo.childName}",
                        snippet = "Visible screen sharing session completed",
                        commandId = commandId
                    )
                )
            } else {
                if (commandId.isNotBlank()) {
                    repo.updateCommand(commandId, SafetyCommandStatus.FAILED, error = error)
                }
            }
            repo.setActiveSessionRemote(null)
            repo.setLatestFrameUrl(null)
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startAsForeground() {
        val pending = PendingIntent.getActivity(
            this,
            0,
            Intent(this, HomeActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification: Notification = NotificationCompat.Builder(
            this,
            SareChildConstants.NOTIFICATION_CHANNEL_SAFETY
        )
            .setContentTitle("Screen sharing with parent")
            .setContentText("Protected by SareChild — screen sharing is visible and active.")
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                SareChildConstants.SCREEN_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(SareChildConstants.SCREEN_NOTIFICATION_ID, notification)
        } else {
            startForeground(SareChildConstants.SCREEN_NOTIFICATION_ID, notification)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                "Visible safety checks",
                NotificationManager.IMPORTANCE_HIGH
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        frameJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
    }
}
