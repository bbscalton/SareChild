package com.sarechild.child

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.LifecycleCoroutineScope
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.ListenerRegistration
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityFamilyChatBinding
import com.sarechild.child.databinding.ItemChatMessageBinding
import com.sarechild.shared.ChatMedia
import com.sarechild.shared.ChatNotePlayer
import com.sarechild.shared.FamilyChatMessage
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.math.max

class FamilyChatActivity : AppCompatActivity() {
    private lateinit var binding: ActivityFamilyChatBinding
    private lateinit var repo: ChildRepository
    private var chatReg: ListenerRegistration? = null
    private var guardiansReg: ListenerRegistration? = null
    private var recorder: MediaRecorder? = null
    private var activeAudioFile: File? = null
    private var pendingCaptureFile: File? = null
    private val notePlayer = ChatNotePlayer()

    private val rows = mutableListOf<FamilyChatMessage>()
    private val adapter = ChatAdapter(
        rows,
        currentUserId = { FirebaseAuth.getInstance().currentUser?.uid },
        onOpenMedia = { url -> runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
        notePlayer = notePlayer,
        scope = { lifecycleScope }
    )

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) uploadPicked(uri, "image/jpeg", "image")
    }

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) showCaptureChooser() else {
            Toast.makeText(this, getString(R.string.chat_camera_permission_required), Toast.LENGTH_SHORT).show()
        }
    }

    private val capturePhoto = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val file = pendingCaptureFile
        pendingCaptureFile = null
        if (result.resultCode == Activity.RESULT_OK && file != null && file.exists() && file.length() > 0) {
            uploadCaptured(file, "image/jpeg", "image", null)
        } else {
            file?.delete()
        }
    }

    private val captureVideo = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val file = pendingCaptureFile
        pendingCaptureFile = null
        if (result.resultCode == Activity.RESULT_OK && file != null && file.exists() && file.length() > 0) {
            uploadCaptured(file, "video/mp4", "video", readMediaDurationMs(file))
        } else {
            file?.delete()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        binding = ActivityFamilyChatBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)
        applyKeyboardSafeInsets()

        binding.messages.layoutManager = LinearLayoutManager(this).apply { stackFromEnd = true }
        binding.messages.adapter = adapter
        updateEmptyState()

        binding.sendText.setOnClickListener { sendCurrentText() }
        binding.input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendCurrentText()
                true
            } else {
                false
            }
        }
        binding.sendImage.setOnClickListener { pickImage.launch("image/*") }
        binding.sendCamera.setOnClickListener { onCameraClicked() }
        binding.sendVoice.setOnClickListener {
            if (recorder == null) startVoiceRecording() else stopAndSendVoice()
        }
    }

    private fun applyKeyboardSafeInsets() {
        val headerPadStart = binding.header.paddingStart
        val headerPadTop = binding.header.paddingTop
        val headerPadEnd = binding.header.paddingEnd
        val headerPadBottom = binding.header.paddingBottom
        val composerPadStart = binding.composer.paddingStart
        val composerPadTop = binding.composer.paddingTop
        val composerPadEnd = binding.composer.paddingEnd
        val composerPadBottom = binding.composer.paddingBottom

        ViewCompat.setOnApplyWindowInsetsListener(binding.chatRoot) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            binding.header.updatePadding(
                left = headerPadStart + bars.left,
                top = headerPadTop + bars.top,
                right = headerPadEnd + bars.right,
                bottom = headerPadBottom
            )
            binding.composer.updatePadding(
                left = composerPadStart + bars.left,
                top = composerPadTop,
                right = composerPadEnd + bars.right,
                bottom = composerPadBottom + max(bars.bottom, ime.bottom)
            )
            if (ime.bottom > 0 && rows.isNotEmpty()) {
                binding.messages.post {
                    binding.messages.scrollToPosition(rows.lastIndex)
                }
            }
            insets
        }
        ViewCompat.requestApplyInsets(binding.chatRoot)
    }

    private fun sendCurrentText() {
        val text = binding.input.text?.toString()?.trim().orEmpty()
        if (text.isBlank()) return
        lifecycleScope.launch {
            runCatching { repo.sendFamilyChatMessage(text = text) }
            binding.input.setText("")
        }
    }

    private fun updateEmptyState() {
        val empty = rows.isEmpty()
        binding.emptyState.visibility = if (empty) View.VISIBLE else View.GONE
        binding.messages.visibility = if (empty) View.INVISIBLE else View.VISIBLE
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch { runCatching { repo.setChildChatPresence(true) } }
        chatReg = repo.listenFamilyChat { list ->
            rows.clear()
            rows.addAll(list)
            adapter.notifyDataSetChanged()
            updateEmptyState()
            if (rows.isNotEmpty()) {
                binding.messages.scrollToPosition(rows.lastIndex)
            }
            lifecycleScope.launch { runCatching { repo.markChatRead() } }
        }
        guardiansReg = repo.listenGuardiansPresence { guardians ->
            val recentOnline = guardians.count {
                it.chatOnline && System.currentTimeMillis() - it.lastSeenMs < 120_000L
            }
            binding.presence.text = if (recentOnline == 1) {
                getString(R.string.chat_presence_guardians, recentOnline)
            } else {
                getString(R.string.chat_presence_guardians_plural, recentOnline)
            }
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
        notePlayer.release()
        super.onDestroy()
    }

    private fun uploadPicked(uri: Uri, contentType: String, mediaType: String) {
        lifecycleScope.launch {
            runCatching {
                val file = File(cacheDir, "chat_${System.currentTimeMillis()}")
                contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(file).use { out -> input.copyTo(out) }
                }
                val (path, url) = repo.uploadMedia(file, "chat", contentType)
                repo.sendFamilyChatMessage(mediaUrl = url, mediaPath = path, mediaType = mediaType)
                file.delete()
            }.onFailure {
                Toast.makeText(this@FamilyChatActivity, "Couldn't send — try again", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ---------- Camera photo / video capture ----------

    private fun onCameraClicked() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            showCaptureChooser()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun showCaptureChooser() {
        AlertDialog.Builder(this)
            .setTitle(R.string.chat_choose_capture_title)
            .setItems(
                arrayOf(getString(R.string.chat_capture_photo), getString(R.string.chat_capture_video))
            ) { _, which ->
                if (which == 0) launchPhotoCapture() else showVideoLengthChooser()
            }
            .show()
    }

    private fun captureFileUri(file: File): Uri =
        FileProvider.getUriForFile(this, "$packageName.fileprovider", file)

    private fun launchPhotoCapture() {
        val file = File(cacheDir, "chat_capture_${System.currentTimeMillis()}.jpg")
        val uri = captureFileUri(file)
        pendingCaptureFile = file
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        runCatching { capturePhoto.launch(intent) }.onFailure {
            pendingCaptureFile = null
            Toast.makeText(this, "No camera app available", Toast.LENGTH_SHORT).show()
        }
    }

    /** Offers 1/2/3 minute options clamped to the family's TCD-configurable max — a device on a
     *  family with a raised limit will simply see fewer/longer options filtered from the same list. */
    private fun showVideoLengthChooser() {
        lifecycleScope.launch {
            val familyMax = runCatching { repo.getMaxChatVideoSeconds() }
                .getOrDefault(SareChildConstants.CHAT_VIDEO_SECONDS_DEFAULT_MAX)
            val options = SareChildConstants.CHAT_VIDEO_SECONDS_OPTIONS
                .filter { it <= familyMax }
                .ifEmpty { listOf(familyMax) }
            val labels = options.map { secs ->
                val mins = secs / 60
                if (mins >= 1 && secs % 60 == 0) {
                    resources.getQuantityStringOrFallback(mins)
                } else {
                    "${secs}s"
                }
            }.toTypedArray()
            if (!ContextCompat.checkSelfPermission(
                    this@FamilyChatActivity, Manifest.permission.RECORD_AUDIO
                ).let { it == PackageManager.PERMISSION_GRANTED }
            ) {
                Toast.makeText(
                    this@FamilyChatActivity,
                    "Microphone permission required for video with sound",
                    Toast.LENGTH_SHORT
                ).show()
            }
            AlertDialog.Builder(this@FamilyChatActivity)
                .setTitle(R.string.chat_pick_video_title)
                .setItems(labels) { _, which -> launchVideoCapture(options[which]) }
                .show()
        }
    }

    private fun android.content.res.Resources.getQuantityStringOrFallback(mins: Int): String =
        if (mins == 1) getString(R.string.chat_pick_video_1min)
        else if (mins == 2) getString(R.string.chat_pick_video_2min)
        else if (mins == 3) getString(R.string.chat_pick_video_3min)
        else "$mins minutes"

    private fun launchVideoCapture(maxSeconds: Int) {
        val file = File(cacheDir, "chat_capture_${System.currentTimeMillis()}.mp4")
        val uri = captureFileUri(file)
        pendingCaptureFile = file
        val intent = Intent(MediaStore.ACTION_VIDEO_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            putExtra(MediaStore.EXTRA_DURATION_LIMIT, maxSeconds)
            putExtra(MediaStore.EXTRA_VIDEO_QUALITY, 1)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        runCatching { captureVideo.launch(intent) }.onFailure {
            pendingCaptureFile = null
            Toast.makeText(this, "No camera app available", Toast.LENGTH_SHORT).show()
        }
    }

    private fun readMediaDurationMs(file: File): Long? = runCatching {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        } finally {
            retriever.release()
        }
    }.getOrNull()

    private fun uploadCaptured(file: File, contentType: String, mediaType: String, durationMs: Long?) {
        Toast.makeText(this, getString(R.string.chat_uploading), Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            runCatching {
                val (path, url) = repo.uploadMedia(file, "chat", contentType)
                repo.sendFamilyChatMessage(
                    mediaUrl = url,
                    mediaPath = path,
                    mediaType = mediaType,
                    durationMs = durationMs
                )
            }.onFailure {
                Toast.makeText(this@FamilyChatActivity, "Couldn't send — try again", Toast.LENGTH_SHORT).show()
            }
            file.delete()
        }
    }

    // ---------- Voice notes ----------

    private fun startVoiceRecording() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
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
        binding.voiceStatus.visibility = View.VISIBLE
        binding.voiceStatus.text = getString(R.string.chat_recording)
        binding.sendVoice.alpha = 0.55f
    }

    private fun stopAndSendVoice() {
        val file = activeAudioFile
        stopRecorderOnly()
        binding.voiceStatus.visibility = View.GONE
        binding.sendVoice.alpha = 1f
        if (file == null || !file.exists()) return
        val durationMs = readMediaDurationMs(file)
        lifecycleScope.launch {
            runCatching {
                val (path, url) = repo.uploadMedia(file, "chat", "audio/mp4")
                repo.sendFamilyChatMessage(mediaUrl = url, mediaPath = path, mediaType = "audio", durationMs = durationMs)
            }.onFailure {
                Toast.makeText(this@FamilyChatActivity, "Couldn't send — try again", Toast.LENGTH_SHORT).show()
            }
            file.delete()
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
        private val currentUserId: () -> String?,
        private val onOpenMedia: (String) -> Unit,
        private val notePlayer: ChatNotePlayer,
        private val scope: () -> LifecycleCoroutineScope
    ) : RecyclerView.Adapter<ChatAdapter.VH>() {
        private val fmt = SimpleDateFormat("MMM d · h:mm a", Locale.getDefault())
        private val imageThumbCache = mutableMapOf<String, android.graphics.Bitmap>()
        private val videoThumbCache = mutableMapOf<String, android.graphics.Bitmap>()

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val binding = ItemChatMessageBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            return VH(binding)
        }

        override fun getItemCount(): Int = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = items[position]
            val mine = !item.senderUid.isNullOrBlank() && item.senderUid == currentUserId()
            val ctx = holder.binding.root.context
            val bubble = holder.binding.bubbleContainer

            (bubble.layoutParams as FrameLayout.LayoutParams).gravity =
                if (mine) Gravity.END else Gravity.START
            bubble.background = ContextCompat.getDrawable(
                ctx,
                if (mine) R.drawable.bg_chat_bubble_out else R.drawable.bg_chat_bubble_in
            )

            val onBubble = if (mine) {
                ContextCompat.getColor(ctx, R.color.chat_text_on_brand)
            } else {
                ContextCompat.getColor(ctx, R.color.chat_text_primary)
            }
            val secondary = if (mine) {
                Color.argb(200, 255, 255, 255)
            } else {
                ContextCompat.getColor(ctx, R.color.chat_text_secondary)
            }
            val accent = if (mine) {
                Color.argb(230, 255, 255, 255)
            } else {
                ContextCompat.getColor(ctx, R.color.brand_green)
            }

            val roleLabel = when (item.senderRole.uppercase(Locale.US)) {
                "CHILD" -> ctx.getString(R.string.chat_role_child)
                else -> ctx.getString(R.string.chat_role_guardian)
            }
            holder.binding.sender.text = if (mine) "You" else "${item.senderName} · $roleLabel"
            holder.binding.sender.setTextColor(accent)
            holder.binding.body.setTextColor(onBubble)
            holder.binding.timestamp.setTextColor(secondary)
            holder.binding.timestamp.text = fmt.format(Date(item.createdAtMs))

            val body = item.text?.trim().orEmpty()
            if (body.isNotEmpty()) {
                holder.binding.body.visibility = View.VISIBLE
                holder.binding.body.text = body
            } else {
                holder.binding.body.visibility = View.GONE
            }

            holder.binding.mediaImageFrame.visibility = View.GONE
            holder.binding.playOverlay.visibility = View.GONE
            holder.binding.voiceRow.visibility = View.GONE
            holder.binding.mediaChip.visibility = View.GONE
            holder.binding.mediaImage.setImageDrawable(null)
            holder.binding.mediaImage.tag = null
            bubble.setOnClickListener(null)

            val url = item.mediaUrl
            when {
                url.isNullOrBlank() -> Unit
                item.mediaType == "image" -> {
                    holder.binding.mediaImageFrame.visibility = View.VISIBLE
                    holder.binding.mediaImageFrame.setOnClickListener { onOpenMedia(url) }
                    bindImageThumb(holder, url)
                }
                item.mediaType == "video" -> {
                    holder.binding.mediaImageFrame.visibility = View.VISIBLE
                    holder.binding.playOverlay.visibility = View.VISIBLE
                    holder.binding.mediaImageFrame.setOnClickListener { onOpenMedia(url) }
                    holder.binding.mediaChip.visibility = View.VISIBLE
                    holder.binding.mediaChip.text = durationLabel(ctx, item.durationMs, R.string.chat_media_video)
                    styleChip(holder, ctx, mine)
                    bindVideoThumb(holder, url)
                }
                item.mediaType == "audio" -> {
                    holder.binding.voiceRow.visibility = View.VISIBLE
                    holder.binding.voiceDuration.text = durationLabel(ctx, item.durationMs, R.string.chat_media_audio)
                    holder.binding.voiceDuration.setTextColor(secondary)
                    val playing = notePlayer.isPlaying(url)
                    holder.binding.voicePlayBtn.setImageResource(
                        if (playing) R.drawable.ic_chat_pause else R.drawable.ic_chat_play
                    )
                    val toggle = View.OnClickListener {
                        notePlayer.toggle(
                            url,
                            onStateChanged = { isPlaying ->
                                holder.binding.voicePlayBtn.setImageResource(
                                    if (isPlaying) R.drawable.ic_chat_pause else R.drawable.ic_chat_play
                                )
                            },
                            onCompleted = { holder.binding.voicePlayBtn.setImageResource(R.drawable.ic_chat_play) }
                        )
                    }
                    holder.binding.voicePlayBtn.setOnClickListener(toggle)
                    holder.binding.voiceRow.setOnClickListener(toggle)
                }
                else -> {
                    holder.binding.mediaChip.visibility = View.VISIBLE
                    holder.binding.mediaChip.text = ctx.getString(R.string.chat_media_generic)
                    styleChip(holder, ctx, mine)
                    bubble.setOnClickListener { onOpenMedia(url) }
                }
            }

            holder.binding.messageRow.updatePadding(
                left = if (mine) dp(48, ctx) else 0,
                right = if (mine) 0 else dp(48, ctx)
            )
        }

        private fun bindImageThumb(holder: VH, url: String) {
            holder.binding.mediaImage.tag = url
            imageThumbCache[url]?.let {
                holder.binding.mediaImage.setImageBitmap(it)
                return
            }
            scope().launch {
                val bmp = ChatMedia.loadImageThumb(url)
                if (bmp != null) imageThumbCache[url] = bmp
                if (holder.binding.mediaImage.tag == url && bmp != null) {
                    holder.binding.mediaImage.setImageBitmap(bmp)
                }
            }
        }

        private fun bindVideoThumb(holder: VH, url: String) {
            holder.binding.mediaImage.tag = url
            videoThumbCache[url]?.let {
                holder.binding.mediaImage.setImageBitmap(it)
                return
            }
            scope().launch {
                val bmp = ChatMedia.loadVideoThumb(url)
                if (bmp != null) videoThumbCache[url] = bmp
                if (holder.binding.mediaImage.tag == url && bmp != null) {
                    holder.binding.mediaImage.setImageBitmap(bmp)
                }
            }
        }

        private fun durationLabel(ctx: android.content.Context, durationMs: Long?, fallback: Int): String {
            if (durationMs == null || durationMs <= 0) return ctx.getString(fallback)
            val totalSeconds = TimeUnit.MILLISECONDS.toSeconds(durationMs)
            val m = totalSeconds / 60
            val s = totalSeconds % 60
            val prefix = if (fallback == R.string.chat_media_video) "Video" else "Voice note"
            return String.format(Locale.US, "%s · %d:%02d", prefix, m, s)
        }

        private fun styleChip(holder: VH, ctx: android.content.Context, mine: Boolean) {
            if (mine) {
                holder.binding.mediaChip.setBackgroundColor(Color.argb(40, 255, 255, 255))
                holder.binding.mediaChip.setTextColor(Color.WHITE)
            } else {
                holder.binding.mediaChip.setBackgroundColor(
                    ContextCompat.getColor(ctx, R.color.brand_green_soft)
                )
                holder.binding.mediaChip.setTextColor(
                    ContextCompat.getColor(ctx, R.color.brand_green_dark)
                )
            }
        }

        private fun dp(value: Int, ctx: android.content.Context): Int =
            (value * ctx.resources.displayMetrics.density).toInt()

        class VH(val binding: ItemChatMessageBinding) : RecyclerView.ViewHolder(binding.root)
    }
}
