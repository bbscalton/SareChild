package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityCallRecordingRequestBinding
import com.sarechild.child.monitoring.FeatureAccessGate
import com.sarechild.child.monitoring.MonitoringForegroundService
import com.sarechild.child.monitoring.NotificationMonitorService
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Visible child Accept surface for a parent's "Request call recording" command.
 * Native Android — Cordova call-recorder plugins are not applicable.
 */
class CallRecordingRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivityCallRecordingRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var accepted = false

    private val requestPerms = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { refreshPermissionStatus() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCallRecordingRequestBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()

        if (FeatureAccessGate.isCallRecordingReady(this, repo)) {
            silentlyCompleteAndFinish()
            return
        }

        binding.body.text =
            "Your parent asked to enable call recording for safety monitoring. " +
                "Cellular calls use native Android recording when the OS allows. " +
                "VoIP apps (WhatsApp, Telegram, etc.) capture mic-side audio only — " +
                "full two-way VoIP recording is not reliably available on modern Android."

        binding.btnMic.setOnClickListener {
            requestPerms.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
        }
        binding.btnPhone.setOnClickListener {
            requestPerms.launch(arrayOf(Manifest.permission.READ_PHONE_STATE))
        }
        binding.btnNotifAccess.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        binding.btnDone.setOnClickListener { finish() }
        binding.accept.setOnClickListener { accept() }
        binding.decline.setOnClickListener { decline("Declined by child") }

        binding.countdownSection.visibility = View.GONE

        if (FeatureAccessGate.hasCallRecordingConsent(repo)) {
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

        repo.callRecordingConsent = true
        repo.callRecordingEnabled = true
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

    private fun refreshPermissionStatus() {
        val mic = hasPerm(Manifest.permission.RECORD_AUDIO)
        val phone = hasPerm(Manifest.permission.READ_PHONE_STATE)
        val notif = NotificationMonitorService.isEnabled(this)

        binding.statusMic.text = if (mic) {
            "Microphone: granted"
        } else {
            "Microphone: required for any call audio capture"
        }
        binding.statusPhone.text = if (phone) {
            "Phone state: granted (cellular call detection)"
        } else {
            "Phone state: required for cellular call start/end detection"
        }
        binding.statusNotif.text = if (notif) {
            "Notification access: enabled (VoIP call detection)"
        } else {
            "Notification access: required for WhatsApp/Telegram VoIP call detection"
        }

        if (FeatureAccessGate.isCallRecordingReady(this, repo) && commandId.isNotBlank()) {
            lifecycleScope.launch {
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
            }
        }
    }

    private fun hasPerm(perm: String): Boolean =
        ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
}
