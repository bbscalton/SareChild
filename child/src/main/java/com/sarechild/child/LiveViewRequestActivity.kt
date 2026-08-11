package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivitySafetyRequestBinding
import com.sarechild.child.monitoring.LiveViewService
import com.sarechild.child.monitoring.ScreenCaptureHelper
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Headless gate for parent-initiated WebRTC live viewing (camera / mic / screen).
 * No Accept/Decline UI — see PermissionsActivity doc. Consent must already be on
 * from Enable Protections; this only ever surfaces the one unavoidable system
 * dialog (runtime permission sheet, or MediaProjection capture confirmation).
 */
class LiveViewRequestActivity : AppCompatActivity() {
    private var binding: ActivitySafetyRequestBinding? = null
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private var sessionId: String = ""
    private var durationMinutes: Int = SareChildConstants.LIVE_VIEW_DEFAULT_MINUTES
    private var enableVideo = true
    private var enableAudio = false
    private var enableScreen = false
    private var cameraFront = false
    private var recordEnabled = false
    private var projectionLaunched = false

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> if (granted) proceedAfterPermissions() else decline("Camera permission denied") }

    private val micPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> if (granted) proceedAfterPermissions() else decline("Microphone permission denied") }

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
        repo = ChildRepository(this)
        projectionLaunched = savedInstanceState?.getBoolean(STATE_PROJECTION_LAUNCHED) == true
        handleIntent(intent, savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_PROJECTION_LAUNCHED, projectionLaunched)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent, null)
    }

    private fun handleIntent(intent: Intent, savedInstanceState: Bundle?) {
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

        val missingItem = when {
            enableScreen && !repo.screenShareConsent -> "screen"
            enableVideo && !enableScreen && !repo.cameraCheckConsent -> "camera"
            enableAudio && !repo.micCheckConsent -> "mic"
            else -> null
        }
        if (missingItem != null) {
            redirectToEnableProtections(missingItem)
            return
        }

        if (enableScreen) {
            if (savedInstanceState != null || projectionLaunched) return
            ScreenCaptureHelper.launchFullScreenCaptureWhenReady(this, screenCapture) {
                projectionLaunched = true
            }
            return
        }

        if (binding == null) {
            binding = ActivitySafetyRequestBinding.inflate(layoutInflater)
            setContentView(binding!!.root)
            val parts = buildList {
                if (enableVideo) add(if (cameraFront) "front camera" else "rear camera")
                if (enableAudio) add("microphone")
            }.joinToString(", ")
            binding!!.body.text = "Sharing $parts live for about $durationMinutes minute(s), visibly."
        }
        proceedAfterPermissions()
    }

    private fun proceedAfterPermissions() {
        if (enableVideo && !enableScreen &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
        ) {
            cameraPermission.launch(Manifest.permission.CAMERA)
            return
        }
        if (enableAudio &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        launchLiveService(RESULT_OK, null)
    }

    private fun launchLiveService(resultCode: Int, data: Intent?) {
        stopService(Intent(this, LiveViewService::class.java))
        lifecycleScope.launch { repo.updateCommand(commandId, SafetyCommandStatus.ACCEPTED) }
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

    private fun redirectToEnableProtections(itemId: String) {
        lifecycleScope.launch {
            repo.updateCommand(commandId, SafetyCommandStatus.FAILED, error = "Needs setup on Enable Protections page")
            repo.updateLiveSession(sessionId, mapOf("status" to "failed", "error" to "Needs child setup"))
        }
        startActivity(
            Intent(this, PermissionsActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(SareChildConstants.EXTRA_HIGHLIGHT_ITEM_ID, itemId)
            }
        )
        finish()
    }

    private fun decline(reason: String) {
        lifecycleScope.launch {
            repo.updateCommand(commandId, SafetyCommandStatus.DECLINED, error = reason)
            repo.updateLiveSession(sessionId, mapOf("status" to "declined", "error" to reason))
        }
        finish()
    }

    companion object {
        private const val STATE_PROJECTION_LAUNCHED = "projection_launched"
    }
}
