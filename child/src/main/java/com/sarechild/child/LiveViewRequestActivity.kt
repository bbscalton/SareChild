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
import com.sarechild.child.monitoring.LiveViewService
import com.sarechild.child.ui.AllowCountdownController
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Consent screen for parent-initiated WebRTC live viewing. Reuses the safety-request
 * layout with countdown auto-allow (30s) — child always sees what is being shared.
 */
class LiveViewRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySafetyRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var sessionId: String = ""
    private var durationMinutes: Int = SareChildConstants.LIVE_VIEW_DEFAULT_MINUTES
    private var enableVideo = true
    private var enableAudio = false
    private var enableScreen = false
    private var cameraFront = false
    private var recordEnabled = false
    private var countdown: AllowCountdownController? = null
    private var autoAllowed = false

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) proceedAfterPermissions() else decline("Camera permission denied")
    }

    private val micPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) proceedAfterPermissions() else decline("Microphone permission denied")
    }

    private val screenCapture = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != RESULT_OK || result.data == null) {
            decline("Screen share cancelled")
            return@registerForActivityResult
        }
        launchLiveService(result.resultCode, result.data)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySafetyRequestBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)

        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()
        sessionId = intent.getStringExtra(SareChildConstants.EXTRA_LIVE_SESSION_ID).orEmpty()
        durationMinutes = intent.getIntExtra(
            SareChildConstants.EXTRA_DURATION_MINUTES,
            SareChildConstants.LIVE_VIEW_DEFAULT_MINUTES
        ).coerceIn(SareChildConstants.LIVE_VIEW_MIN_MINUTES, SareChildConstants.LIVE_VIEW_MAX_MINUTES)
        enableVideo = intent.getBooleanExtra(SareChildConstants.EXTRA_LIVE_VIDEO, true)
        enableAudio = intent.getBooleanExtra(SareChildConstants.EXTRA_LIVE_AUDIO, false)
        enableScreen = intent.getBooleanExtra(SareChildConstants.EXTRA_LIVE_SCREEN, false)
        cameraFront = intent.getBooleanExtra(SareChildConstants.EXTRA_CAMERA_FACING, false)
        recordEnabled = intent.getBooleanExtra(SareChildConstants.EXTRA_LIVE_RECORD, false)

        if (commandId.isBlank() || sessionId.isBlank()) {
            finish()
            return
        }

        val parts = buildList {
            if (enableVideo && !enableScreen) add(if (cameraFront) "front camera" else "rear camera")
            if (enableScreen) add("screen")
            if (enableAudio) add("microphone")
        }.joinToString(", ")

        binding.title.text = "Live viewing with your parent?"
        binding.body.text =
            "If you Accept, your parent can watch $parts live for about $durationMinutes minute(s). " +
                "A visible notification stays on while sharing."

        binding.accept.setOnClickListener {
            countdown?.cancel()
            acceptRequest()
        }
        binding.decline.setOnClickListener {
            countdown?.cancel()
            decline("Declined by child")
        }

        countdown = AllowCountdownController(
            context = this,
            ring = binding.ring,
            secondsLabel = binding.secondsText,
            onAutoAllow = {
                autoAllowed = true
                acceptRequest()
            }
        )
        countdown?.start()
    }

    private fun acceptRequest() {
        lifecycleScope.launch {
            repo.updateCommand(
                commandId,
                SafetyCommandStatus.ACCEPTED,
                autoAllowed = autoAllowed
            )
        }
        if (enableScreen) {
            if (!repo.screenShareConsent) {
                Toast.makeText(this, "Screen share was not consented during setup", Toast.LENGTH_LONG).show()
                decline("No screen share consent")
                return
            }
            val mpm = getSystemService(MediaProjectionManager::class.java)
            screenCapture.launch(mpm.createScreenCaptureIntent())
            return
        }
        proceedAfterPermissions()
    }

    private fun proceedAfterPermissions() {
        if (enableVideo && !enableScreen) {
            if (!repo.cameraCheckConsent) {
                Toast.makeText(this, "Camera was not consented during setup", Toast.LENGTH_LONG).show()
                decline("No camera consent")
                return
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                cameraPermission.launch(Manifest.permission.CAMERA)
                return
            }
        }
        if (enableAudio) {
            if (!repo.micCheckConsent) {
                Toast.makeText(this, "Microphone was not consented during setup", Toast.LENGTH_LONG).show()
                decline("No microphone consent")
                return
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                micPermission.launch(Manifest.permission.RECORD_AUDIO)
                return
            }
        }
        launchLiveService(RESULT_OK, null)
    }

    private fun launchLiveService(resultCode: Int, data: Intent?) {
        val svc = Intent(this, LiveViewService::class.java).apply {
            putExtra(SareChildConstants.EXTRA_COMMAND_ID, commandId)
            putExtra(SareChildConstants.EXTRA_LIVE_SESSION_ID, sessionId)
            putExtra(SareChildConstants.EXTRA_DURATION_MINUTES, durationMinutes)
            putExtra(SareChildConstants.EXTRA_LIVE_VIDEO, enableVideo)
            putExtra(SareChildConstants.EXTRA_LIVE_AUDIO, enableAudio)
            putExtra(SareChildConstants.EXTRA_LIVE_SCREEN, enableScreen)
            putExtra(SareChildConstants.EXTRA_CAMERA_FACING, cameraFront)
            putExtra(SareChildConstants.EXTRA_LIVE_RECORD, recordEnabled)
            if (data != null) {
                putExtra(LiveViewService.EXTRA_RESULT_CODE, resultCode)
                putExtra(LiveViewService.EXTRA_RESULT_DATA, data)
            }
        }
        ContextCompat.startForegroundService(this, svc)
        finish()
    }

    private fun decline(reason: String) {
        lifecycleScope.launch {
            repo.updateCommand(commandId, SafetyCommandStatus.DECLINED, error = reason, autoAllowed = false)
            repo.updateLiveSession(sessionId, mapOf("status" to "declined", "error" to reason))
        }
        finish()
    }

    override fun onDestroy() {
        countdown?.cancel()
        super.onDestroy()
    }
}
