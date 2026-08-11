package com.sarechild.child.monitoring

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.concurrent.futures.await
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.CameraSnapshot
import com.sarechild.shared.SareChildConstants
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
 * Periodic CameraX still capture — started/stopped by parent START_CAMERA_SNAPSHOTS /
 * STOP_CAMERA_SNAPSHOTS commands.
 */
object CameraSnapshotCapture {
    private const val TAG = "CameraSnapshot"

    enum class CameraMode(val wire: String) {
        FRONT("front"),
        BACK("back"),
        BOTH("both");

        companion object {
            fun fromWire(raw: String?): CameraMode = when (raw?.lowercase()) {
                "front" -> FRONT
                "back" -> BACK
                "both" -> BOTH
                else -> BACK
            }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private var expiresAtMs = 0L
    private val capturing = AtomicBoolean(false)
    @Volatile private var repo: ChildRepository? = null
    @Volatile private var appContext: Context? = null
    @Volatile private var mode: CameraMode = CameraMode.BACK

    private val lifecycleOwner = object : LifecycleOwner {
        private val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle = registry
        fun markStarted() {
            // Never DESTROYED — CameraX cannot re-bind after DESTROYED (IllegalStateException).
            if (!registry.currentState.isAtLeast(Lifecycle.State.CREATED)) {
                registry.currentState = Lifecycle.State.CREATED
            }
            if (registry.currentState == Lifecycle.State.CREATED) {
                registry.currentState = Lifecycle.State.STARTED
            }
        }
        fun markStopped() {
            if (registry.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                registry.currentState = Lifecycle.State.CREATED
            }
        }
    }

    @Volatile private var imageCapture: ImageCapture? = null
    @Volatile private var cameraProvider: ProcessCameraProvider? = null
    @Volatile private var boundFacing: Boolean? = null

    fun start(context: Context, cameras: String? = null) {
        appContext = context.applicationContext
        val repository = repo ?: ChildRepository(context).also { repo = it }
        mode = CameraMode.fromWire(cameras ?: repository.cameraSnapshotsMode)
        val wasActive = repository.cameraSnapshotsActive
        repository.cameraSnapshotsActive = true
        repository.cameraSnapshotsMode = mode.wire
        expiresAtMs = System.currentTimeMillis() + SareChildConstants.CAMERA_SNAPSHOT_MAX_DURATION_MS
        if (!wasActive) {
            scope.launch { repository.updateCameraSnapshotStatus(active = true, cameras = mode.wire) }
        }
        MonitoringForegroundService.refreshForegroundServiceType(context)
        if (loopJob?.isActive == true) return
        startLoop(repository)
    }

    fun stop(context: Context, updateRemote: Boolean = true) {
        val repository = repo ?: ChildRepository(context)
        repository.cameraSnapshotsActive = false
        loopJob?.cancel()
        loopJob = null
        capturing.set(false)
        expiresAtMs = 0L
        releaseCamera()
        if (updateRemote) {
            scope.launch { repository.updateCameraSnapshotStatus(active = false, cameras = mode.wire) }
        }
        MonitoringForegroundService.refreshForegroundServiceType(context)
    }

    private fun startLoop(repository: ChildRepository) {
        if (loopJob?.isActive == true) return
        loopJob = scope.launch {
            while (isActive && repository.cameraSnapshotsActive) {
                if (System.currentTimeMillis() > expiresAtMs) {
                    appContext?.let { stop(it, updateRemote = true) }
                    break
                }
                val ctx = appContext
                if (ctx != null) {
                    runCatching { captureCycle(ctx, repository) }
                        .onFailure { Log.e(TAG, "capture failed", it) }
                }
                delay(SareChildConstants.CAMERA_SNAPSHOT_INTERVAL_MS)
            }
        }
    }

    private suspend fun captureCycle(context: Context, repository: ChildRepository) {
        if (!capturing.compareAndSet(false, true)) return
        try {
            when (mode) {
                CameraMode.FRONT -> captureFacing(context, repository, front = true)
                CameraMode.BACK -> captureFacing(context, repository, front = false)
                CameraMode.BOTH -> {
                    captureFacing(context, repository, front = false)
                    captureFacing(context, repository, front = true)
                }
            }
        } finally {
            capturing.set(false)
        }
    }

    private suspend fun captureFacing(
        context: Context,
        repository: ChildRepository,
        front: Boolean,
    ) {
        val fullFile = File(context.cacheDir, "cam_snap_${System.currentTimeMillis()}.jpg")
        try {
            if (!captureStill(context, front, fullFile)) return
            val bitmap = BitmapFactory.decodeFile(fullFile.absolutePath) ?: return
            val width = bitmap.width
            val height = bitmap.height
            val thumbFile = File(context.cacheDir, "cam_snap_thumb_${System.currentTimeMillis()}.jpg")
            try {
                withContext(Dispatchers.IO) {
                    val thumb = scaleBitmap(bitmap, SareChildConstants.CAMERA_SNAPSHOT_THUMB_MAX_PX)
                    thumbFile.outputStream().use { out ->
                        thumb.compress(Bitmap.CompressFormat.JPEG, 80, out)
                    }
                    if (thumb !== bitmap) thumb.recycle()
                }
                val facing = if (front) "front" else "back"
                val snapshotId = repository.newCameraSnapshotId()
                val fid = repository.familyId ?: return
                val did = repository.deviceId ?: return
                val fullPath =
                    "families/$fid/devices/$did/cameraSnapshots/${snapshotId}_$facing.jpg"
                val thumbPath =
                    "families/$fid/devices/$did/cameraSnapshots/thumbs/${snapshotId}_$facing.jpg"
                val (storedFullPath, fullUrl) =
                    repository.uploadMediaAtPath(fullFile, fullPath, "image/jpeg")
                val (storedThumbPath, thumbUrl) =
                    repository.uploadMediaAtPath(thumbFile, thumbPath, "image/jpeg")
                val capturedAtMs = System.currentTimeMillis()
                repository.postCameraSnapshot(
                    CameraSnapshot(
                        id = snapshotId,
                        capturedAtMs = capturedAtMs,
                        cameraFacing = facing,
                        r2Path = storedFullPath,
                        imageUrl = fullUrl,
                        thumbPath = storedThumbPath,
                        thumbUrl = thumbUrl,
                        width = width,
                        height = height
                    )
                )
                repository.purgeOldCameraSnapshots()
            } finally {
                thumbFile.delete()
                bitmap.recycle()
            }
        } finally {
            fullFile.delete()
        }
    }

    private suspend fun captureStill(context: Context, front: Boolean, outFile: File): Boolean {
        if (!ensureCameraBound(context, front)) return false
        val capture = imageCapture ?: return false
        return suspendCancellableCoroutine { cont ->
            val metadata = ImageCapture.Metadata().apply {
                isReversedHorizontal = front
            }
            val options = ImageCapture.OutputFileOptions.Builder(outFile)
                .setMetadata(metadata)
                .build()
            capture.takePicture(
                options,
                ContextCompat.getMainExecutor(context),
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                        if (cont.isActive) cont.resume(true)
                    }

                    override fun onError(exception: ImageCaptureException) {
                        Log.w(TAG, "takePicture failed facing=${front}", exception)
                        if (cont.isActive) cont.resume(false)
                    }
                }
            )
        }
    }

    private suspend fun ensureCameraBound(context: Context, front: Boolean): Boolean {
        if (boundFacing == front && imageCapture != null) return true
        releaseCamera()
        val provider = withContext(Dispatchers.Main) {
            ProcessCameraProvider.getInstance(context).await()
        }
        cameraProvider = provider
        val selector = if (front) {
            CameraSelector.DEFAULT_FRONT_CAMERA
        } else {
            CameraSelector.DEFAULT_BACK_CAMERA
        }
        if (!provider.hasCamera(selector)) {
            Log.w(TAG, "Camera not available front=$front")
            return false
        }
        val capture = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build()
        return withContext(Dispatchers.Main) {
            runCatching {
                lifecycleOwner.markStarted()
                provider.unbindAll()
                provider.bindToLifecycle(lifecycleOwner, selector, capture)
                imageCapture = capture
                boundFacing = front
                true
            }.getOrElse {
                Log.e(TAG, "bindToLifecycle failed", it)
                false
            }
        }
    }

    private fun releaseCamera() {
        runCatching {
            cameraProvider?.unbindAll()
        }
        imageCapture = null
        cameraProvider = null
        boundFacing = null
        lifecycleOwner.markStopped()
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
