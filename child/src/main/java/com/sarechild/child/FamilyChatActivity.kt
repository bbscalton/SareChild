package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.firebase.firestore.ListenerRegistration
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityFamilyChatBinding
import com.sarechild.shared.FamilyChatMessage
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class FamilyChatActivity : AppCompatActivity() {
    private lateinit var binding: ActivityFamilyChatBinding
    private lateinit var repo: ChildRepository
    private var chatReg: ListenerRegistration? = null
    private var guardiansReg: ListenerRegistration? = null
    private var recorder: MediaRecorder? = null
    private var activeAudioFile: File? = null

    private val rows = mutableListOf<FamilyChatMessage>()
    private val adapter = ChatAdapter(rows) { url ->
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) uploadPicked(uri, "image/jpeg", "image")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityFamilyChatBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)

        binding.messages.layoutManager = LinearLayoutManager(this).apply { stackFromEnd = true }
        binding.messages.adapter = adapter

        binding.sendText.setOnClickListener {
            val text = binding.input.text?.toString()?.trim().orEmpty()
            if (text.isBlank()) return@setOnClickListener
            lifecycleScope.launch {
                runCatching { repo.sendFamilyChatMessage(text = text) }
                binding.input.setText("")
            }
        }
        binding.sendImage.setOnClickListener { pickImage.launch("image/*") }
        binding.sendVoice.setOnClickListener {
            if (recorder == null) startVoiceRecording() else stopAndSendVoice()
        }
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch { runCatching { repo.setChildChatPresence(true) } }
        chatReg = repo.listenFamilyChat { list ->
            rows.clear()
            rows.addAll(list)
            adapter.notifyDataSetChanged()
            binding.messages.scrollToPosition((rows.size - 1).coerceAtLeast(0))
        }
        guardiansReg = repo.listenGuardiansPresence { guardians ->
            val recentOnline = guardians.count { it.chatOnline && System.currentTimeMillis() - it.lastSeenMs < 120_000L }
            binding.presence.text = "Family chat · guardians online: $recentOnline"
        }
    }

    override fun onStop() {
        super.onStop()
        lifecycleScope.launch { runCatching { repo.setChildChatPresence(false) } }
        chatReg?.remove()
        guardiansReg?.remove()
    }

    override fun onDestroy() {
        stopRecorderOnly()
        super.onDestroy()
    }

    private fun uploadPicked(uri: Uri, contentType: String, mediaType: String) {
        lifecycleScope.launch {
            runCatching {
                val file = File(cacheDir, "chat_${System.currentTimeMillis()}")
                contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(file).use { out -> input.copyTo(out) }
                }
                val (_, url) = repo.uploadMedia(file, "chat", contentType)
                repo.sendFamilyChatMessage(mediaUrl = url, mediaType = mediaType)
            }
        }
    }

    private fun startVoiceRecording() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            Toast.makeText(this, "Microphone permission required for voice notes", Toast.LENGTH_SHORT).show()
            return
        }
        val file = File(cacheDir, "chat_voice_${System.currentTimeMillis()}.m4a")
        activeAudioFile = file
        val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else {
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
        binding.sendVoice.text = "Stop + send"
    }

    private fun stopAndSendVoice() {
        val file = activeAudioFile
        stopRecorderOnly()
        binding.sendVoice.text = "Voice note"
        if (file == null || !file.exists()) return
        lifecycleScope.launch {
            runCatching {
                val (_, url) = repo.uploadMedia(file, "chat", "audio/mp4")
                repo.sendFamilyChatMessage(mediaUrl = url, mediaType = "audio")
            }
        }
    }

    private fun stopRecorderOnly() {
        try {
            recorder?.stop()
        } catch (_: Exception) {
        }
        try {
            recorder?.release()
        } catch (_: Exception) {
        }
        recorder = null
    }

    private class ChatAdapter(
        private val items: List<FamilyChatMessage>,
        private val onMedia: (String) -> Unit
    ) : RecyclerView.Adapter<ChatAdapter.VH>() {
        private val fmt = SimpleDateFormat("MMM d HH:mm", Locale.getDefault())
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val tv = TextView(parent.context).apply { setPadding(10, 10, 10, 10) }
            return VH(tv)
        }

        override fun getItemCount(): Int = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = items[position]
            holder.text.text = buildString {
                append("${item.senderName} (${item.senderRole}) · ${fmt.format(Date(item.createdAtMs))}\n")
                item.text?.let { append(it) }
                if (!item.mediaUrl.isNullOrBlank()) {
                    if (item.text != null) append("\n")
                    append("[${item.mediaType ?: "media"}] Tap to open")
                }
            }
            holder.text.setOnClickListener {
                item.mediaUrl?.let { url -> onMedia(url) }
            }
        }

        class VH(val text: TextView) : RecyclerView.ViewHolder(text)
    }
}
