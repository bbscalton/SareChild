package com.sarechild.child

import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityMicCheckBinding
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

class MicCheckActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMicCheckBinding
    private lateinit var repo: ChildRepository
    private lateinit var commandId: String
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMicCheckBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)
        commandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()
        if (commandId.isBlank()) {
            finish()
            return
        }

        ensureChannel()
        lifecycleScope.launch { repo.setActiveSessionRemote("mic") }

        binding.start.setOnClickListener { startRecording() }
        binding.cancel.setOnClickListener {
            stopRecorder()
            lifecycleScope.launch {
                repo.updateCommand(commandId, SafetyCommandStatus.DECLINED, error = "Cancelled")
                repo.setActiveSessionRemote(null)
            }
            finish()
        }
    }

    private fun startRecording() {
        binding.start.isEnabled = false
        binding.status.text = "Recording for ${SareChildConstants.MIC_CHECK_SECONDS} seconds…"
        showRecordingNotification()
        val file = File(cacheDir, "mic_check_${System.currentTimeMillis()}.m4a")
        outputFile = file
        val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(this)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        recorder = rec
        rec.setAudioSource(MediaRecorder.AudioSource.MIC)
        rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        rec.setOutputFile(file.absolutePath)
        rec.prepare()
        rec.start()

        lifecycleScope.launch {
            repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
            delay(SareChildConstants.MIC_CHECK_SECONDS * 1000L)
            stopRecorder()
            upload(file)
        }
    }

    private suspend fun upload(file: File) {
        binding.status.text = "Uploading voice check…"
        runCatching {
            val (path, url) = repo.uploadMedia(file, "mic", "audio/mp4")
            repo.updateCommand(
                commandId,
                SafetyCommandStatus.COMPLETED,
                resultPath = path,
                resultUrl = url
            )
            repo.postAlert(
                FamilyAlert(
                    type = AlertType.MIC_CHECK,
                    severity = AlertSeverity.HIGH,
                    title = "Voice check from ${repo.childName}",
                    snippet = "Child accepted a ${SareChildConstants.MIC_CHECK_SECONDS}s visible voice check",
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
            repo.updateCommand(commandId, SafetyCommandStatus.FAILED, error = it.message)
            repo.setActiveSessionRemote(null)
            binding.start.isEnabled = true
        }
    }

    private fun stopRecorder() {
        try {
            recorder?.stop()
        } catch (_: Exception) {
        }
        try {
            recorder?.release()
        } catch (_: Exception) {
        }
        recorder = null
        getSystemService(NotificationManager::class.java)
            .cancel(SareChildConstants.SAFETY_NOTIFICATION_ID)
    }

    private fun showRecordingNotification() {
        val notification = NotificationCompat.Builder(this, SareChildConstants.NOTIFICATION_CHANNEL_SAFETY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Voice safety check active")
            .setContentText("SareChild is recording a short clip you accepted.")
            .setOngoing(true)
            .build()
        getSystemService(NotificationManager::class.java)
            .notify(SareChildConstants.SAFETY_NOTIFICATION_ID, notification)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                SareChildConstants.NOTIFICATION_CHANNEL_SAFETY,
                "Visible safety checks",
                NotificationManager.IMPORTANCE_HIGH
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        stopRecorder()
        super.onDestroy()
    }
}
