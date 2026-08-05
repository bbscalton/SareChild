package com.sarechild.child.monitoring

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.DevicePhoto
import com.sarechild.shared.PhotoGalleryAccessLevel
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.FileOutputStream

/**
 * Syncs device photo gallery metadata + thumbnails to Firestore/R2 via MediaStore queries.
 * Uses READ_MEDIA_IMAGES / READ_EXTERNAL_STORAGE — never MANAGE_EXTERNAL_STORAGE.
 * On Android 14+ partial ("Selected photos") access, only granted URIs appear in MediaStore.
 */
class PhotoGallerySync(
    private val context: Context,
    private val repo: ChildRepository
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val handlerThread = HandlerThread("sarechild-photo-sync").apply { start() }
    private val handler = Handler(handlerThread.looper)
    private val syncMutex = Mutex()
    private var observer: ContentObserver? = null

    fun start() {
        if (!repo.photoGalleryConsent) return
        registerObserver()
        scope.launch { runCatching { sync(forceFull = false) } }
    }

    fun stop() {
        observer?.let { runCatching { context.contentResolver.unregisterContentObserver(it) } }
        observer = null
        scope.cancel()
        handlerThread.quitSafely()
    }

    suspend fun sync(forceFull: Boolean) {
        if (!repo.photoGalleryConsent) return
        syncMutex.withLock {
            val access = detectAccessLevel(context)
            if (access == PhotoGalleryAccessLevel.NONE) {
                repo.updatePhotoGalleryStatus(
                    statusMap(context, repo, lastError = "Photo permission not granted")
                )
                return
            }

            val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            val projection = arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.DATE_MODIFIED,
                MediaStore.Images.Media.MIME_TYPE,
                MediaStore.Images.Media.WIDTH,
                MediaStore.Images.Media.HEIGHT
            )
            val lastModifiedSec = if (!forceFull && repo.lastPhotoModifiedMs > 0) {
                repo.lastPhotoModifiedMs / 1000L
            } else {
                0L
            }
            val selection = if (lastModifiedSec > 0) {
                "${MediaStore.Images.Media.DATE_MODIFIED} >= ?"
            } else {
                null
            }
            val selectionArgs = if (lastModifiedSec > 0) arrayOf(lastModifiedSec.toString()) else null
            val sort = "${MediaStore.Images.Media.DATE_MODIFIED} DESC"

            var processed = 0
            var maxModifiedMs = repo.lastPhotoModifiedMs
            var lastError: String? = null

            runCatching {
                context.contentResolver.query(uri, projection, selection, selectionArgs, sort)
            }.getOrNull()?.use { cursor ->
                val idIdx = cursor.getColumnIndex(MediaStore.Images.Media._ID)
                val nameIdx = cursor.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME)
                val sizeIdx = cursor.getColumnIndex(MediaStore.Images.Media.SIZE)
                val addedIdx = cursor.getColumnIndex(MediaStore.Images.Media.DATE_ADDED)
                val modIdx = cursor.getColumnIndex(MediaStore.Images.Media.DATE_MODIFIED)
                val mimeIdx = cursor.getColumnIndex(MediaStore.Images.Media.MIME_TYPE)
                val widthIdx = cursor.getColumnIndex(MediaStore.Images.Media.WIDTH)
                val heightIdx = cursor.getColumnIndex(MediaStore.Images.Media.HEIGHT)

                while (cursor.moveToNext()) {
                    if (idIdx < 0) continue
                    val mediaId = cursor.getLong(idIdx)
                    val modifiedSec = if (modIdx >= 0) cursor.getLong(modIdx) else 0L
                    val modifiedMs = modifiedSec * 1000L
                    if (modifiedMs > maxModifiedMs) maxModifiedMs = modifiedMs

                    val itemUri = ContentUris.withAppendedId(uri, mediaId)
                    val displayName = (if (nameIdx >= 0) cursor.getString(nameIdx) else null).orEmpty()
                    val sizeBytes = if (sizeIdx >= 0) cursor.getLong(sizeIdx) else 0L
                    val addedSec = if (addedIdx >= 0) cursor.getLong(addedIdx) else modifiedSec
                    val mimeType = (if (mimeIdx >= 0) cursor.getString(mimeIdx) else null)
                        ?: "image/jpeg"
                    val width = if (widthIdx >= 0) cursor.getInt(widthIdx) else 0
                    val height = if (heightIdx >= 0) cursor.getInt(heightIdx) else 0

                    runCatching {
                        val thumbFile = createThumbnail(itemUri, SareChildConstants.PHOTO_THUMB_MAX_PX)
                        if (thumbFile == null) {
                            lastError = "Could not create thumbnail for ${displayName.ifBlank { mediaId.toString() }}"
                            return@runCatching
                        }
                        val (thumbPath, thumbUrl) = repo.uploadMedia(thumbFile, "photos/thumbs", "image/jpeg")
                        thumbFile.delete()

                        val photo = DevicePhoto(
                            mediaStoreId = mediaId,
                            displayName = displayName,
                            sizeBytes = sizeBytes,
                            takenAtMs = addedSec * 1000L,
                            modifiedAtMs = modifiedMs,
                            mimeType = mimeType,
                            width = width,
                            height = height,
                            syncedAtMs = System.currentTimeMillis(),
                            thumbPath = thumbPath,
                            thumbUrl = thumbUrl
                        )
                        repo.upsertDevicePhoto(photo)
                        processed++
                    }.onFailure { e ->
                        lastError = e.message ?: "Thumbnail upload failed"
                    }
                }
            }

            if (maxModifiedMs > repo.lastPhotoModifiedMs) {
                repo.lastPhotoModifiedMs = maxModifiedMs
            }
            repo.lastPhotoSyncMs = System.currentTimeMillis()
            // Count successfully upserted docs only — MediaStore row count inflated the parent
            // badge when thumbnail/upload failed silently.
            val photoCount = when {
                forceFull -> processed.also { repo.syncedPhotoCount = it }
                processed > 0 -> (repo.syncedPhotoCount + processed).also { repo.syncedPhotoCount = it }
                else -> repo.syncedPhotoCount
            }

            repo.updatePhotoGalleryStatus(
                statusMap(context, repo, photoCount = photoCount, lastError = lastError)
            )
        }
    }

    private fun registerObserver() {
        if (observer != null) return
        var debounced = false
        observer = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                if (debounced) return
                debounced = true
                handler.postDelayed({
                    debounced = false
                    scope.launch { runCatching { sync(forceFull = false) } }
                }, 5_000L)
            }
        }
        context.contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            true,
            observer!!
        )
    }

    private fun createThumbnail(itemUri: Uri, maxPx: Int): File? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(itemUri)?.use {
            BitmapFactory.decodeStream(it, null, bounds)
        } ?: return null
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        var sample = 1
        while (bounds.outWidth / sample > maxPx * 2 || bounds.outHeight / sample > maxPx * 2) {
            sample *= 2
        }
        val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sample }
        val decoded = context.contentResolver.openInputStream(itemUri)?.use {
            BitmapFactory.decodeStream(it, null, decodeOpts)
        } ?: return null

        val scaled = scaleBitmap(decoded, maxPx)
        if (scaled !== decoded) decoded.recycle()

        val out = File(context.cacheDir, "photo_thumb_${System.currentTimeMillis()}.jpg")
        FileOutputStream(out).use { stream ->
            scaled.compress(Bitmap.CompressFormat.JPEG, 82, stream)
        }
        scaled.recycle()
        return if (out.length() > 0) out else null
    }

    private fun scaleBitmap(source: Bitmap, maxPx: Int): Bitmap {
        val w = source.width
        val h = source.height
        if (w <= maxPx && h <= maxPx) return source
        val ratio = minOf(maxPx.toFloat() / w, maxPx.toFloat() / h)
        return Bitmap.createScaledBitmap(
            source,
            (w * ratio).toInt().coerceAtLeast(1),
            (h * ratio).toInt().coerceAtLeast(1),
            true
        )
    }

    companion object {
        private const val READ_MEDIA_VISUAL_USER_SELECTED =
            "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"

        fun detectAccessLevel(context: Context): PhotoGalleryAccessLevel {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val full = hasPerm(context, Manifest.permission.READ_MEDIA_IMAGES)
                val partial = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    hasPerm(context, READ_MEDIA_VISUAL_USER_SELECTED)
                } else {
                    false
                }
                when {
                    full -> PhotoGalleryAccessLevel.FULL
                    partial -> PhotoGalleryAccessLevel.PARTIAL
                    else -> PhotoGalleryAccessLevel.NONE
                }
            } else {
                if (hasPerm(context, Manifest.permission.READ_EXTERNAL_STORAGE)) {
                    PhotoGalleryAccessLevel.FULL
                } else {
                    PhotoGalleryAccessLevel.NONE
                }
            }
        }

        fun hasPhotoPermission(context: Context): Boolean =
            detectAccessLevel(context) != PhotoGalleryAccessLevel.NONE

        private fun hasPerm(context: Context, perm: String): Boolean =
            ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED

        fun statusMap(
            context: Context,
            repo: ChildRepository,
            photoCount: Int = repo.syncedPhotoCount,
            lastError: String? = null
        ): Map<String, Any?> {
            val access = detectAccessLevel(context)
            return mapOf(
                "consent" to repo.photoGalleryConsent,
                "permissionGranted" to (access != PhotoGalleryAccessLevel.NONE),
                "accessLevel" to access.name,
                "lastSyncAtMs" to repo.lastPhotoSyncMs,
                "photoCount" to photoCount,
                "lastError" to lastError
            )
        }

        fun shouldRunPeriodicSync(repo: ChildRepository): Boolean {
            if (!repo.photoGalleryConsent) return false
            val elapsed = System.currentTimeMillis() - repo.lastPhotoSyncMs
            return elapsed >= SareChildConstants.PHOTO_SYNC_INTERVAL_MS
        }
    }
}
