package com.sarechild.child

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityPhotoGalleryRequestBinding
import com.sarechild.child.monitoring.FeatureAccessGate
import com.sarechild.child.monitoring.MonitoringForegroundService
import com.sarechild.child.monitoring.PhotoGallerySync
import com.sarechild.shared.PhotoGalleryAccessLevel
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Visible child Accept surface for a parent's "Request photo access" command.
 * Sets consent, requests MediaStore permissions, then starts gallery sync.
 */
class PhotoGalleryRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivityPhotoGalleryRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var accepted = false

    private val requestMedia = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refreshPermissionStatus() }

    private val requestMediaMultiple = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { refreshPermissionStatus() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPhotoGalleryRequestBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()

        if (FeatureAccessGate.isPhotoGalleryReady(this, repo)) {
            silentlyCompleteAndFinish()
            return
        }

        binding.body.text =
            "Your parent asked to view photo thumbnails from this phone's gallery. " +
                "You'll need to grant photo library access in the next step. " +
                "On Android 14+, tap Allow all photos for the full gallery."

        binding.btnMedia.setOnClickListener { requestPhotoPermissions() }
        binding.btnDone.setOnClickListener { finish() }
        binding.accept.setOnClickListener { accept() }
        binding.decline.setOnClickListener { decline("Declined by child") }

        binding.countdownSection.visibility = View.GONE

        if (FeatureAccessGate.hasPhotoGalleryConsent(repo)) {
            showPermissionsOnly()
        }
    }

    override fun onResume() {
        super.onResume()
        if (accepted) refreshPermissionStatus()
    }

    private fun silentlyCompleteAndFinish() {
        MonitoringForegroundService.start(this)
        lifecycleScope.launch {
            runCatching {
                PhotoGallerySync(this@PhotoGalleryRequestActivity, repo).sync(forceFull = true)
            }
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
            }
        }
        finish()
    }

    private fun showPermissionsOnly() {
        accepted = true
        binding.consentCard.visibility = View.GONE
        binding.accept.visibility = View.GONE
        binding.decline.visibility = View.GONE
        binding.permissionsCard.visibility = View.VISIBLE
        MonitoringForegroundService.start(this)
        refreshPermissionStatus()
    }

    private fun accept() {
        if (accepted) return
        accepted = true
        binding.consentCard.visibility = View.GONE
        binding.accept.visibility = View.GONE
        binding.decline.visibility = View.GONE
        binding.permissionsCard.visibility = View.VISIBLE

        repo.photoGalleryConsent = true
        lifecycleScope.launch {
            runCatching { repo.syncConsentFlags() }
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.ACCEPTED)
            }
        }
        MonitoringForegroundService.start(this)
        requestPhotoPermissions()
        refreshPermissionStatus()
    }

    private fun decline(reason: String) {
        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.DECLINED, error = reason)
            }
        }
        finish()
    }

    private fun requestPhotoPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestMedia.launch(Manifest.permission.READ_MEDIA_IMAGES)
        } else {
            requestMediaMultiple.launch(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE))
        }
    }

    private fun refreshPermissionStatus() {
        val access = PhotoGallerySync.detectAccessLevel(this)
        val granted = access != PhotoGalleryAccessLevel.NONE

        binding.statusMedia.text = when (access) {
            PhotoGalleryAccessLevel.FULL -> "Photo access: full library granted"
            PhotoGalleryAccessLevel.PARTIAL -> "Photo access: selected photos only (partial)"
            PhotoGalleryAccessLevel.NONE -> "Photo access: required — tap below and grant access"
        }

        if (access == PhotoGalleryAccessLevel.PARTIAL) {
            binding.statusPartial.visibility = View.VISIBLE
            binding.statusPartial.text =
                "Parent will only see photos you selected. Tap Grant again and choose Allow all photos for full access."
        } else {
            binding.statusPartial.visibility = View.GONE
        }

        if (granted && repo.photoGalleryConsent) {
            lifecycleScope.launch {
                runCatching {
                    PhotoGallerySync(this@PhotoGalleryRequestActivity, repo).sync(forceFull = true)
                    if (commandId.isNotBlank()) {
                        repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
                    }
                }
            }
        }
    }
}
