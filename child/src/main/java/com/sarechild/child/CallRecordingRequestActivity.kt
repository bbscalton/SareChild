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
import com.sarechild.child.monitoring.MonitoringForegroundService
import com.sarechild.child.ui.AllowCountdownController
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Visible child Accept surface for a parent's "Request call recording" command.
 * Uses the same countdown auto-allow pattern as [SafetyRequestActivity].
 * Native Android — Cordova call-recorder plugins are not applicable.
 */
class CallRecordingRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivityCallRecordingRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var countdown: AllowCountdownController? = null
    private var autoAllowed = false
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

        startAutoAllowCountdown()
    }

    override fun onResume() {
        super.onResume()
        if (accepted) refreshPermissionStatus()
    }

    private fun startAutoAllowCountdown() {
        binding.ring.startPulse()
        countdown = AllowCountdownController(
            context = this,
            ring = binding.ring,
            secondsLabel = binding.secondsText,
            onAutoAllow = {
                autoAllowed = true
                accept()
            }
        ).also { it.start() }
    }

    private fun accept() {
        if (accepted) return
        accepted = true
        countdown?.cancel()
        binding.ring.stopPulse()
        binding.countdownSection.visibility = View.GONE
        binding.consentCard.visibility = View.GONE
        binding.accept.visibility = View.GONE
        binding.decline.visibility = View.GONE
        binding.permissionsCard.visibility = View.VISIBLE

        repo.callRecordingConsent = true
        repo.callRecordingEnabled = true
        lifecycleScope.launch {
            runCatching { repo.syncConsentFlags() }
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.ACCEPTED, autoAllowed = autoAllowed)
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
            }
        }
        MonitoringForegroundService.start(this)
        refreshPermissionStatus()
    }

    private fun decline(reason: String) {
        countdown?.cancel()
        binding.ring.stopPulse()
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
        val notif = isNotificationAccessEnabled()

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
    }

    private fun isNotificationAccessEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        return flat?.contains(packageName) == true
    }

    private fun hasPerm(perm: String): Boolean =
        ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED

    override fun onDestroy() {
        countdown?.cancel()
        super.onDestroy()
    }
}
