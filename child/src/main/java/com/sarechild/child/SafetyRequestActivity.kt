package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivitySafetyRequestBinding
import com.sarechild.child.monitoring.ScreenShareService
import com.sarechild.child.ui.AllowCountdownController
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SafetyCommandType
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * The single "please allow" surface shared by every parent-initiated command
 * that needs the child to actively consent in the moment (screen share,
 * camera check, mic check). Always shows a big, unmissable auto-allow
 * countdown (see [AllowCountdownController]) so a parent isn't stuck if the
 * child can't reach the phone — e.g. an emergency. Tapping Allow or Not now
 * cancels the countdown immediately.
 */
class SafetyRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySafetyRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var scheduleId: String? = null
    private lateinit var commandType: SafetyCommandType
    private var durationMinutes: Int = SareChildConstants.SCREEN_SHARE_DEFAULT_MINUTES
    private var countdown: AllowCountdownController? = null
    private var autoAllowed = false

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) startActivity(cameraIntent()) else decline("Camera permission denied")
    }

    private val micPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) startActivity(micIntent()) else decline("Microphone permission denied")
    }

    private val screenCapture = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != RESULT_OK || result.data == null) {
            decline("Screen share cancelled")
            return@registerForActivityResult
        }
        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
            }
            repo.setActiveSessionRemote("screen")
        }
        val svc = Intent(this, ScreenShareService::class.java).apply {
            putExtra(SareChildConstants.EXTRA_COMMAND_ID, commandId)
            putExtra(SareChildConstants.EXTRA_DURATION_MINUTES, durationMinutes)
            putExtra(ScreenShareService.EXTRA_RESULT_CODE, result.resultCode)
            putExtra(ScreenShareService.EXTRA_RESULT_DATA, result.data)
        }
        ContextCompat.startForegroundService(this, svc)
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySafetyRequestBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)

        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()
        scheduleId = intent.getStringExtra(SareChildConstants.EXTRA_SCHEDULE_ID)
        val typeName = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_TYPE).orEmpty()
        commandType = runCatching { SafetyCommandType.valueOf(typeName) }.getOrElse {
            finish()
            return
        }
        durationMinutes = intent.getIntExtra(
            SareChildConstants.EXTRA_DURATION_MINUTES,
            SareChildConstants.SCREEN_SHARE_DEFAULT_MINUTES
        ).coerceIn(
            SareChildConstants.SCREEN_SHARE_MIN_MINUTES,
            SareChildConstants.SCREEN_SHARE_MAX_MINUTES
        )

        if (commandId.isBlank() && scheduleId.isNullOrBlank()) {
            finish()
            return
        }

        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.getCommandDurationMinutes(commandId)?.let { durationMinutes = it }
            }
        }

        when (commandType) {
            SafetyCommandType.SCREEN_SHARE -> {
                if (!repo.screenShareConsent) {
                    Toast.makeText(this, "Screen share was not consented during setup", Toast.LENGTH_LONG).show()
                    decline("No screen share consent")
                    return
                }
                binding.title.text = if (scheduleId != null) {
                    "Scheduled screen share with your parent?"
                } else {
                    "Share this screen with your parent?"
                }
                binding.body.text =
                    "If you Accept, Android will ask for screen capture. Sharing runs for about $durationMinutes minutes with a visible notification."
            }
            SafetyCommandType.CAMERA_CHECK -> {
                if (!repo.cameraCheckConsent) {
                    decline("No camera check consent")
                    return
                }
                binding.title.text = "Take a safety photo for your parent?"
                binding.body.text =
                    "If you Accept, the camera opens. You will see what is captured. Nothing happens silently."
            }
            SafetyCommandType.MIC_CHECK -> {
                if (!repo.micCheckConsent) {
                    decline("No mic check consent")
                    return
                }
                binding.title.text = "Record a short voice check?"
                binding.body.text =
                    "If you Accept, SareChild records about ${SareChildConstants.MIC_CHECK_SECONDS} seconds with a visible notification."
            }
            SafetyCommandType.STOP_SCREEN_SHARE,
            SafetyCommandType.RING_DEVICE,
            SafetyCommandType.SYNC_CALL_SMS,
            SafetyCommandType.LOCK_DEVICE,
            SafetyCommandType.UNLOCK_DEVICE,
            SafetyCommandType.REQUEST_WHATSAPP_PROTECTION,
            SafetyCommandType.REQUEST_CALL_RECORDING,
            SafetyCommandType.REQUEST_APP_INVENTORY,
            SafetyCommandType.START_LIVE_VIEW,
            SafetyCommandType.STOP_LIVE_VIEW -> {
                finish()
                return
            }
        }

        binding.accept.setOnClickListener { accept() }
        binding.decline.setOnClickListener { decline("Declined by child") }

        startAutoAllowCountdown()
    }

    /**
     * Big, hard-to-miss ring countdown. If the child doesn't tap Allow or Not
     * now before it reaches zero, this auto-allows the request — the exact
     * "can't reach the phone" safety scenario this screen exists to cover.
     */
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
        countdown?.cancel()
        binding.ring.stopPulse()
        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.ACCEPTED, autoAllowed = autoAllowed)
            }
        }
        when (commandType) {
            SafetyCommandType.CAMERA_CHECK -> {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED
                ) {
                    startActivity(cameraIntent())
                    finish()
                } else {
                    cameraPermission.launch(Manifest.permission.CAMERA)
                }
            }
            SafetyCommandType.MIC_CHECK -> {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED
                ) {
                    startActivity(micIntent())
                    finish()
                } else {
                    micPermission.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
            SafetyCommandType.SCREEN_SHARE -> {
                val mpm = getSystemService(MediaProjectionManager::class.java)
                screenCapture.launch(mpm.createScreenCaptureIntent())
            }
            else -> finish()
        }
    }

    private fun decline(reason: String) {
        countdown?.cancel()
        binding.ring.stopPulse()
        lifecycleScope.launch {
            if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.DECLINED, error = reason)
            }
            repo.setActiveSessionRemote(null)
        }
        finish()
    }

    private fun cameraIntent() = Intent(this, CameraCheckActivity::class.java).apply {
        putExtra(SareChildConstants.EXTRA_COMMAND_ID, commandId)
    }

    private fun micIntent() = Intent(this, MicCheckActivity::class.java).apply {
        putExtra(SareChildConstants.EXTRA_COMMAND_ID, commandId)
    }

    override fun onDestroy() {
        // Safety net: if the child navigates away without tapping Allow/Not now
        // (e.g. presses back), don't leave a timer running against a dead view.
        countdown?.cancel()
        super.onDestroy()
    }
}
