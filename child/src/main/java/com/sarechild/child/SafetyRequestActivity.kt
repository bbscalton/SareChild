package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivitySafetyRequestBinding
import com.sarechild.child.monitoring.ScreenShareService
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SafetyCommandType
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * Headless gate for a live parent-initiated session (screen share / camera check /
 * mic check). Shows NO Accept/Decline UI of its own — see class doc on
 * PermissionsActivity for why. If the relevant consent was already switched on from
 * Enable Protections, this jumps straight to the one system dialog Android requires
 * (runtime permission sheet, or the unavoidable MediaProjection screen-capture
 * confirmation) and starts the session. If consent is missing, it hands off to
 * Enable Protections with that row highlighted instead of asking here.
 */
class SafetyRequestActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySafetyRequestBinding
    private lateinit var repo: ChildRepository
    private var commandId: String = ""
    private lateinit var commandType: SafetyCommandType
    private var durationMinutes: Int = SareChildConstants.SCREEN_SHARE_DEFAULT_MINUTES

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            startActivity(cameraIntent())
            finish()
        } else {
            decline("Camera permission denied")
        }
    }

    private val micPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            startActivity(micIntent())
            finish()
        } else {
            decline("Microphone permission denied")
        }
    }

    private val screenCapture = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != RESULT_OK || result.data == null) {
            decline("Screen share cancelled")
            return@registerForActivityResult
        }
        lifecycleScope.launch {
            if (commandId.isNotBlank()) repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
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
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()
        val typeName = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_TYPE).orEmpty()
        val type = runCatching { SafetyCommandType.valueOf(typeName) }.getOrNull()
        if (type == null || commandId.isBlank()) {
            finish()
            return
        }
        commandType = type
        durationMinutes = intent.getIntExtra(
            SareChildConstants.EXTRA_DURATION_MINUTES,
            SareChildConstants.SCREEN_SHARE_DEFAULT_MINUTES
        ).coerceIn(SareChildConstants.SCREEN_SHARE_MIN_MINUTES, SareChildConstants.SCREEN_SHARE_MAX_MINUTES)

        lifecycleScope.launch {
            repo.getCommandDurationMinutes(commandId)?.let { durationMinutes = it }
        }

        when (commandType) {
            SafetyCommandType.SCREEN_SHARE -> {
                binding.body.text = "Sharing runs for about $durationMinutes minute(s), visibly."
                if (!repo.screenShareConsent) {
                    redirectToEnableProtections("screen")
                    return
                }
                val mpm = getSystemService(MediaProjectionManager::class.java)
                screenCapture.launch(mpm.createScreenCaptureIntent())
            }
            SafetyCommandType.CAMERA_CHECK -> {
                binding.body.text = "Opening the camera for a visible safety photo."
                if (!repo.cameraCheckConsent) {
                    redirectToEnableProtections("camera")
                    return
                }
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
                binding.body.text = "Recording a short ${SareChildConstants.MIC_CHECK_SECONDS}s voice check, visibly."
                if (!repo.micCheckConsent) {
                    redirectToEnableProtections("mic")
                    return
                }
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED
                ) {
                    startActivity(micIntent())
                    finish()
                } else {
                    micPermission.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
            else -> finish()
        }
    }

    /** Consent for this capability hasn't been switched on from Enable Protections yet —
     *  send the child there (highlighted) instead of asking again here. */
    private fun redirectToEnableProtections(itemId: String) {
        lifecycleScope.launch {
            repo.updateCommand(
                commandId,
                SafetyCommandStatus.FAILED,
                error = "Needs setup on Enable Protections page"
            )
            repo.setActiveSessionRemote(null)
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
}
