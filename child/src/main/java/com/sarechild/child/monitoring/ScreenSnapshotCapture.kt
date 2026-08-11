package com.sarechild.child.monitoring

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.os.Build
import android.util.Log
import android.view.Display
import androidx.annotation.RequiresApi
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.SareChildConstants
import com.sarechild.shared.ScreenSnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Periodic accessibility [AccessibilityService.takeScreenshot] capture — no MediaProjection.
 * Started/stopped by parent START_SCREEN_SNAPSHOTS / STOP_SCREEN_SNAPSHOTS commands.
 */
object ScreenSnapshotCapture {
    private const val TAG = "ScreenSnapshot"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private var expiresAtMs = 0L
    private val capturing = AtomicBoolean(false)
    @Volatile private var service: AccessibilityService? = null
    @Volatile private var repo: ChildRepository? = null
    @Volatile private var foregroundPackage: String? = null
    @Volatile private var foregroundLabel: String? = null
    @Volatile private var appContext: android.content.Context? = null

    fun onServiceReady(accessibilityService: AccessibilityService, repository: ChildRepository) {
        service = accessibilityService
        repo = repository
        if (repository.screenSnapshotsActive) {
            startLoop(repository)
        }
    }

    fun onServiceGone() {
        service = null
    }

    fun updateForegroundApp(packageName: String?, appLabel: String?) {
        if (!packageName.isNullOrBlank()) {
            foregroundPackage = packageName
            foregroundLabel = appLabel
        }
    }

    fun start(context: android.content.Context) {
        appContext = context.applicationContext
        val repository = repo ?: ChildRepository(context).also { repo = it }
        val wasActive = repository.screenSnapshotsActive
        repository.screenSnapshotsActive = true
        expiresAtMs = System.currentTimeMillis() + SareChildConstants.SCREEN_SNAPSHOT_MAX_DURATION_MS
        if (!wasActive) {
            scope.launch { repository.updateScreenSnapshotStatus(active = true) }
        }
        if (loopJob?.isActive == true) return
        val svc = service
        if (svc != null) {
            startLoop(repository)
        } else {
            Log.w(TAG, "Accessibility service not connected — snapshots armed, waiting for service")
        }
    }

    fun stop(context: android.content.Context, updateRemote: Boolean = true) {
        val repository = repo ?: ChildRepository(context)
        repository.screenSnapshotsActive = false
        loopJob?.cancel()
        loopJob = null
        capturing.set(false)
        expiresAtMs = 0L
        if (updateRemote) {
            scope.launch { repository.updateScreenSnapshotStatus(active = false) }
        }
    }

    private fun startLoop(repository: ChildRepository) {
        if (loopJob?.isActive == true) return
        loopJob = scope.launch {
            while (isActive && repository.screenSnapshotsActive) {
                if (System.currentTimeMillis() > expiresAtMs) {
                    appContext?.let { stop(it, updateRemote = true) }
                    break
                }
                val svc = service
                if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    runCatching { captureOnce(svc, repository) }
                        .onFailure { Log.e(TAG, "capture failed", it) }
                }
                delay(SareChildConstants.SCREEN_SNAPSHOT_INTERVAL_MS)
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun captureOnce(svc: AccessibilityService, repository: ChildRepository) {
        if (!capturing.compareAndSet(false, true)) return
        try {
            val hardwareBitmap = takeScreenshotBitmap(svc) ?: return
            val bitmap = toSoftwareBitmap(hardwareBitmap) ?: return
            val width = bitmap.width
            val height = bitmap.height
            val fullFile = File(svc.cacheDir, "screen_snap_${System.currentTimeMillis()}.jpg")
            val thumbFile = File(svc.cacheDir, "screen_snap_thumb_${System.currentTimeMillis()}.jpg")
            try {
                withContext(Dispatchers.IO) {
                    fullFile.outputStream().use { out ->
                        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
                    }
                    val thumb = scaleBitmap(bitmap, SareChildConstants.SCREEN_SNAPSHOT_THUMB_MAX_PX)
                    thumbFile.outputStream().use { out ->
                        thumb.compress(Bitmap.CompressFormat.JPEG, 80, out)
                    }
                    if (thumb !== bitmap) thumb.recycle()
                }
                val (fullPath, fullUrl) = repository.uploadMedia(fullFile, "screenSnapshots", "image/jpeg")
                val (thumbPath, thumbUrl) = repository.uploadMedia(thumbFile, "screenSnapshots/thumbs", "image/jpeg")
                val capturedAtMs = System.currentTimeMillis()
                repository.postScreenSnapshot(
                    ScreenSnapshot(
                        capturedAtMs = capturedAtMs,
                        appPackage = foregroundPackage,
                        appLabel = foregroundLabel,
                        r2Path = fullPath,
                        imageUrl = fullUrl,
                        thumbPath = thumbPath,
                        thumbUrl = thumbUrl,
                        width = width,
                        height = height
                    )
                )
                repository.purgeOldScreenSnapshots()
            } finally {
                fullFile.delete()
                thumbFile.delete()
                bitmap.recycle()
            }
        } finally {
            capturing.set(false)
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun takeScreenshotBitmap(service: AccessibilityService): Bitmap? =
        suspendCancellableCoroutine { cont ->
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                service.mainExecutor,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                        val buffer = result.hardwareBuffer
                        val colorSpace: ColorSpace? = result.colorSpace
                        val bitmap = Bitmap.wrapHardwareBuffer(buffer, colorSpace)
                        buffer.close()
                        if (bitmap == null) {
                            Log.w(TAG, "takeScreenshot returned null bitmap")
                        }
                        if (cont.isActive) cont.resume(bitmap)
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.w(TAG, "takeScreenshot failed errorCode=$errorCode")
                        if (cont.isActive) cont.resume(null)
                    }
                }
            )
        }

    /** [AccessibilityService.takeScreenshot] returns a hardware bitmap that cannot be JPEG-compressed. */
    private fun toSoftwareBitmap(bitmap: Bitmap?): Bitmap? {
        if (bitmap == null) return null
        if (bitmap.config != Bitmap.Config.HARDWARE) return bitmap
        return bitmap.copy(Bitmap.Config.ARGB_8888, false).also { bitmap.recycle() }
    }

    private fun scaleBitmap(source: Bitmap, maxPx: Int): Bitmap {
        val w = source.width
        val h = source.height
        if (w <= maxPx && h <= maxPx) return source
        val scale = minOf(maxPx.toFloat() / w, maxPx.toFloat() / h)
        val nw = (w * scale).toInt().coerceAtLeast(1)
        val nh = (h * scale).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(source, nw, nh, true)
    }
}
