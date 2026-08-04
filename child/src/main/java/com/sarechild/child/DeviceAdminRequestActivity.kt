package com.sarechild.child

import android.os.Bundle
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityDeviceAdminRequestBinding
import com.sarechild.child.monitoring.FeatureAccessGate
import com.sarechild.child.monitoring.MonitoringForegroundService
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Visible child Accept surface for a parent's "Request Device Admin" command.
 * Guides the child through Android's Device Administrator enable flow (cannot be silent).
 */
class DeviceAdminRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivityDeviceAdminRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var accepted = false

    private val enableAdmin = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshAdminStatus()
        if (DeviceAdminHelper.isAdminActive(this)) {
            completeAccepted()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDeviceAdminRequestBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()

        if (FeatureAccessGate.isDeviceAdminReady(this)) {
            completeAccepted(finishAfter = true)
            return
        }

        binding.body.text =
            "Your parent asked to enable remote lock screen on this phone. " +
                "You'll confirm Device Administrator in the next Android system screen."

        binding.accept.setOnClickListener { acceptAndLaunch() }
        binding.decline.setOnClickListener { decline("Declined by child") }
        binding.btnEnableAdmin.setOnClickListener { launchEnableAdmin() }
        binding.btnDone.setOnClickListener { finish() }

        refreshAdminStatus()
    }

    override fun onResume() {
        super.onResume()
        refreshAdminStatus()
        if (accepted && DeviceAdminHelper.isAdminActive(this)) {
            completeAccepted(finishAfter = true)
        }
    }

    private fun acceptAndLaunch() {
        if (accepted) {
            launchEnableAdmin()
            return
        }
        accepted = true
        binding.accept.visibility = View.GONE
        binding.decline.visibility = View.GONE
        launchEnableAdmin()
    }

    private fun launchEnableAdmin() {
        enableAdmin.launch(DeviceAdminHelper.createEnableAdminIntent(this))
    }

    private fun refreshAdminStatus() {
        val active = DeviceAdminHelper.isAdminActive(this)
        binding.statusAdmin.text = if (active) {
            "✓ Device Administrator is enabled — parent can lock this phone remotely"
        } else {
            "✗ Device Administrator is not enabled yet"
        }
        binding.btnEnableAdmin.visibility = if (active) View.GONE else View.VISIBLE
    }

    private fun completeAccepted(finishAfter: Boolean = false) {
        lifecycleScope.launch {
            runCatching { repo.updateLockScreenStatus(this@DeviceAdminRequestActivity) }
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
            }
        }
        MonitoringForegroundService.start(this)
        if (finishAfter) {
            finish()
        }
    }

    private fun decline(reason: String) {
        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.DECLINED, error = reason)
            }
        }
        finish()
    }
}
