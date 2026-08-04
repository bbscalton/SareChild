package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityWhatsappProtectionRequestBinding
import com.sarechild.child.monitoring.FeatureAccessGate
import com.sarechild.child.monitoring.MonitoringForegroundService
import com.sarechild.child.monitoring.NotificationMonitorService
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Visible child Accept surface for a parent's "Request WhatsApp protection" command.
 * Sets consent, syncs Firestore, then deep-links to notification access, accessibility,
 * and media permissions.
 */
class WhatsAppProtectionRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivityWhatsappProtectionRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var accepted = false

    private val requestMedia = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { refreshPermissionStatus() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityWhatsappProtectionRequestBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()

        if (FeatureAccessGate.isWhatsAppProtectionReady(this, repo)) {
            silentlyCompleteAndFinish()
            return
        }

        binding.body.text =
            "Your parent asked to monitor WhatsApp messages, calls, and media from unknown contacts. " +
                "You'll need to enable notification access and accessibility in Android settings " +
                "(SareChild never reads WhatsApp's encrypted chat database)."

        binding.btnNotifAccess.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        binding.btnAccessibility.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        binding.btnMedia.setOnClickListener { requestMediaPermissions() }
        binding.btnDone.setOnClickListener { finish() }
        binding.accept.setOnClickListener { accept() }
        binding.decline.setOnClickListener { decline("Declined by child") }

        binding.countdownSection.visibility = View.GONE

        if (FeatureAccessGate.hasWhatsAppConsent(repo)) {
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

        repo.whatsappMonitorConsent = true
        repo.messageMonitorConsent = true
        lifecycleScope.launch {
            runCatching { repo.syncConsentFlags() }
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.ACCEPTED)
            }
        }
        MonitoringForegroundService.start(this)
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

    private fun requestMediaPermissions() {
        val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            arrayOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_AUDIO
            )
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        requestMedia.launch(needed)
    }

    private fun refreshPermissionStatus() {
        val notif = NotificationMonitorService.isEnabled(this)
        val accessibility = isAccessibilityServiceEnabled()
        val media = hasMediaPermission()

        binding.statusNotif.text = if (notif) {
            "Notification access: enabled"
        } else {
            "Notification access: required — tap below and enable SareChild"
        }
        binding.statusAccessibility.text = if (accessibility) {
            "Accessibility: enabled"
        } else {
            "Accessibility: required — tap below and enable SareChild for on-screen WhatsApp text"
        }
        binding.statusMedia.text = if (media) {
            "WhatsApp media: granted"
        } else {
            "WhatsApp media: optional — for photos, videos, and voice notes"
        }

        if (notif && repo.whatsappMonitorConsent && commandId.isNotBlank()) {
            lifecycleScope.launch {
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
            }
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val flat = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return flat.contains(packageName)
    }

    private fun hasMediaPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            hasPerm(Manifest.permission.READ_MEDIA_IMAGES) ||
                hasPerm(Manifest.permission.READ_MEDIA_VIDEO) ||
                hasPerm(Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            hasPerm(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun hasPerm(perm: String): Boolean =
        ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
}
