package com.sarechild.parent.geo

import com.google.android.gms.maps.model.LatLng
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** A place the device stayed within [StopDetector.detectStops]'s radius for at least its minimum dwell time. */
data class TrailStop(
    val position: LatLng,
    val startMs: Long,
    val endMs: Long,
    val sampleCount: Int,
) {
    val durationMs: Long get() = endMs - startMs
}

/**
 * Client-side "stayed in one place" detection for the on-device (Maps SDK) trail
 * view — a Kotlin port of parent-web's `lib/geo.ts` `detectStops()` so both
 * surfaces group nearby GPS fixes into stops the same way.
 */
object StopDetector {
    private const val EARTH_RADIUS_M = 6_371_000.0

    fun haversineMeters(a: LatLng, b: LatLng): Double {
        val dLat = Math.toRadians(b.latitude - a.latitude)
        val dLng = Math.toRadians(b.longitude - a.longitude)
        val lat1 = Math.toRadians(a.latitude)
        val lat2 = Math.toRadians(b.latitude)
        val h = sin(dLat / 2).pow(2) + cos(lat1) * cos(lat2) * sin(dLng / 2).pow(2)
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(h)))
    }

    /**
     * [points] must already be sorted ascending by timestamp. Default radius (70m)
     * and minimum dwell (5 minutes) match the web control center's defaults.
     */
    fun detectStops(
        points: List<Pair<LatLng, Long>>,
        radiusM: Double = 70.0,
        minDurationMs: Long = 5 * 60_000L,
    ): List<TrailStop> {
        if (points.isEmpty()) return emptyList()
        val stops = mutableListOf<TrailStop>()
        var cluster = mutableListOf(points[0])
        var centroidLat = points[0].first.latitude
        var centroidLng = points[0].first.longitude

        fun finalizeCluster() {
            if (cluster.isEmpty()) return
            val startMs = cluster.first().second
            val endMs = cluster.last().second
            if (endMs - startMs >= minDurationMs) {
                stops += TrailStop(LatLng(centroidLat, centroidLng), startMs, endMs, cluster.size)
            }
        }

        for (i in 1 until points.size) {
            val pos = points[i].first
            val dist = haversineMeters(LatLng(centroidLat, centroidLng), pos)
            if (dist <= radiusM) {
                cluster.add(points[i])
                val n = cluster.size
                centroidLat += (pos.latitude - centroidLat) / n
                centroidLng += (pos.longitude - centroidLng) / n
            } else {
                finalizeCluster()
                cluster = mutableListOf(points[i])
                centroidLat = pos.latitude
                centroidLng = pos.longitude
            }
        }
        finalizeCluster()
        return stops
    }

    /** "2h 14m" / "14m" / "38s" — mirrors parent-web's `formatDuration()`. */
    fun formatDuration(ms: Long): String {
        if (ms <= 0) return "0m"
        val totalMinutes = ms / 60_000L
        if (totalMinutes < 1) return "${ms / 1000}s"
        val hours = totalMinutes / 60
        val minutes = totalMinutes % 60
        return when {
            hours == 0L -> "${minutes}m"
            minutes == 0L -> "${hours}h"
            else -> "${hours}h ${minutes}m"
        }
    }
}
