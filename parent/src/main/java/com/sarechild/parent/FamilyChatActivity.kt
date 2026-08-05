package com.sarechild.parent

import android.Manifest
import android.content.Intent
import android.graphics.Color
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.GravityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.LifecycleCoroutineScope
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.sarechild.parent.data.ParentRepository
import com.sarechild.parent.databinding.ActivityFamilyChatBinding
import com.sarechild.parent.databinding.ItemChatDeviceBinding
import com.sarechild.parent.databinding.ItemChatMessageBinding
import com.sarechild.shared.ChatMedia
import com.sarechild.shared.ChatNotePlayer
import com.sarechild.shared.DeviceStatus
import com.sarechild.shared.FamilyChatMessage
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.math.max

/**
 * Every paired device has its own private conversation — this screen never merges devices into
 * one shared thread. The right-hand drawer lists each device with an unread badge; selecting one
 * swaps [selectedDeviceId] and re-subscribes to just that device's `chatMessages` subcollection.
 */
class FamilyChatActivity : AppCompatActivity() {
    private lateinit var binding: ActivityFamilyChatBinding
    private val repo = ParentRepository()
    private var familyId: String? = null
    private var selectedDeviceId: String? = null
    private var pendingPreselectDeviceId: String? = null
    private var recorder: MediaRecorder? = null
    private var activeAudioFile: File? = null
    private var chatJob: Job? = null
    private val notePlayer = ChatNotePlayer()

    private val devices = mutableListOf<DeviceStatus>()
    private val unreadCounts = mutableMapOf<String, Int>()
    private val unreadJobs = mutableMapOf<String, Job>()

    private val rows = mutableListOf<FamilyChatMessage>()
    private val chatAdapter = ChatAdapter(
        rows,
        currentUserId = { repo.currentUserId },
        onOpenMedia = { url -> runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
        notePlayer = notePlayer,
        scope = { lifecycleScope }
    )

    private val deviceAdapter = DeviceAdapter(
        devices,
        selectedId = { selectedDeviceId },
        unreadFor = { id -> unreadCounts[id] ?: 0 },
        onSelect = { device -> selectDevice(device.id) }
    )

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) uploadPicked(uri, "image/jpeg", "image")
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
        applyKeyboardSafeInsets()

        binding.messages.layoutManager = LinearLayoutManager(this).apply { stackFromEnd = true }
        binding.messages.adapter = chatAdapter
        binding.deviceList.layoutManager = LinearLayoutManager(this)
        binding.deviceList.adapter = deviceAdapter
        updateHeaderForSelection()
        updateEmptyState()

        binding.openDevices.setOnClickListener { binding.chatDrawerRoot.openDrawer(GravityCompat.END) }
        binding.sendText.setOnClickListener { sendCurrentText() }
        binding.input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendCurrentText()
                true
            } else {
                false
            }
        }
        binding.sendImage.setOnClickListener {
            if (selectedDeviceId != null) pickImage.launch("image/*") else toastPickDeviceFirst()
        }
        binding.sendVoice.setOnClickListener {
            if (selectedDeviceId == null) {
                toastPickDeviceFirst()
            } else if (recorder == null) {
                startVoiceRecording()
            } else {
                stopAndSendVoice()
            }
        }

        pendingPreselectDeviceId = intent.getStringExtra(SareChildConstants.EXTRA_CHAT_DEVICE_ID)

        lifecycleScope.launch {
            runCatching { repo.getFamilyId() }
                .onSuccess { fid ->
                    familyId = fid
                    launch {
                        repo.observeDevices(fid).collectLatest { list ->
                            devices.clear()
                            devices.addAll(list.sortedBy { it.childName.lowercase(Locale.getDefault()) })
                            deviceAdapter.notifyDataSetChanged()
                            syncUnreadJobs(fid)
                            if (selectedDeviceId == null || devices.none { it.id == selectedDeviceId }) {
                                val preselect = pendingPreselectDeviceId
                                pendingPreselectDeviceId = null
                                val target = preselect?.let { pid -> devices.find { it.id == pid } }
                                    ?: devices.firstOrNull()
                                target?.let { selectDevice(it.id) }
                            }
                            updateHeaderForSelection()
                            updateEmptyState()
                        }
                    }
                }
        }
    }

    private fun toastPickDeviceFirst() {
        Toast.makeText(this, getString(R.string.chat_select_device_title), Toast.LENGTH_SHORT).show()
    }

    private fun syncUnreadJobs(fid: String) {
        val currentIds = devices.map { it.id }.toSet()
        unreadJobs.keys.filter { it !in currentIds }.forEach { id ->
            unreadJobs.remove(id)?.cancel()
            unreadCounts.remove(id)
        }
        currentIds.filter { it !in unreadJobs }.forEach { id ->
            unreadJobs[id] = lifecycleScope.launch {
                repo.observeDeviceChatUnreadCount(fid, id).collectLatest { count ->
                    unreadCounts[id] = count
                    deviceAdapter.notifyDataSetChanged()
                }
            }
        }
    }

    private fun selectDevice(deviceId: String) {
        if (selectedDeviceId != deviceId) {
            selectedDeviceId = deviceId
            chatJob?.cancel()
            rows.clear()
            chatAdapter.notifyDataSetChanged()
            updateHeaderForSelection()
            updateEmptyState()
            val fid = familyId
            if (fid != null) {
                chatJob = lifecycleScope.launch {
                    repo.observeDeviceChat(fid, deviceId).collectLatest { list ->
                        rows.clear()
                        rows.addAll(list)
                        chatAdapter.notifyDataSetChanged()
                        updateEmptyState()
                        if (rows.isNotEmpty()) {
                            binding.messages.scrollToPosition(rows.lastIndex)
                        }
                        launch { runCatching { repo.markDeviceChatRead(fid, deviceId) } }
                    }
                }
            }
            deviceAdapter.notifyDataSetChanged()
        }
        binding.chatDrawerRoot.closeDrawer(GravityCompat.END)
    }

    private fun updateHeaderForSelection() {
        val device = devices.find { it.id == selectedDeviceId }
        binding.title.text = device?.childName ?: getString(R.string.chat_select_device_title)
        binding.presence.text = when {
            device == null -> getString(R.string.chat_select_device_subtitle)
            device.chatOnline && System.currentTimeMillis() - device.chatLastSeenMs < 120_000L ->
                getString(R.string.chat_presence_online_now)
            device.chatLastSeenMs > 0L -> "Last seen ${relativeTime(device.chatLastSeenMs)}"
            else -> getString(R.string.chat_presence_offline)
        }
    }

    private fun relativeTime(atMs: Long): String {
        val now = System.currentTimeMillis()
        val diff = now - atMs
        if (diff < 0 || diff > 7L * 24 * 60 * 60 * 1000) {
            return SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(Date(atMs))
        }
        return DateUtils.getRelativeTimeSpanString(
            atMs, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE
        ).toString()
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
        val fid = familyId ?: return
        val did = selectedDeviceId ?: return toastPickDeviceFirst()
        val text = binding.input.text?.toString()?.trim().orEmpty()
        if (text.isBlank()) return
        lifecycleScope.launch {
            runCatching { repo.sendDeviceChatMessage(fid, did, text = text) }
            binding.input.setText("")
        }
    }

    private fun updateEmptyState() {
        val empty = rows.isEmpty()
        binding.emptyState.visibility = if (empty) View.VISIBLE else View.GONE
        binding.messages.visibility = if (empty) View.INVISIBLE else View.VISIBLE
        binding.emptyTitle.text = if (selectedDeviceId == null) {
            getString(R.string.chat_select_device_title)
        } else {
            getString(R.string.chat_empty_title)
        }
        binding.emptySubtitle.text = if (selectedDeviceId == null) {
            getString(R.string.chat_select_device_subtitle)
        } else {
            getString(R.string.chat_empty_subtitle)
        }
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch { runCatching { repo.setGuardianChatPresence(true) } }
    }

    override fun onStop() {
        super.onStop()
        lifecycleScope.launch { runCatching { repo.setGuardianChatPresence(false) } }
    }

    override fun onDestroy() {
        stopRecorderOnly()
        notePlayer.release()
        super.onDestroy()
    }

    private fun uploadPicked(uri: Uri, contentType: String, mediaType: String) {
        val fid = familyId ?: return
        val did = selectedDeviceId ?: return
        lifecycleScope.launch {
            runCatching {
                val file = File(cacheDir, "chat_${System.currentTimeMillis()}")
                contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(file).use { out -> input.copyTo(out) }
                }
                val (path, url) = repo.uploadChatMedia(did, file, contentType)
                repo.sendDeviceChatMessage(fid, did, mediaUrl = url, mediaPath = path, mediaType = mediaType)
                file.delete()
            }.onFailure {
                Toast.makeText(this@FamilyChatActivity, "Couldn't send — try again", Toast.LENGTH_SHORT).show()
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
        binding.voiceStatus.visibility = View.VISIBLE
        binding.voiceStatus.text = getString(R.string.chat_recording)
        binding.sendVoice.alpha = 0.55f
    }

    private fun stopAndSendVoice() {
        val fid = familyId ?: return
        val did = selectedDeviceId ?: return
        val file = activeAudioFile
        stopRecorderOnly()
        binding.voiceStatus.visibility = View.GONE
        binding.sendVoice.alpha = 1f
        if (file == null || !file.exists()) return
        val durationMs = readMediaDurationMs(file)
        lifecycleScope.launch {
            runCatching {
                val (path, url) = repo.uploadChatMedia(did, file, "audio/mp4")
                repo.sendDeviceChatMessage(
                    fid, did, mediaUrl = url, mediaPath = path, mediaType = "audio", durationMs = durationMs
                )
            }.onFailure {
                Toast.makeText(this@FamilyChatActivity, "Couldn't send — try again", Toast.LENGTH_SHORT).show()
            }
            file.delete()
        }
    }

    private fun readMediaDurationMs(file: File): Long? = runCatching {
        val retriever = android.media.MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            retriever.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        } finally {
            retriever.release()
        }
    }.getOrNull()

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

    private class DeviceAdapter(
        private val items: List<DeviceStatus>,
        private val selectedId: () -> String?,
        private val unreadFor: (String) -> Int,
        private val onSelect: (DeviceStatus) -> Unit
    ) : RecyclerView.Adapter<DeviceAdapter.VH>() {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val binding = ItemChatDeviceBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            return VH(binding)
        }

        override fun getItemCount(): Int = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = items[position]
            val ctx = holder.binding.root.context
            val selected = item.id == selectedId()
            holder.binding.deviceRow.setBackgroundResource(
                if (selected) R.drawable.bg_device_row_selected else android.R.color.transparent
            )
            holder.binding.deviceName.text = item.childName
            val online = item.chatOnline && System.currentTimeMillis() - item.chatLastSeenMs < 120_000L
            holder.binding.onlineDot.background = ContextCompat.getDrawable(ctx, R.drawable.shape_dot)?.apply {
                setTint(ContextCompat.getColor(ctx, if (online) R.color.status_online else R.color.status_offline))
            }
            holder.binding.deviceSubtitle.text = ctx.getString(
                if (online) R.string.chat_presence_online_now else R.string.chat_presence_offline
            )
            val unread = unreadFor(item.id)
            if (unread > 0) {
                holder.binding.unreadBadge.visibility = View.VISIBLE
                holder.binding.unreadBadge.text = if (unread > 99) "99+" else unread.toString()
            } else {
                holder.binding.unreadBadge.visibility = View.GONE
            }
            holder.binding.deviceRow.setOnClickListener { onSelect(item) }
        }

        class VH(val binding: ItemChatDeviceBinding) : RecyclerView.ViewHolder(binding.root)
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
                    holder.binding.mediaChip.text = durationLabel(ctx, item.durationMs, isVideo = true)
                    styleChip(holder, ctx, mine)
                    bindVideoThumb(holder, url)
                }
                item.mediaType == "audio" -> {
                    holder.binding.voiceRow.visibility = View.VISIBLE
                    holder.binding.voiceDuration.text = durationLabel(ctx, item.durationMs, isVideo = false)
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

        private fun durationLabel(ctx: android.content.Context, durationMs: Long?, isVideo: Boolean): String {
            val prefix = if (isVideo) ctx.getString(R.string.chat_media_video) else ctx.getString(R.string.chat_media_audio)
            if (durationMs == null || durationMs <= 0) return prefix
            val totalSeconds = TimeUnit.MILLISECONDS.toSeconds(durationMs)
            val m = totalSeconds / 60
            val s = totalSeconds % 60
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
