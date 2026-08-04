package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.view.animation.AlphaAnimation
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityPermissionsBinding
import com.sarechild.child.monitoring.EventRecorderMonitor
import com.sarechild.child.monitoring.FeatureAccessGate
import com.sarechild.child.monitoring.MessageMonitorAccessibilityService
import com.sarechild.child.monitoring.MonitoringForegroundService
import com.sarechild.child.monitoring.NotificationMonitorService
import com.sarechild.child.monitoring.PhotoGallerySync
import com.sarechild.child.monitoring.UsageMonitorHelper
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

/**
 * "Enable Protections" — the ONE place in the child app where any permission,
 * OS system access, or SareChild consent flag is turned on. Every row here either:
 *  - fires the real Android runtime-permission sheet, or
 *  - deep-links to the relevant system Settings screen, or
 *  - (for our own app-level consent, e.g. "watch WhatsApp for unknown contacts")
 *    just flips a local switch on this page — never a separate pop-up screen.
 *
 * Nothing else in this app shows an Accept/Allow/Decline UI of its own. Parent-triggered
 * commands (see CommandListener) either complete silently when everything here is already
 * granted, or bring the user straight back to this page with the relevant row highlighted.
 */
class PermissionsActivity : AppCompatActivity() {
    private lateinit var binding: ActivityPermissionsBinding
    private lateinit var repo: ChildRepository
    private var items: List<ProtectionItem> = emptyList()
    private var highlightedId: String? = null
    private var highlightCommandId: String? = null
    private var highlightAutoFired = false
    private var completedHighlightCommand = false

    private data class ProtectionItem(
        val id: String,
        val container: () -> LinearLayout,
        val iconRes: Int,
        val accentSoft: Int,
        val accentDark: Int,
        val title: String,
        val subtitle: String,
        val isReady: () -> Boolean,
        val perform: () -> Unit
    )

    private val requestSinglePermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refresh() }

    private val requestMultiplePermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { refresh() }

    private val enableDeviceAdmin = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        lifecycleScope.launch { runCatching { repo.updateLockScreenStatus(this@PermissionsActivity) } }
        refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPermissionsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)

        binding.btnAllowAll.setOnClickListener { allowAllRemaining() }
        binding.btnStart.setOnClickListener {
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
            MonitoringForegroundService.start(this)
            startActivity(Intent(this, HomeActivity::class.java))
            finish()
        }

        items = buildItems()
        applyIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        highlightAutoFired = false
        completedHighlightCommand = false
        applyIntent(intent)
        refresh()
    }

    private fun applyIntent(intent: Intent) {
        highlightedId = intent.getStringExtra(SareChildConstants.EXTRA_HIGHLIGHT_ITEM_ID)
        highlightCommandId = intent.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID)
    }

    override fun onResume() {
        super.onResume()
        MonitoringForegroundService.start(this)
        refresh()
        maybeAutoFireHighlight()
    }

    // ---- Building the capability list -------------------------------------------------

    private fun buildItems(): List<ProtectionItem> {
        val sky = binding.sectionMonitoring
        val sun = binding.sectionCommunication
        val coral = binding.sectionLive
        val grass = binding.sectionDevice

        return listOf(
            // Monitoring ------------------------------------------------------------------
            ProtectionItem(
                id = "whatsapp",
                container = { sky },
                iconRes = R.drawable.ic_row_whatsapp,
                accentSoft = R.color.sky_soft,
                accentDark = R.color.sky_blue_dark,
                title = "WhatsApp protection",
                subtitle = "Flags risky messages, calls & media from unknown contacts",
                isReady = { FeatureAccessGate.isWhatsAppProtectionReady(this, repo) },
                perform = { enableWhatsApp() }
            ),
            ProtectionItem(
                id = "event_recorder",
                container = { sky },
                iconRes = R.drawable.ic_row_clock,
                accentSoft = R.color.sky_soft,
                accentDark = R.color.sky_blue_dark,
                title = "Activity timeline",
                subtitle = "Apps used, idle time, media titles — needs Usage access",
                isReady = { FeatureAccessGate.isEventRecorderReady(this, repo) },
                perform = { enableEventRecorder() }
            ),
            ProtectionItem(
                id = "photo_gallery",
                container = { sky },
                iconRes = R.drawable.ic_row_photo,
                accentSoft = R.color.sky_soft,
                accentDark = R.color.sky_blue_dark,
                title = "Photo gallery",
                subtitle = "Shares gallery thumbnails so your parent can spot trouble",
                isReady = { FeatureAccessGate.isPhotoGalleryReady(this, repo) },
                perform = { enablePhotoGallery() }
            ),
            ProtectionItem(
                id = "call_recording",
                container = { sky },
                iconRes = R.drawable.ic_row_call,
                accentSoft = R.color.sky_soft,
                accentDark = R.color.sky_blue_dark,
                title = "Call recording",
                subtitle = "Best-effort recording of calls, visible while active",
                isReady = { FeatureAccessGate.isCallRecordingReady(this, repo) },
                perform = { enableCallRecording() }
            ),
            ProtectionItem(
                id = "call_sms",
                container = { sky },
                iconRes = R.drawable.ic_row_sms,
                accentSoft = R.color.sky_soft,
                accentDark = R.color.sky_blue_dark,
                title = "Call & SMS summaries",
                subtitle = "Recent call and text summaries — not full message content",
                isReady = { FeatureAccessGate.isCallSmsReady(this, repo) },
                perform = { enableCallSms() }
            ),
            ProtectionItem(
                id = "usage_access",
                container = { sky },
                iconRes = R.drawable.ic_row_chart,
                accentSoft = R.color.sky_soft,
                accentDark = R.color.sky_blue_dark,
                title = "Screen time & usage access",
                subtitle = "Daily app time and scheduled app blocks",
                isReady = { FeatureAccessGate.isUsageAccessReady(this, repo) },
                perform = { enableUsageAccess() }
            ),
            ProtectionItem(
                id = "app_installs",
                container = { sky },
                iconRes = R.drawable.ic_row_apps,
                accentSoft = R.color.sky_soft,
                accentDark = R.color.sky_blue_dark,
                title = "App install alerts",
                subtitle = "Notifies your parent when apps are installed or removed",
                isReady = { repo.installMonitorConsent },
                perform = { setConsent { repo.installMonitorConsent = true } }
            ),
            // Communication safety ----------------------------------------------------------
            ProtectionItem(
                id = "typing_safety",
                container = { sun },
                iconRes = R.drawable.ic_row_sms,
                accentSoft = R.color.sun_soft,
                accentDark = R.color.sunny_yellow_dark,
                title = "Typing safety / message shield",
                subtitle = "Scans on-screen text for risk words — needs Accessibility",
                isReady = { FeatureAccessGate.isTypingSafetyReady(this, repo) },
                perform = { enableTypingSafety() }
            ),
            ProtectionItem(
                id = "notification_access",
                container = { sun },
                iconRes = R.drawable.ic_bell_ring,
                accentSoft = R.color.sun_soft,
                accentDark = R.color.sunny_yellow_dark,
                title = "Notification access",
                subtitle = "Lets SareChild scan message previews for risk words",
                isReady = { FeatureAccessGate.isNotificationAccessReady(this) },
                perform = { openNotificationAccessSettings() }
            ),
            ProtectionItem(
                id = "push_notifications",
                container = { sun },
                iconRes = R.drawable.ic_bell_ring,
                accentSoft = R.color.sun_soft,
                accentDark = R.color.sunny_yellow_dark,
                title = "Alert notifications",
                subtitle = "So this phone can show SareChild's own safety alerts",
                isReady = { FeatureAccessGate.isPushNotificationReady(this) },
                perform = { requestPushNotifications() }
            ),
            // Live safety --------------------------------------------------------------------
            ProtectionItem(
                id = "screen",
                container = { coral },
                iconRes = R.drawable.ic_row_screen,
                accentSoft = R.color.coral_soft,
                accentDark = R.color.coral_dark,
                title = "Screen sharing & live view",
                subtitle = "Android shows a one-time confirmation each time a session starts",
                isReady = { FeatureAccessGate.isScreenShareReady(repo) },
                perform = { setConsent { repo.screenShareConsent = true } }
            ),
            ProtectionItem(
                id = "camera",
                container = { coral },
                iconRes = R.drawable.ic_camera_friendly,
                accentSoft = R.color.coral_soft,
                accentDark = R.color.coral_dark,
                title = "Camera safety check & live video",
                subtitle = "Only used with a visible on-screen notification",
                isReady = { FeatureAccessGate.isCameraCheckReady(this, repo) },
                perform = { enableCamera() }
            ),
            ProtectionItem(
                id = "mic",
                container = { coral },
                iconRes = R.drawable.ic_mic_friendly,
                accentSoft = R.color.coral_soft,
                accentDark = R.color.coral_dark,
                title = "Microphone check & live audio",
                subtitle = "Only used with a visible on-screen notification",
                isReady = { FeatureAccessGate.isMicCheckReady(this, repo) },
                perform = { enableMic() }
            ),
            // Device control -----------------------------------------------------------------
            ProtectionItem(
                id = "location",
                container = { grass },
                iconRes = R.drawable.ic_row_location,
                accentSoft = R.color.mint_soft,
                accentDark = R.color.grass_green_dark,
                title = "Location",
                subtitle = "So your parent can see this phone on the map",
                isReady = { FeatureAccessGate.isLocationReady(this) },
                perform = { requestLocation() }
            ),
            ProtectionItem(
                id = "device_admin",
                container = { grass },
                iconRes = R.drawable.ic_lock_soft,
                accentSoft = R.color.mint_soft,
                accentDark = R.color.grass_green_dark,
                title = "Device Administrator",
                subtitle = "Lets your parent remotely lock this phone's normal screen",
                isReady = { FeatureAccessGate.isDeviceAdminReady(this) },
                perform = { enableDeviceAdmin.launch(DeviceAdminHelper.createEnableAdminIntent(this)) }
            ),
            ProtectionItem(
                id = "battery",
                container = { grass },
                iconRes = R.drawable.ic_row_battery,
                accentSoft = R.color.mint_soft,
                accentDark = R.color.grass_green_dark,
                title = "Background activity",
                subtitle = "Keeps protection running when the screen is off",
                isReady = { FeatureAccessGate.isBatteryOptimizationReady(this) },
                perform = { openBatterySettings() }
            )
        )
    }

    // ---- Row actions (system-only: permission sheets or Settings deep-links) ----------

    private fun setConsent(apply: () -> Unit) {
        apply()
        lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
        MonitoringForegroundService.start(this)
        refresh()
    }

    private fun enableWhatsApp() {
        if (!repo.whatsappMonitorConsent || !repo.messageMonitorConsent) {
            repo.whatsappMonitorConsent = true
            repo.messageMonitorConsent = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
            MonitoringForegroundService.start(this)
        }
        if (!NotificationMonitorService.isEnabled(this)) {
            openNotificationAccessSettings()
            return
        }
        if (!hasMediaPermission()) {
            requestMediaPermissions()
            return
        }
        refresh()
    }

    private fun enableEventRecorder() {
        if (!repo.eventRecorderConsent) {
            repo.eventRecorderConsent = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
            MonitoringForegroundService.start(this)
        }
        if (!UsageMonitorHelper.hasUsageAccess(this)) {
            UsageMonitorHelper.openUsageSettings(this)
            return
        }
        lifecycleScope.launch {
            runCatching {
                val monitor = EventRecorderMonitor(this@PermissionsActivity, repo)
                monitor.start()
                monitor.sync(force = true)
            }
            refresh()
        }
    }

    private fun enablePhotoGallery() {
        if (!repo.photoGalleryConsent) {
            repo.photoGalleryConsent = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
            MonitoringForegroundService.start(this)
        }
        if (!PhotoGallerySync.hasPhotoPermission(this)) {
            requestMediaPermissions()
            return
        }
        lifecycleScope.launch {
            runCatching { PhotoGallerySync(this@PermissionsActivity, repo).sync(forceFull = true) }
            refresh()
        }
    }

    private fun enableCallRecording() {
        if (!repo.callRecordingConsent || !repo.callRecordingEnabled) {
            repo.callRecordingConsent = true
            repo.callRecordingEnabled = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
            MonitoringForegroundService.start(this)
        }
        val needed = mutableListOf<String>()
        if (!hasPerm(Manifest.permission.RECORD_AUDIO)) needed += Manifest.permission.RECORD_AUDIO
        if (!hasPerm(Manifest.permission.READ_PHONE_STATE)) needed += Manifest.permission.READ_PHONE_STATE
        if (needed.isNotEmpty()) {
            requestMultiplePermissions.launch(needed.toTypedArray())
            return
        }
        if (!NotificationMonitorService.isEnabled(this)) {
            openNotificationAccessSettings()
            return
        }
        refresh()
    }

    private fun enableCallSms() {
        if (!repo.callSmsConsent) {
            repo.callSmsConsent = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
        }
        val needed = listOf(
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_SMS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.CALL_PHONE
        ).filterNot { hasPerm(it) }
        if (needed.isNotEmpty()) {
            requestMultiplePermissions.launch(needed.toTypedArray())
        } else {
            refresh()
        }
    }

    private fun enableUsageAccess() {
        if (!repo.usageConsent) {
            repo.usageConsent = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
        }
        if (!UsageMonitorHelper.hasUsageAccess(this)) {
            UsageMonitorHelper.openUsageSettings(this)
        } else {
            refresh()
        }
    }

    private fun enableTypingSafety() {
        if (!repo.messageMonitorConsent) {
            repo.messageMonitorConsent = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
        }
        if (!MessageMonitorAccessibilityService.isServiceEnabled(this)) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } else {
            refresh()
        }
    }

    private fun enableCamera() {
        if (!repo.cameraCheckConsent) {
            repo.cameraCheckConsent = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
        }
        if (!hasPerm(Manifest.permission.CAMERA)) {
            requestSinglePermission.launch(Manifest.permission.CAMERA)
        } else {
            refresh()
        }
    }

    private fun enableMic() {
        if (!repo.micCheckConsent) {
            repo.micCheckConsent = true
            lifecycleScope.launch { runCatching { repo.syncConsentFlags() } }
        }
        if (!hasPerm(Manifest.permission.RECORD_AUDIO)) {
            requestSinglePermission.launch(Manifest.permission.RECORD_AUDIO)
        } else {
            refresh()
        }
    }

    private fun requestLocation() {
        val needed = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (!hasPerm(Manifest.permission.ACCESS_FINE_LOCATION) && !hasPerm(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            requestMultiplePermissions.launch(needed.toTypedArray())
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            hasPerm(Manifest.permission.ACCESS_FINE_LOCATION) &&
            !hasPerm(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        ) {
            requestSinglePermission.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            return
        }
        refresh()
    }

    private fun requestPushNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestSinglePermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun openNotificationAccessSettings() {
        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun openBatterySettings() {
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun requestMediaPermissions() {
        val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            arrayOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_AUDIO
            )
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        requestMultiplePermissions.launch(needed)
    }

    private fun hasMediaPermission(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        hasPerm(Manifest.permission.READ_MEDIA_IMAGES) ||
            hasPerm(Manifest.permission.READ_MEDIA_VIDEO) ||
            hasPerm(Manifest.permission.READ_MEDIA_AUDIO)
    } else {
        hasPerm(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    private fun hasPerm(perm: String): Boolean =
        ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED

    private fun allowAllRemaining() {
        val next = items.firstOrNull { !it.isReady() }
        if (next == null) {
            Toast.makeText(this, "Everything is already enabled — nice!", Toast.LENGTH_SHORT).show()
            return
        }
        next.perform()
    }

    // ---- Rendering ----------------------------------------------------------------------

    private fun refresh() {
        for (container in listOf(
            binding.sectionMonitoring,
            binding.sectionCommunication,
            binding.sectionLive,
            binding.sectionDevice
        )) {
            container.removeAllViews()
        }
        items.forEach { item -> renderRow(item) }

        val total = items.size
        val enabled = items.count { it.isReady() }
        val allDone = enabled == total
        binding.heroStatus.text = if (allDone) "Protected" else "Setup needed"
        binding.heroSubtitle.text = if (allDone) {
            "Every protection is on. Great job!"
        } else {
            "${total - enabled} item(s) still need your OK"
        }
        binding.heroProgress.progress = if (total == 0) 100 else (enabled * 100 / total)
        binding.heroCount.text = "$enabled of $total enabled"
        binding.btnAllowAll.visibility = if (allDone) View.GONE else View.VISIBLE

        maybeCompleteHighlightedCommand()
    }

    private fun renderRow(item: ProtectionItem) {
        val container = item.container()
        val row = layoutInflater.inflate(R.layout.item_protection_row, container, false)
        val badge = row.findViewById<FrameLayout>(R.id.iconBadge)
        val icon = row.findViewById<ImageView>(R.id.icon)
        val title = row.findViewById<TextView>(R.id.title)
        val subtitle = row.findViewById<TextView>(R.id.subtitle)
        val chip = row.findViewById<TextView>(R.id.statusChip)

        val ready = item.isReady()
        badge.backgroundTintList = android.content.res.ColorStateList.valueOf(
            ContextCompat.getColor(this, item.accentSoft)
        )
        icon.setImageResource(item.iconRes)
        icon.setColorFilter(ContextCompat.getColor(this, item.accentDark))
        title.text = item.title
        subtitle.text = item.subtitle

        if (ready) {
            chip.text = "Allowed"
            chip.setTextColor(ContextCompat.getColor(this, R.color.grass_green_dark))
            chip.backgroundTintList = android.content.res.ColorStateList.valueOf(
                ContextCompat.getColor(this, R.color.mint_soft)
            )
            row.isClickable = false
            row.alpha = 0.92f
        } else {
            chip.text = "Needs setup"
            chip.setTextColor(ContextCompat.getColor(this, R.color.coral_dark))
            chip.backgroundTintList = android.content.res.ColorStateList.valueOf(
                ContextCompat.getColor(this, R.color.coral_soft)
            )
            row.isClickable = true
            row.alpha = 1f
            row.setOnClickListener { item.perform() }
        }

        if (item.id == highlightedId) {
            row.tag = "highlight"
        }

        container.addView(row)
    }

    private fun maybeAutoFireHighlight() {
        val id = highlightedId ?: return
        if (highlightAutoFired) return
        val item = items.firstOrNull { it.id == id } ?: return
        if (item.isReady()) return
        highlightAutoFired = true
        binding.scrollRoot.post {
            findHighlightRow(item)?.let { flash(it) }
        }
        // Give the highlight flash a beat to render before jumping straight into the
        // system prompt this row represents.
        binding.scrollRoot.postDelayed({ if (!isFinishing) item.perform() }, 450L)
    }

    private fun findHighlightRow(item: ProtectionItem): View? {
        val container = item.container()
        for (i in 0 until container.childCount) {
            val child = container.getChildAt(i)
            if (child.tag == "highlight") return child
        }
        return null
    }

    private fun flash(view: View) {
        val anim = AlphaAnimation(1f, 0.35f).apply {
            duration = 220
            repeatCount = 3
            repeatMode = AlphaAnimation.REVERSE
        }
        view.startAnimation(anim)
    }

    private fun maybeCompleteHighlightedCommand() {
        val commandId = highlightCommandId ?: return
        if (completedHighlightCommand) return
        val id = highlightedId ?: return
        val item = items.firstOrNull { it.id == id } ?: return
        if (!item.isReady()) return
        completedHighlightCommand = true
        lifecycleScope.launch {
            runCatching { repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED) }
        }
    }
}
