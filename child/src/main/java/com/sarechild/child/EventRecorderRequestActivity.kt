package com.sarechild.child

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityEventRecorderRequestBinding
import com.sarechild.child.monitoring.EventRecorderMonitor
import com.sarechild.child.monitoring.MessageMonitorAccessibilityService
import com.sarechild.child.monitoring.MonitoringForegroundService
import com.sarechild.child.monitoring.NotificationMonitorService
import com.sarechild.child.monitoring.UsageMonitorHelper
import com.sarechild.child.ui.AllowCountdownController
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Visible child Accept surface for a parent's "Request Event Recorder access" command.
 */
class EventRecorderRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivityEventRecorderRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var countdown: AllowCountdownController? = null
    private var autoAllowed = false
    private var accepted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityEventRecorderRequestBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()

        binding.body.text =
            "Your parent asked to view an activity timeline from this phone — apps used, idle time, " +
                "media titles, and optional browser hints. You'll grant Usage access (required) and can " +
                "optionally enable Notification access and Accessibility for richer detail."

        binding.btnUsage.setOnClickListener { UsageMonitorHelper.openUsageSettings(this) }
        binding.btnNotification.setOnClickListener { openNotificationSettings() }
        binding.btnAccessibility.setOnClickListener { openAccessibilitySettings() }
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

        repo.eventRecorderConsent = true
        lifecycleScope.launch {
            runCatching { repo.syncConsentFlags() }
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.ACCEPTED, autoAllowed = autoAllowed)
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
        val usage = UsageMonitorHelper.hasUsageAccess(this)
        val notif = NotificationMonitorService.isEnabled(this)
        val a11y = MessageMonitorAccessibilityService.isServiceEnabled(this)

        binding.statusUsage.text = if (usage) {
            "Usage access: granted (app foreground timeline enabled)"
        } else {
            "Usage access: required — tap below and enable for SareChild"
        }
        binding.statusNotification.text = if (notif) {
            "Notification access: granted (YouTube/media titles from notifications)"
        } else {
            "Notification access: optional — improves YouTube/Spotify title capture"
        }
        binding.statusAccessibility.text = if (a11y) {
            "Accessibility: granted (optional browser URL/title hints)"
        } else {
            "Accessibility: optional — only if already enabled; never turned on secretly"
        }

        if (usage && repo.eventRecorderConsent) {
            lifecycleScope.launch {
                runCatching {
                    val monitor = EventRecorderMonitor(this@EventRecorderRequestActivity, repo)
                    monitor.start()
                    monitor.sync(force = true)
                    if (commandId.isNotBlank()) {
                        repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
                    }
                }
            }
        }
    }

    private fun openNotificationSettings() {
        startActivity(
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    private fun openAccessibilitySettings() {
        startActivity(
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    override fun onDestroy() {
        countdown?.cancel()
        super.onDestroy()
    }
}
