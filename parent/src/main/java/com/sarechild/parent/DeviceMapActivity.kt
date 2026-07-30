package com.sarechild.parent

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.GoogleMap
import com.google.android.gms.maps.OnMapReadyCallback
import com.google.android.gms.maps.SupportMapFragment
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MarkerOptions
import com.google.android.gms.maps.model.PolylineOptions
import com.sarechild.parent.databinding.ActivityDeviceMapBinding
import com.sarechild.parent.geo.GoogleGeoApi
import kotlinx.coroutines.launch

class DeviceMapActivity : AppCompatActivity(), OnMapReadyCallback {
    private lateinit var binding: ActivityDeviceMapBinding
    private var childName: String = "Child"
    private var lat: Double = 0.0
    private var lng: Double = 0.0
    private var trail: List<LatLng> = emptyList()
    private var map: GoogleMap? = null
    private var snappedTrailDrawn = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDeviceMapBinding.inflate(layoutInflater)
        setContentView(binding.root)

        childName = intent.getStringExtra(EXTRA_CHILD_NAME) ?: "Child"
        lat = intent.getDoubleExtra(EXTRA_LAT, 0.0)
        lng = intent.getDoubleExtra(EXTRA_LNG, 0.0)
        val trailLats = intent.getDoubleArrayExtra(EXTRA_TRAIL_LATS) ?: doubleArrayOf()
        val trailLngs = intent.getDoubleArrayExtra(EXTRA_TRAIL_LNGS) ?: doubleArrayOf()
        trail = trailLats.indices.mapNotNull { i ->
            val la = trailLats.getOrNull(i) ?: return@mapNotNull null
            val ln = trailLngs.getOrNull(i) ?: return@mapNotNull null
            LatLng(la, ln)
        }

        binding.toolbar.title = "$childName location"
        binding.toolbar.setNavigationOnClickListener { finish() }
        updateMeta(address = null, nearby = null)

        val mapFragment = supportFragmentManager.findFragmentById(R.id.map) as SupportMapFragment
        mapFragment.getMapAsync(this)

        // Reverse geocode + nearby-place context (Geocoding / Places APIs) — best-effort,
        // falls back silently to raw coordinates if offline or the lookup fails.
        lifecycleScope.launch {
            val address = GoogleGeoApi.reverseGeocode(this@DeviceMapActivity, lat, lng)
            val nearby = GoogleGeoApi.nearbyPlaceLabel(this@DeviceMapActivity, lat, lng)
            updateMeta(address, nearby)
        }
    }

    private fun updateMeta(address: String?, nearby: String?) {
        binding.mapMeta.text = buildString {
            append(address ?: "Latest: ${"%.5f".format(lat)}, ${"%.5f".format(lng)}")
            if (nearby != null) append(" · near $nearby")
            if (trail.isNotEmpty()) append(" · ${trail.size} recent points")
        }
    }

    override fun onMapReady(googleMap: GoogleMap) {
        map = googleMap
        val current = LatLng(lat, lng)
        googleMap.uiSettings.isZoomControlsEnabled = true
        googleMap.addMarker(
            MarkerOptions()
                .position(current)
                .title(childName)
                .snippet("Latest known location"),
        )
        if (trail.size >= 2) {
            // Faint raw-GPS line first; replaced visually by the road-snapped line below
            // once the Roads API responds (falls back to staying visible if offline).
            val rawPolyline = googleMap.addPolyline(
                PolylineOptions().addAll(trail).width(6f).color(0x550F6B4C),
            )
            trail.forEachIndexed { index, point ->
                if (index == 0 || index == trail.lastIndex) return@forEachIndexed
                googleMap.addMarker(
                    MarkerOptions()
                        .position(point)
                        .title("Trail point ${index + 1}"),
                )
            }
            val bounds = LatLngBounds.builder()
            trail.forEach { bounds.include(it) }
            bounds.include(current)
            googleMap.moveCamera(CameraUpdateFactory.newLatLngBounds(bounds.build(), 96))

            // Snap the raw GPS trail to actual roads (Roads API) for a cleaner, more
            // accurate line, then draw it on top in solid color.
            lifecycleScope.launch {
                val snapped = GoogleGeoApi.snapToRoads(this@DeviceMapActivity, trail)
                if (snapped.size >= 2 && !snappedTrailDrawn) {
                    snappedTrailDrawn = true
                    rawPolyline.remove()
                    drawTrail(snapped)
                }
            }
        } else {
            googleMap.moveCamera(CameraUpdateFactory.newLatLngZoom(current, 15f))
        }
    }

    private fun drawTrail(points: List<LatLng>, color: Int = 0xFF0F6B4C.toInt()) {
        map?.addPolyline(
            PolylineOptions()
                .addAll(points)
                .width(8f)
                .color(color),
        )
    }

    companion object {
        const val EXTRA_CHILD_NAME = "child_name"
        const val EXTRA_LAT = "lat"
        const val EXTRA_LNG = "lng"
        const val EXTRA_TRAIL_LATS = "trail_lats"
        const val EXTRA_TRAIL_LNGS = "trail_lngs"
    }
}
