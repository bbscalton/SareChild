package com.sarechild.parent.geo

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.gms.maps.model.LatLng
import com.sarechild.parent.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Thin wrapper around the Google Geocoding, Places (Nearby Search), and Roads
 * REST APIs. Calls run on [Dispatchers.IO] and fail soft (return null / empty)
 * so a flaky network never blocks the map UI. The restricted "SareChild Parent
 * Maps (Android)" API key only authorizes these three services for this
 * package + signing certificate, so every request carries the Android
 * attribution headers Google requires for Android-restricted keys.
 */
object GoogleGeoApi {
    private const val TIMEOUT_MS = 6_000

    /** Reverse-geocodes a lat/lng into a short human-readable address via the Geocoding API. */
    suspend fun reverseGeocode(context: Context, lat: Double, lng: Double): String? =
        withContext(Dispatchers.IO) {
            try {
                val url = URL(
                    "https://maps.googleapis.com/maps/api/geocode/json" +
                        "?latlng=$lat,$lng&key=${BuildConfig.MAPS_API_KEY}",
                )
                val body = get(context, url) ?: return@withContext null
                val results = JSONObject(body).optJSONArray("results") ?: return@withContext null
                if (results.length() == 0) return@withContext null
                results.getJSONObject(0).optString("formatted_address").takeIf { it.isNotBlank() }
            } catch (_: Exception) {
                null
            }
        }

    /** Returns a short "near X" label for the closest notable place, via Places Nearby Search. */
    suspend fun nearbyPlaceLabel(context: Context, lat: Double, lng: Double): String? =
        withContext(Dispatchers.IO) {
            try {
                val url = URL(
                    "https://maps.googleapis.com/maps/api/place/nearbysearch/json" +
                        "?location=$lat,$lng&rankby=distance&key=${BuildConfig.MAPS_API_KEY}",
                )
                val body = get(context, url) ?: return@withContext null
                val results = JSONObject(body).optJSONArray("results") ?: return@withContext null
                if (results.length() == 0) return@withContext null
                results.getJSONObject(0).optString("name").takeIf { it.isNotBlank() }
            } catch (_: Exception) {
                null
            }
        }

    /**
     * Snaps a raw GPS trail to the nearest road segments via the Roads API so the
     * parent map polyline reflects the actual route instead of noisy GPS jitter.
     * Falls back to the original points on any failure (offline, quota, <2 points).
     */
    suspend fun snapToRoads(context: Context, points: List<LatLng>): List<LatLng> =
        withContext(Dispatchers.IO) {
            if (points.size < 2) return@withContext points
            try {
                val path = points.joinToString("|") { "${it.latitude},${it.longitude}" }
                val url = URL(
                    "https://roads.googleapis.com/v1/snapToRoads" +
                        "?path=$path&interpolate=true&key=${BuildConfig.MAPS_API_KEY}",
                )
                val body = get(context, url) ?: return@withContext points
                val snapped = JSONObject(body).optJSONArray("snappedPoints") ?: return@withContext points
                if (snapped.length() < 2) return@withContext points
                (0 until snapped.length()).map { i ->
                    val loc = snapped.getJSONObject(i).getJSONObject("location")
                    LatLng(loc.getDouble("latitude"), loc.getDouble("longitude"))
                }
            } catch (_: Exception) {
                points
            }
        }

    private fun get(context: Context, url: URL): String? {
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("X-Android-Package", context.packageName)
            androidCertSha1(context)?.let { setRequestProperty("X-Android-Cert", it) }
        }
        return try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) return null
            conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    /** Signing-certificate SHA-1 (hex, no colons) required by Android-restricted API keys. */
    private fun androidCertSha1(context: Context): String? {
        return try {
            val signatureBytes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                @Suppress("DEPRECATION")
                val info = context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.GET_SIGNING_CERTIFICATES,
                )
                val signingInfo = info.signingInfo
                (signingInfo?.apkContentsSigners ?: signingInfo?.signingCertificateHistory)
                    ?.firstOrNull()?.toByteArray()
            } else {
                @Suppress("DEPRECATION")
                val info = context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.GET_SIGNATURES,
                )
                @Suppress("DEPRECATION")
                info.signatures?.firstOrNull()?.toByteArray()
            }
            if (signatureBytes == null) {
                null
            } else {
                MessageDigest.getInstance("SHA-1").digest(signatureBytes).joinToString("") { "%02X".format(it) }
            }
        } catch (_: Exception) {
            null
        }
    }
}
