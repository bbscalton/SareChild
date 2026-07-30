package com.sarechild.child

import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.provider.MediaStore
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityCameraCheckBinding
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream

class CameraCheckActivity : AppCompatActivity() {
    private lateinit var binding: ActivityCameraCheckBinding
    private lateinit var repo: ChildRepository
    private lateinit var commandId: String
    private var photoFile: File? = null

    private val takePicture = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val bitmap = result.data?.extras?.get("data") as? Bitmap
        if (bitmap == null) {
            binding.status.text = "No photo captured"
            return@registerForActivityResult
        }
        binding.preview.setImageBitmap(bitmap)
        val file = File(cacheDir, "camera_check_${System.currentTimeMillis()}.jpg")
        FileOutputStream(file).use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
        }
        photoFile = file
        binding.send.isEnabled = true
        binding.status.text = "Photo ready. Review it, then send or cancel."
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCameraCheckBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()
        if (commandId.isBlank()) {
            finish()
            return
        }

        lifecycleScope.launch { repo.setActiveSessionRemote("camera") }

        binding.capture.setOnClickListener {
            takePicture.launch(Intent(MediaStore.ACTION_IMAGE_CAPTURE))
        }
        binding.captureBack.setOnClickListener {
            takePicture.launch(
                Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                    putExtra("android.intent.extras.CAMERA_FACING", 0)
                    putExtra("android.intent.extra.USE_FRONT_CAMERA", false)
                }
            )
        }
        binding.captureFront.setOnClickListener {
            takePicture.launch(
                Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                    putExtra("android.intent.extras.CAMERA_FACING", 1)
                    putExtra("android.intent.extra.USE_FRONT_CAMERA", true)
                }
            )
        }
        binding.send.setOnClickListener { sendPhoto() }
        binding.cancel.setOnClickListener {
            lifecycleScope.launch {
                repo.updateCommand(commandId, SafetyCommandStatus.DECLINED, error = "Cancelled")
                repo.setActiveSessionRemote(null)
            }
            finish()
        }
    }

    private fun sendPhoto() {
        val file = photoFile ?: return
        binding.send.isEnabled = false
        binding.status.text = "Uploading…"
        lifecycleScope.launch {
            runCatching {
                repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
                val (path, url) = repo.uploadMedia(file, "camera", "image/jpeg")
                repo.updateCommand(
                    commandId,
                    SafetyCommandStatus.COMPLETED,
                    resultPath = path,
                    resultUrl = url
                )
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.CAMERA_CHECK,
                        severity = AlertSeverity.HIGH,
                        title = "Camera check from ${repo.childName}",
                        snippet = "Child accepted and sent a visible safety photo",
                        mediaUrl = url,
                        commandId = commandId
                    )
                )
                repo.setActiveSessionRemote(null)
            }.onSuccess {
                binding.status.text = "Sent to parent"
                finish()
            }.onFailure {
                binding.status.text = it.message ?: "Upload failed"
                binding.send.isEnabled = true
                repo.updateCommand(commandId, SafetyCommandStatus.FAILED, error = it.message)
                repo.setActiveSessionRemote(null)
            }
        }
    }
}
