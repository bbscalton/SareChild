package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityHomeBinding
import com.sarechild.child.monitoring.MonitoringForegroundService
import com.sarechild.shared.LatLngPoint
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

class HomeActivity : AppCompatActivity() {
    private lateinit var binding: ActivityHomeBinding
    private lateinit var repo: ChildRepository
    private var sending = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityHomeBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)

        binding.greeting.text = "Hi, ${repo.childName}"
        refreshAwareness()
        MonitoringForegroundService.start(this)

        binding.reviewPermissions.setOnClickListener {
            startActivity(Intent(this, PermissionsActivity::class.java))
        }
        binding.openChat.setOnClickListener {
            startActivity(Intent(this, FamilyChatActivity::class.java))
        }
        binding.sos.setOnClickListener {
            if (sending) return@setOnClickListener
            sending = true
            binding.sosStatus.text = "Sending SOS…"
            lifecycleScope.launch {
                val location = fetchLocation()
                runCatching { repo.postSos(location) }
                    .onSuccess { binding.sosStatus.text = "SOS sent to your parent" }
                    .onFailure { binding.sosStatus.text = it.message ?: "Failed to send SOS" }
                sending = false
            }
        }
        binding.checkInNow.setOnClickListener {
            lifecycleScope.launch {
                runCatching {
                    repo.postAlert(
                        FamilyAlert(
                            type = AlertType.CHECK_IN,
                            severity = AlertSeverity.LOW,
                            title = "Child checked in — ${repo.childName}",
                            snippet = "Manual check-in from child app."
                        )
                    )
                }
                binding.sosStatus.text = "Check-in sent"
            }
        }
    }

    override fun onResume() {
        super.onResume()
        repo = ChildRepository(this)
        refreshAwareness()
        if (repo.deviceLocked) {
            startActivity(
                Intent(this, DeviceLockActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                }
            )
        }
    }

    private fun refreshAwareness() {
        val enabled = buildList {
            if (repo.screenShareConsent) add("Screen share")
            if (repo.cameraCheckConsent) add("Camera")
            if (repo.micCheckConsent) add("Voice")
            if (repo.messageMonitorConsent) add("Messages")
            if (repo.installMonitorConsent) add("App installs")
            if (repo.usageConsent) add("Screen time")
            if (repo.callSmsConsent) add("Call/SMS summaries")
        }
        binding.consentSummary.text = if (enabled.isEmpty()) {
            "Advanced safety checks: not enabled"
        } else {
            "Advanced safety checks enabled: ${enabled.joinToString(", ")}"
        }

        val session = repo.activeSession
        if (!session.isNullOrBlank()) {
            binding.sessionBanner.visibility = View.VISIBLE
            binding.sessionBanner.text = when (session) {
                "screen" -> "Screen sharing is ACTIVE — your parent can see this screen"
                "camera" -> "Camera safety check is ACTIVE"
                "mic" -> "Voice safety check is ACTIVE"
                "locked" -> "Device is LOCKED by parent — Protected by SareChild"
                else -> "Safety check in progress: $session"
            }
        } else {
            binding.sessionBanner.visibility = View.GONE
        }
    }

    private suspend fun fetchLocation(): LatLngPoint? {
        val fine = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) return null
        return try {
            val fused = LocationServices.getFusedLocationProviderClient(this)
            val loc: Location? = fused.getCurrentLocation(
                Priority.PRIORITY_HIGH_ACCURACY,
                CancellationTokenSource().token
            ).await()
            loc?.let { LatLngPoint(it.latitude, it.longitude, it.accuracy) }
        } catch (_: Exception) {
            null
        }
    }
}
