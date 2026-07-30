package com.sarechild.parent

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.tabs.TabLayout
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.sarechild.parent.data.ParentRepository
import com.sarechild.parent.data.LocationTrailSample
import com.sarechild.parent.data.UsageDailySummary
import com.sarechild.parent.databinding.ActivityDashboardBinding
import com.sarechild.parent.databinding.ItemCardBinding
import com.sarechild.parent.databinding.TabListBinding
import com.sarechild.parent.databinding.TabPairBinding
import com.sarechild.shared.AppBlockSchedule
import com.sarechild.shared.AppLimit
import com.sarechild.shared.CallSmsPreview
import com.sarechild.shared.DeviceStatus
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.FamilySafetySettings
import com.sarechild.shared.GeofenceZone
import com.sarechild.shared.GuardianInfo
import com.sarechild.shared.SafetyCommand
import com.sarechild.shared.SafetyCommandType
import com.sarechild.shared.ScreenShareSchedule
import com.sarechild.shared.SafeContact
import com.sarechild.shared.SareChildConstants
import com.sarechild.shared.SosContact
import com.sarechild.shared.WeeklyDigest
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

class DashboardActivity : AppCompatActivity() {
    private lateinit var binding: ActivityDashboardBinding
    private val repo = ParentRepository()
    private var familyId: String? = null
    private var collectJob: Job? = null
    private var devices: List<DeviceStatus> = emptyList()
    private var alerts: List<FamilyAlert> = emptyList()
    private var geofences: List<GeofenceZone> = emptyList()
    private var commands: List<SafetyCommand> = emptyList()
    private var usageDaily: List<UsageDailySummary> = emptyList()
    private var locationTrail: List<LocationTrailSample> = emptyList()
    private var appLimits: List<AppLimit> = emptyList()
    private var appBlockSchedules: List<AppBlockSchedule> = emptyList()
    private var callSmsPreviews: List<CallSmsPreview> = emptyList()
    private var digests: List<WeeklyDigest> = emptyList()
    private var guardians: List<GuardianInfo> = emptyList()
    private var safeContacts: List<SafeContact> = emptyList()
    private var safetySettings: FamilySafetySettings = FamilySafetySettings()
    private var screenShareSchedules: List<ScreenShareSchedule> = emptyList()
    private var screenShareDurationMinutes = 10

    private val tabTitles = listOf("Devices", "Alerts", "Safety", "Usage", "Chat", "Digests", "Guardians", "Geofences", "Pair")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDashboardBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.toolbar.inflateMenu(R.menu.dashboard_menu)
        binding.toolbar.setOnMenuItemClickListener {
            if (it.itemId == R.id.action_sign_out) {
                repo.signOut()
                startActivity(Intent(this, AuthActivity::class.java))
                finish()
                true
            } else false
        }

        tabTitles.forEach { binding.tabs.addTab(binding.tabs.newTab().setText(it)) }
        binding.tabs.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) = showTab(tab.position)
            override fun onTabUnselected(tab: TabLayout.Tab) {}
            override fun onTabReselected(tab: TabLayout.Tab) {}
        })
        binding.tabs.visibility = View.GONE

        lifecycleScope.launch {
            runCatching { repo.ensureKeywordListSeeded() }
            runCatching { repo.getFamilyId() }
                .onSuccess {
                    familyId = it
                    binding.tabs.visibility = View.VISIBLE
                    showTab(0)
                    observe(it)
                }
                .onFailure {
                    showJoinFamilyPrompt(it.message)
                }
        }
    }

    private fun showJoinFamilyPrompt(error: String?) {
        val container = binding.content
        container.removeAllViews()
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        root.addView(
            TextView(this).apply {
                text = "No family found on this account"
                textSize = 20f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
        )
        root.addView(
            TextView(this).apply {
                text = "If you're a caregiver, ask the family owner for an invite code and enter it below."
                setPadding(0, dp(8), 0, dp(16))
            }
        )
        if (!error.isNullOrBlank()) {
            root.addView(TextView(this).apply { text = error; setTextColor(0xFFB3261E.toInt()) })
        }
        val codeInput = addTextInput(root, "Invite code")
        val status = TextView(this).apply { setPadding(0, dp(8), 0, 0) }
        root.addView(
            MaterialButton(this).apply {
                text = "Accept invite"
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).also { it.topMargin = dp(12) }
                setOnClickListener {
                    val code = codeInput.text?.toString().orEmpty()
                    lifecycleScope.launch {
                        repo.acceptGuardianInvite(code)
                            .onSuccess { fid ->
                                familyId = fid
                                binding.tabs.visibility = View.VISIBLE
                                showTab(0)
                                observe(fid)
                            }
                            .onFailure { status.text = it.message }
                    }
                }
            }
        )
        root.addView(status)
    }

    private fun observe(familyId: String) {
        collectJob?.cancel()
        collectJob = lifecycleScope.launch {
            launch {
                repo.observeDevices(familyId).collectLatest {
                    devices = it
                    if (binding.tabs.selectedTabPosition in listOf(0, 2)) showTab(binding.tabs.selectedTabPosition)
                }
            }
            launch {
                repo.observeAlerts(familyId).collectLatest {
                    alerts = it
                    if (binding.tabs.selectedTabPosition == 1) showTab(1)
                }
            }
            launch {
                repo.observeCommands(familyId).collectLatest {
                    commands = it
                    if (binding.tabs.selectedTabPosition == 2) showTab(2)
                }
            }
            launch {
                repo.observeUsageDaily(familyId).collectLatest {
                    usageDaily = it
                    if (binding.tabs.selectedTabPosition == 3) showTab(3)
                }
            }
            launch {
                repo.observeLocationTrail(familyId).collectLatest {
                    locationTrail = it
                    if (binding.tabs.selectedTabPosition == 0) showTab(0)
                }
            }
            launch {
                repo.observeAppLimits(familyId).collectLatest {
                    appLimits = it
                    if (binding.tabs.selectedTabPosition == 3) showTab(3)
                }
            }
            launch {
                repo.observeAppBlockSchedules(familyId).collectLatest {
                    appBlockSchedules = it
                    if (binding.tabs.selectedTabPosition == 3) showTab(3)
                }
            }
            launch {
                repo.observeCallSms(familyId).collectLatest {
                    callSmsPreviews = it
                    if (binding.tabs.selectedTabPosition == 2) showTab(2)
                }
            }
            launch {
                repo.observeDigests(familyId).collectLatest {
                    digests = it
                    if (binding.tabs.selectedTabPosition == 5) showTab(5)
                }
            }
            launch {
                repo.observeGuardians(familyId).collectLatest {
                    guardians = it
                    if (binding.tabs.selectedTabPosition == 6) showTab(6)
                }
            }
            launch {
                repo.observeSafeContacts(familyId).collectLatest {
                    safeContacts = it
                    if (binding.tabs.selectedTabPosition == 6) showTab(6)
                }
            }
            launch {
                repo.observeSafetySettings(familyId).collectLatest {
                    safetySettings = it
                    if (binding.tabs.selectedTabPosition == 2) showTab(2)
                }
            }
            launch {
                repo.observeGeofences(familyId).collectLatest {
                    geofences = it
                    if (binding.tabs.selectedTabPosition == 7) showTab(7)
                }
            }
            launch {
                repo.observeScreenShareSchedules(familyId).collectLatest {
                    screenShareSchedules = it
                    if (binding.tabs.selectedTabPosition == 2) showTab(2)
                }
            }
        }
    }

    private fun showTab(index: Int) {
        val container = binding.content
        container.removeAllViews()
        when (index) {
            0 -> showDeviceList(container)
            1 -> showAlertList(container)
            2 -> showSafetyTab(container)
            3 -> showUsageTab(container)
            4 -> showChatTab(container)
            5 -> showDigestsTab(container)
            6 -> showGuardiansTab(container)
            7 -> showGeofenceList(container)
            8 -> showPairTab(container)
        }
    }

    private fun showChatTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())
        val childOnline = devices.count { it.chatOnline && System.currentTimeMillis() - it.chatLastSeenMs < 120_000L }
        val guardianOnline = guardians.count { it.chatOnline && System.currentTimeMillis() - it.lastSeenMs < 120_000L }
        root.addView(TextView(this).apply {
            text = "Family group chat"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "Children online: $childOnline · Guardians online: $guardianOnline"
            setPadding(0, dp(8), 0, dp(10))
        })
        root.addView(TextView(this).apply {
            text = "Share text, images, and voice notes with the child and all guardians."
        })
        root.addView(MaterialButton(this@DashboardActivity).apply {
            text = "Open live chat"
            setOnClickListener { startActivity(Intent(this@DashboardActivity, FamilyChatActivity::class.java)) }
        })
    }

    private fun showDeviceList(container: FrameLayout) {
        val listBinding = TabListBinding.inflate(layoutInflater, container, true)
        listBinding.list.layoutManager = LinearLayoutManager(this)
        listBinding.list.adapter = CardAdapter(
            devices.map { d ->
                CardRow(
                    title = d.childName,
                    subtitle = buildString {
                        append(if (d.online) "Online" else "Offline / went dark")
                        append(" · Battery ")
                        append(if (d.batteryPercent >= 0) "${d.batteryPercent}%" else "—")
                        append(if (d.charging) " (charging)" else "")
                        d.activeSession?.let { append(" · Session: $it") }
                    },
                    detail = buildString {
                        append(
                            d.lastLocation?.let {
                                "Location: ${"%.5f".format(it.lat)}, ${"%.5f".format(it.lng)}\n"
                            } ?: "No location yet\n"
                        )
                        append("Monitoring: ${d.monitoringActive} · Notif: ${d.notificationAccess}\n")
                        append("Screen time today: ${d.todayScreenMinutes} min\n")
                        if (d.batteryHistory.isNotEmpty()) {
                            append(
                                "Battery history: " +
                                    d.batteryHistory.takeLast(6).joinToString(" → ") { "${it.percent}%" } +
                                    "\n"
                            )
                        }
                        append(
                            "Consents — screen:${d.screenShareConsent} camera:${d.cameraCheckConsent} " +
                                "mic:${d.micCheckConsent} messages:${d.messageMonitorConsent}\n"
                        )
                        append(
                            "Consents — installs:${d.installMonitorConsent} usage:${d.usageConsent} " +
                                "callSms:${d.callSmsConsent} offlineSmsFallback:${d.offlineSmsFallbackConsent} " +
                                "offlineAutoCall:${d.offlineAutoCallConsent}"
                        )
                        val trail = locationTrail.filter { it.deviceId == d.id }.take(5)
                        if (trail.isNotEmpty()) {
                            append("\nRecent offline timeline points:")
                            trail.forEach { sample ->
                                val loc = sample.location
                                if (loc != null) {
                                    append(
                                        "\n- ${SimpleDateFormat("MMM d HH:mm", Locale.getDefault()).format(Date(sample.recordedAtMs))} " +
                                            "${"%.5f".format(loc.lat)}, ${"%.5f".format(loc.lng)}" +
                                            if (!sample.hadNetwork) " (captured offline)" else ""
                                    )
                                }
                            }
                        }
                        if (d.offlineCallEnabled) {
                            append(
                                "\nOffline auto-call: enabled to ${d.offlineCallNumber ?: "not set"} " +
                                    "(max attempts ${d.offlineCallMaxAttempts})"
                            )
                        }
                    },
                    action = d.lastLocation?.let { "Open map" },
                    onAction = d.lastLocation?.let { loc ->
                        {
                            val uri = Uri.parse("geo:${loc.lat},${loc.lng}?q=${loc.lat},${loc.lng}")
                            startActivity(Intent(Intent.ACTION_VIEW, uri))
                        }
                    }
                )
            }
        )
    }

    private fun showAlertList(container: FrameLayout) {
        val listBinding = TabListBinding.inflate(layoutInflater, container, true)
        val fmt = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())
        listBinding.list.layoutManager = LinearLayoutManager(this)
        listBinding.list.adapter = CardAdapter(
            alerts.map { a ->
                CardRow(
                    title = a.title,
                    subtitle = buildString {
                        append("${a.severity} · ${a.type}")
                        a.category?.let { append(" · $it") }
                        a.riskScore?.takeIf { it > 0 }?.let { append(" · risk $it") }
                    },
                    detail = listOfNotNull(a.snippet, fmt.format(Date(a.createdAtMs))).joinToString("\n"),
                    action = when {
                        !a.mediaUrl.isNullOrBlank() -> "Open media"
                        !a.read -> "Mark read"
                        else -> null
                    },
                    onAction = {
                        val fid = familyId ?: return@CardRow
                        if (!a.mediaUrl.isNullOrBlank()) {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(a.mediaUrl)))
                        }
                        if (!a.read) {
                            lifecycleScope.launch { runCatching { repo.markAlertRead(fid, a.id) } }
                        }
                    }
                )
            }
        )
    }

    private fun showSafetyTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        root.addView(
            TextView(this).apply {
                text = "Safety checks"
                textSize = 22f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
        )
        root.addView(
            TextView(this).apply {
                text =
                    "Requests appear on the child phone with Accept/Decline and an ongoing notification. " +
                        "Silent call recording and full WhatsApp/Telegram database dumps are not available " +
                        "(blocked by Android / Play for third-party apps)."
                setPadding(0, dp(8), 0, dp(16))
            }
        )
        root.addView(sectionHeader("Automation & safeguards"))
        val riskInput = addTextInput(
            root,
            "Escalation risk threshold (0-100)",
            InputType.TYPE_CLASS_NUMBER,
            safetySettings.escalationRiskThreshold.toString()
        )
        val checkInInput = addTextInput(
            root,
            "Check-in interval minutes",
            InputType.TYPE_CLASS_NUMBER,
            safetySettings.checkInIntervalMinutes.toString()
        )
        val alertRetentionInput = addTextInput(
            root,
            "Alert retention days",
            InputType.TYPE_CLASS_NUMBER,
            safetySettings.alertRetentionDays.toString()
        )
        val mediaRetentionInput = addTextInput(
            root,
            "Media retention days",
            InputType.TYPE_CLASS_NUMBER,
            safetySettings.mediaRetentionDays.toString()
        )
        val snoozeInput = addTextInput(
            root,
            "Snooze categories (comma separated, e.g. KEYWORD,WHATSAPP_CONTACT)",
            prefill = safetySettings.snoozedCategories.joinToString(",")
        )
        root.addView(
            MaterialButton(this).apply {
                text = "Save safety settings"
                setOnClickListener {
                    val fid = familyId ?: return@setOnClickListener
                    val settings = FamilySafetySettings(
                        escalationEnabled = true,
                        escalationRiskThreshold = riskInput.text?.toString()?.toIntOrNull() ?: 60,
                        autoLockOnCritical = true,
                        checkInIntervalMinutes = checkInInput.text?.toString()?.toIntOrNull() ?: 120,
                        snoozedCategories = snoozeInput.text?.toString().orEmpty()
                            .split(",")
                            .map { it.trim() }
                            .filter { it.isNotBlank() },
                        snoozeUntilMs = System.currentTimeMillis() + 60 * 60_000L,
                        alertRetentionDays = alertRetentionInput.text?.toString()?.toIntOrNull()
                            ?: SareChildConstants.ALERT_RETENTION_DAYS,
                        mediaRetentionDays = mediaRetentionInput.text?.toString()?.toIntOrNull()
                            ?: SareChildConstants.MEDIA_RETENTION_DAYS
                    )
                    lifecycleScope.launch {
                        runCatching { repo.setSafetySettings(fid, settings) }
                            .onSuccess { Toast.makeText(this@DashboardActivity, "Safety settings saved", Toast.LENGTH_SHORT).show() }
                            .onFailure { Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show() }
                    }
                }
            }
        )

        if (devices.isEmpty()) {
            root.addView(TextView(this).apply { text = "No paired devices yet. Use the Pair tab first." })
            return
        }

        devices.forEach { device ->
            root.addView(
                TextView(this).apply {
                    text = device.childName
                    textSize = 18f
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                    setPadding(0, dp(12), 0, dp(4))
                }
            )
            root.addView(
                TextView(this).apply {
                    text = buildString {
                        append(if (device.online) "Online" else "Offline")
                        append(if (device.charging) " · Charging" else "")
                        append(" · Session: ${device.activeSession ?: "none"}")
                        append("\nConsent screen=${device.screenShareConsent} camera=${device.cameraCheckConsent} ")
                        append("mic=${device.micCheckConsent} messages=${device.messageMonitorConsent}")
                    }
                }
            )
            if (!device.latestFrameUrl.isNullOrBlank()) {
                root.addView(
                    MaterialButton(this).apply {
                        text = "Open latest screen frame"
                        setOnClickListener {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(device.latestFrameUrl)))
                        }
                    }
                )
            }
            root.addView(
                TextView(this).apply {
                    text = "Screen share duration: ${screenShareDurationMinutes} min (tap to change)"
                    setPadding(0, dp(4), 0, dp(4))
                    setOnClickListener {
                        screenShareDurationMinutes = when (screenShareDurationMinutes) {
                            5 -> 10
                            10 -> 15
                            15 -> 30
                            30 -> 60
                            else -> 5
                        }
                        showTab(2)
                    }
                }
            )
            root.addView(
                requestScreenShareButton(device)
            )
            root.addView(requestButton("Request camera photo", device, SafetyCommandType.CAMERA_CHECK))
            root.addView(requestButton("Request voice check (10s)", device, SafetyCommandType.MIC_CHECK))
            root.addView(requestButton("Stop screen share", device, SafetyCommandType.STOP_SCREEN_SHARE))
            root.addView(requestButton("Ring device", device, SafetyCommandType.RING_DEVICE))
            root.addView(requestButton("Lock device", device, SafetyCommandType.LOCK_DEVICE))
            root.addView(requestButton("Unlock device", device, SafetyCommandType.UNLOCK_DEVICE))
            root.addView(requestButton("Sync call/SMS summary", device, SafetyCommandType.SYNC_CALL_SMS))
        }

        if (screenShareSchedules.isNotEmpty()) {
            root.addView(
                TextView(this).apply {
                    text = "Scheduled screen shares"
                    textSize = 16f
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                    setPadding(0, dp(20), 0, dp(8))
                }
            )
            screenShareSchedules.forEach { s ->
                val deviceName = devices.firstOrNull { it.id == s.deviceId }?.childName ?: s.deviceId
                val hour = s.startMinute / 60
                val min = s.startMinute % 60
                root.addView(
                    TextView(this).apply {
                        text = "${s.label} · $deviceName · ${"%02d:%02d".format(hour, min)} · ${s.durationMinutes}m"
                    }
                )
                root.addView(
                    MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                        text = "Remove schedule"
                        setOnClickListener {
                            val fid = familyId ?: return@setOnClickListener
                            lifecycleScope.launch {
                                runCatching { repo.deleteScreenShareSchedule(fid, s.id) }
                            }
                        }
                    }
                )
            }
        }

        val firstDevice = devices.firstOrNull()
        if (firstDevice != null) {
            val scheduleLabel = TextInputEditText(this).apply { hint = "Schedule label" }
            val scheduleTime = TextInputEditText(this).apply {
                hint = "Start time HH:MM (24h)"
                inputType = InputType.TYPE_CLASS_TEXT
            }
            val scheduleDays = TextInputEditText(this).apply {
                hint = "Days 1-7 (Sun=1), comma-separated"
                inputType = InputType.TYPE_CLASS_TEXT
            }
            root.addView(TextView(this).apply {
                text = "Add scheduled screen share (${firstDevice.childName})"
                setPadding(0, dp(20), 0, dp(8))
            })
            root.addView(TextInputLayout(this).apply { addView(scheduleLabel) })
            root.addView(TextInputLayout(this).apply { addView(scheduleTime) })
            root.addView(TextInputLayout(this).apply { addView(scheduleDays) })
            root.addView(
                MaterialButton(this).apply {
                    text = "Save schedule (${screenShareDurationMinutes} min)"
                    setOnClickListener {
                        val fid = familyId ?: return@setOnClickListener
                        val parts = scheduleTime.text?.toString()?.trim()?.split(":") ?: return@setOnClickListener
                        if (parts.size != 2) {
                            Toast.makeText(this@DashboardActivity, "Use HH:MM", Toast.LENGTH_SHORT).show()
                            return@setOnClickListener
                        }
                        val hour = parts[0].toIntOrNull() ?: return@setOnClickListener
                        val minute = parts[1].toIntOrNull() ?: return@setOnClickListener
                        val days = scheduleDays.text?.toString()?.split(",")
                            ?.mapNotNull { it.trim().toIntOrNull() }
                            ?.filter { it in 1..7 }
                            ?: emptyList()
                        lifecycleScope.launch {
                            runCatching {
                                repo.addScreenShareSchedule(
                                    fid,
                                    firstDevice.id,
                                    scheduleLabel.text?.toString()?.ifBlank { "Scheduled check" } ?: "Scheduled check",
                                    days,
                                    hour * 60 + minute,
                                    screenShareDurationMinutes
                                )
                            }.onSuccess {
                                Toast.makeText(this@DashboardActivity, "Schedule saved", Toast.LENGTH_SHORT).show()
                            }.onFailure {
                                Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                }
            )
        }

        if (commands.isNotEmpty()) {
            root.addView(
                TextView(this).apply {
                    text = "Recent commands"
                    textSize = 16f
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                    setPadding(0, dp(20), 0, dp(8))
                }
            )
            val fmt = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())
            commands.take(12).forEach { cmd ->
                val deviceName = devices.firstOrNull { it.id == cmd.deviceId }?.childName ?: cmd.deviceId
                root.addView(
                    TextView(this).apply {
                        text = "${cmd.type} · ${cmd.status} · $deviceName · ${fmt.format(Date(cmd.requestedAtMs))}"
                        setPadding(0, dp(4), 0, dp(4))
                    }
                )
                if (!cmd.resultUrl.isNullOrBlank()) {
                    root.addView(
                        MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                            text = "Open result"
                            setOnClickListener {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(cmd.resultUrl)))
                            }
                        }
                    )
                }
            }
        }

        if (callSmsPreviews.isNotEmpty()) {
            root.addView(
                TextView(this).apply {
                    text = "Recent call/SMS summary (visible monitoring)"
                    textSize = 16f
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                    setPadding(0, dp(20), 0, dp(8))
                }
            )
            val fmt = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())
            callSmsPreviews.take(8).forEach { item ->
                val deviceName = devices.firstOrNull { it.id == item.deviceId }?.childName ?: item.deviceId
                root.addView(
                    TextView(this).apply {
                        text = buildString {
                            append("${item.kind} ${item.direction} · $deviceName · ${item.addressMasked}")
                            append(" · ${fmt.format(Date(item.atMs))}")
                            item.snippet?.let { append("\n$it") }
                        }
                        setPadding(0, dp(4), 0, dp(4))
                    }
                )
            }
        }
    }

    private fun requestScreenShareButton(device: DeviceStatus): MaterialButton {
        return MaterialButton(this).apply {
            text = "Request screen share (${screenShareDurationMinutes} min)"
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = dp(6) }
            setOnClickListener {
                val fid = familyId ?: return@setOnClickListener
                lifecycleScope.launch {
                    runCatching {
                        repo.createSafetyCommand(
                            fid,
                            device.id,
                            SafetyCommandType.SCREEN_SHARE,
                            screenShareDurationMinutes
                        )
                    }
                        .onSuccess {
                            Toast.makeText(
                                this@DashboardActivity,
                                "Screen share request sent ($screenShareDurationMinutes min)",
                                Toast.LENGTH_LONG
                            ).show()
                        }
                        .onFailure {
                            Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show()
                        }
                }
            }
        }
    }

    private fun requestButton(
        label: String,
        device: DeviceStatus,
        type: SafetyCommandType
    ): MaterialButton {
        return MaterialButton(this).apply {
            text = label
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = dp(6) }
            setOnClickListener {
                val fid = familyId ?: return@setOnClickListener
                lifecycleScope.launch {
                    runCatching { repo.createSafetyCommand(fid, device.id, type) }
                        .onSuccess {
                            Toast.makeText(
                                this@DashboardActivity,
                                "Request sent — child must Accept on their phone",
                                Toast.LENGTH_LONG
                            ).show()
                        }
                        .onFailure {
                            Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show()
                        }
                }
            }
        }
    }

    private fun showUsageTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        root.addView(
            TextView(this).apply {
                text = "App usage & limits"
                textSize = 22f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
        )

        val firstDevice = devices.firstOrNull()
        root.addView(
            TextView(this).apply {
                text = if (firstDevice != null) {
                    "New limits apply to: ${firstDevice.childName}"
                } else {
                    "Pair a device first to add app limits."
                }
                setPadding(0, dp(8), 0, dp(8))
            }
        )
        val packageInput = addTextInput(root, "Package name (e.g. com.instagram.android)")
        val labelInput = addTextInput(root, "App label (e.g. Instagram)")
        val minutesInput = addTextInput(root, "Daily limit minutes", InputType.TYPE_CLASS_NUMBER, "60")
        root.addView(
            MaterialButton(this).apply {
                text = "Add app limit"
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).also { it.topMargin = dp(8) }
                setOnClickListener {
                    val fid = familyId ?: return@setOnClickListener
                    val did = firstDevice?.id
                    val pkg = packageInput.text?.toString()?.trim().orEmpty()
                    if (did == null || pkg.isBlank()) {
                        Toast.makeText(this@DashboardActivity, "Pick a device and package name", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    val limit = AppLimit(
                        packageName = pkg,
                        label = labelInput.text?.toString()?.ifBlank { pkg } ?: pkg,
                        dailyLimitMinutes = minutesInput.text?.toString()?.toIntOrNull() ?: 60,
                        deviceId = did
                    )
                    lifecycleScope.launch {
                        runCatching { repo.addAppLimit(fid, limit) }
                            .onSuccess {
                                packageInput.setText("")
                                labelInput.setText("")
                                Toast.makeText(this@DashboardActivity, "Limit added", Toast.LENGTH_SHORT).show()
                            }
                            .onFailure { Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show() }
                    }
                }
            }
        )

        root.addView(sectionHeader("Current limits"))
        if (appLimits.isEmpty()) {
            root.addView(TextView(this).apply { text = "No app limits set." })
        } else {
            appLimits.forEach { limit ->
                val deviceName = devices.firstOrNull { it.id == limit.deviceId }?.childName ?: limit.deviceId
                root.addView(
                    TextView(this).apply {
                        text = "${limit.label} (${limit.packageName}) · $deviceName · ${limit.dailyLimitMinutes} min/day"
                        setPadding(0, dp(6), 0, dp(2))
                    }
                )
                root.addView(
                    MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                        text = "Remove limit"
                        setOnClickListener {
                            val fid = familyId ?: return@setOnClickListener
                            lifecycleScope.launch { runCatching { repo.deleteAppLimit(fid, limit.id) } }
                        }
                    }
                )
            }
        }

        root.addView(sectionHeader("Scheduled app blocks"))
        val blockPackageInput = addTextInput(root, "Package name (e.g. com.whatsapp)")
        val blockLabelInput = addTextInput(root, "App label (e.g. WhatsApp)")
        val blockDaysInput = addTextInput(root, "Days (1=Sun ... 7=Sat, e.g. 2,3,4,5,6)", prefill = "2,3,4,5,6")
        val blockStartInput = addTextInput(root, "Start minute (e.g. 480 = 08:00)", InputType.TYPE_CLASS_NUMBER, "480")
        val blockEndInput = addTextInput(root, "End minute (e.g. 900 = 15:00)", InputType.TYPE_CLASS_NUMBER, "900")
        root.addView(
            MaterialButton(this).apply {
                text = "Add scheduled block"
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).also { it.topMargin = dp(8) }
                setOnClickListener {
                    val fid = familyId ?: return@setOnClickListener
                    val did = firstDevice?.id
                    val pkg = blockPackageInput.text?.toString()?.trim().orEmpty()
                    if (did == null || pkg.isBlank()) {
                        Toast.makeText(this@DashboardActivity, "Pick a device and package name", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    val days = blockDaysInput.text?.toString().orEmpty()
                        .split(",")
                        .mapNotNull { it.trim().toIntOrNull() }
                        .filter { it in 1..7 }
                    val rule = AppBlockSchedule(
                        packageName = pkg,
                        label = blockLabelInput.text?.toString()?.trim().orEmpty(),
                        deviceId = did,
                        daysOfWeek = days,
                        startMinute = blockStartInput.text?.toString()?.toIntOrNull() ?: 480,
                        endMinute = blockEndInput.text?.toString()?.toIntOrNull() ?: 900
                    )
                    lifecycleScope.launch {
                        runCatching { repo.addAppBlockSchedule(fid, rule) }
                            .onSuccess {
                                blockPackageInput.setText("")
                                blockLabelInput.setText("")
                                Toast.makeText(this@DashboardActivity, "Scheduled block added", Toast.LENGTH_SHORT).show()
                            }
                            .onFailure { Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show() }
                    }
                }
            }
        )
        root.addView(
            MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "Add school + bedtime presets (TikTok, WhatsApp, Facebook)"
                setOnClickListener {
                    val fid = familyId ?: return@setOnClickListener
                    val did = firstDevice?.id ?: return@setOnClickListener
                    val schoolDays = listOf(2, 3, 4, 5, 6)
                    val apps = listOf(
                        "com.zhiliaoapp.musically" to "TikTok",
                        "com.whatsapp" to "WhatsApp",
                        "com.facebook.katana" to "Facebook"
                    )
                    lifecycleScope.launch {
                        apps.forEach { (pkg, label) ->
                            runCatching {
                                repo.addAppBlockSchedule(
                                    fid,
                                    AppBlockSchedule(
                                        packageName = pkg,
                                        label = label,
                                        deviceId = did,
                                        daysOfWeek = schoolDays,
                                        startMinute = 8 * 60,
                                        endMinute = 15 * 60
                                    )
                                )
                                repo.addAppBlockSchedule(
                                    fid,
                                    AppBlockSchedule(
                                        packageName = pkg,
                                        label = "$label (Bedtime)",
                                        deviceId = did,
                                        daysOfWeek = emptyList(),
                                        startMinute = 21 * 60,
                                        endMinute = 6 * 60 + 30
                                    )
                                )
                            }
                        }
                        Toast.makeText(this@DashboardActivity, "Preset schedules added", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        )
        if (appBlockSchedules.isEmpty()) {
            root.addView(TextView(this).apply { text = "No scheduled app blocks yet." })
        } else {
            appBlockSchedules.forEach { rule ->
                val deviceName = devices.firstOrNull { it.id == rule.deviceId }?.childName ?: rule.deviceId
                root.addView(
                    TextView(this).apply {
                        text =
                            "${rule.label.ifBlank { rule.packageName }} (${rule.packageName}) · $deviceName · " +
                                "${rule.startMinute}-${rule.endMinute} · days: " +
                                (if (rule.daysOfWeek.isEmpty()) "all" else rule.daysOfWeek.joinToString(","))
                    }
                )
                root.addView(
                    MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                        text = "Remove block schedule"
                        setOnClickListener {
                            val fid = familyId ?: return@setOnClickListener
                            lifecycleScope.launch { runCatching { repo.deleteAppBlockSchedule(fid, rule.id) } }
                        }
                    }
                )
            }
        }

        root.addView(sectionHeader("Offline auto-call fallback"))
        root.addView(
            TextView(this).apply {
                text = "When internet is unavailable, child can auto-call this number (best effort)."
            }
        )
        val callNumberInput = addTextInput(
            root,
            "Parent phone number for offline auto-call",
            prefill = firstDevice?.offlineCallNumber ?: ""
        )
        val callAttemptsInput = addTextInput(
            root,
            "Max call attempts per offline session (0-10)",
            InputType.TYPE_CLASS_NUMBER,
            (firstDevice?.offlineCallMaxAttempts ?: 2).toString()
        )
        root.addView(
            MaterialButton(this).apply {
                text = "Save offline auto-call config"
                setOnClickListener {
                    val fid = familyId ?: return@setOnClickListener
                    val did = firstDevice?.id ?: return@setOnClickListener
                    val number = callNumberInput.text?.toString()?.trim().orEmpty()
                    val attempts = callAttemptsInput.text?.toString()?.toIntOrNull() ?: 2
                    lifecycleScope.launch {
                        runCatching {
                            repo.setOfflineCallConfig(
                                familyId = fid,
                                deviceId = did,
                                enabled = number.isNotBlank() && attempts > 0,
                                number = number,
                                maxAttempts = attempts
                            )
                        }.onSuccess {
                            Toast.makeText(this@DashboardActivity, "Offline auto-call config saved", Toast.LENGTH_SHORT).show()
                        }.onFailure {
                            Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        )
        if (firstDevice != null) {
            root.addView(
                TextView(this).apply {
                    text =
                        "Current: enabled=${firstDevice.offlineCallEnabled}, number=${firstDevice.offlineCallNumber ?: "not set"}, max=${firstDevice.offlineCallMaxAttempts}"
                }
            )
        }

        root.addView(sectionHeader("Recent daily usage"))
        if (usageDaily.isEmpty()) {
            root.addView(TextView(this).apply { text = "No usage synced yet." })
        } else {
            usageDaily.take(20).forEach { entry ->
                val deviceName = devices.firstOrNull { it.id == entry.deviceId }?.childName ?: entry.deviceId
                root.addView(
                    TextView(this).apply {
                        text = buildString {
                            append("${entry.day} · $deviceName · ${entry.totalMinutes} min total")
                            if (entry.apps.isNotEmpty()) {
                                append("\n")
                                append(entry.apps.take(5).joinToString(", ") { "${it.label}: ${it.minutes}m" })
                            }
                        }
                        setPadding(0, dp(8), 0, dp(4))
                    }
                )
            }
        }
    }

    private fun showDigestsTab(container: FrameLayout) {
        val listBinding = TabListBinding.inflate(layoutInflater, container, true)
        val fmt = SimpleDateFormat("MMM d", Locale.getDefault())
        listBinding.list.layoutManager = LinearLayoutManager(this)
        listBinding.list.adapter = CardAdapter(
            digests.map { d ->
                CardRow(
                    title = "Week of ${fmt.format(Date(d.weekStartMs))} – ${fmt.format(Date(d.weekEndMs))}",
                    subtitle = "${d.alertCount} alerts" +
                        (if (d.topAlertTypes.isNotEmpty()) " · Top: ${d.topAlertTypes.joinToString(", ")}" else ""),
                    detail = d.summary
                )
            }
        )
    }

    private fun showGuardiansTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        root.addView(
            TextView(this).apply {
                text = "Guardians & caregivers"
                textSize = 22f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
        )

        val fmt = SimpleDateFormat("MMM d, yyyy", Locale.getDefault())
        if (guardians.isEmpty()) {
            root.addView(TextView(this).apply { text = "No guardians yet."; setPadding(0, dp(8), 0, dp(8)) })
        } else {
            guardians.forEach { g ->
                root.addView(
                    TextView(this).apply {
                        text = "${g.email.ifBlank { g.uid }} · ${g.role} · joined ${fmt.format(Date(g.joinedAtMs))}"
                        setPadding(0, dp(6), 0, dp(2))
                    }
                )
            }
        }

        root.addView(sectionHeader("Invite a caregiver"))
        val emailInput = addTextInput(root, "Caregiver email", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val inviteResult = TextView(this).apply { setPadding(0, dp(8), 0, 0) }
        root.addView(
            MaterialButton(this).apply {
                text = "Send invite"
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).also { it.topMargin = dp(8) }
                setOnClickListener {
                    val email = emailInput.text?.toString()?.trim().orEmpty()
                    if (email.isBlank()) {
                        Toast.makeText(this@DashboardActivity, "Enter an email", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    lifecycleScope.launch {
                        runCatching { repo.createGuardianInvite(email) }
                            .onSuccess {
                                inviteResult.text = "Invite code: $it (share with the caregiver, expires in 7 days)"
                            }
                            .onFailure { inviteResult.text = it.message }
                    }
                }
            }
        )
        root.addView(inviteResult)

        root.addView(sectionHeader("Have an invite code?"))
        val codeInput = addTextInput(root, "Invite code")
        val acceptResult = TextView(this).apply { setPadding(0, dp(8), 0, 0) }
        root.addView(
            MaterialButton(this).apply {
                text = "Accept invite"
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).also { it.topMargin = dp(8) }
                setOnClickListener {
                    val code = codeInput.text?.toString().orEmpty()
                    lifecycleScope.launch {
                        repo.acceptGuardianInvite(code)
                            .onSuccess { fid ->
                                familyId = fid
                                acceptResult.text = "Joined family successfully."
                                observe(fid)
                                showTab(6)
                            }
                            .onFailure { acceptResult.text = it.message }
                    }
                }
            }
        )
        root.addView(acceptResult)

        root.addView(sectionHeader("Safe contacts (WhatsApp)"))
        root.addView(
            TextView(this).apply {
                text = "Messages from contacts not listed here are flagged as unidentified."
            }
        )
        val safeLabelInput = addTextInput(root, "Display name (e.g. Aunt Mary)")
        val safeIdentifierInput = addTextInput(root, "WhatsApp name/handle/phone fragment")
        root.addView(
            MaterialButton(this).apply {
                text = "Add safe contact"
                setOnClickListener {
                    val fid = familyId ?: return@setOnClickListener
                    val identifier = safeIdentifierInput.text?.toString()?.trim().orEmpty()
                    if (identifier.isBlank()) {
                        Toast.makeText(this@DashboardActivity, "Enter contact identifier", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    lifecycleScope.launch {
                        runCatching {
                            repo.addSafeContact(
                                fid,
                                SafeContact(
                                    channel = "WHATSAPP",
                                    label = safeLabelInput.text?.toString()?.trim().orEmpty(),
                                    identifier = identifier
                                )
                            )
                        }.onSuccess {
                            safeLabelInput.setText("")
                            safeIdentifierInput.setText("")
                        }.onFailure { Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show() }
                    }
                }
            }
        )
        if (safeContacts.isEmpty()) {
            root.addView(TextView(this).apply { text = "No safe WhatsApp contacts added yet." })
        } else {
            safeContacts.filter { it.channel == "WHATSAPP" }.forEach { contact ->
                root.addView(
                    TextView(this).apply {
                        text = "${contact.label.ifBlank { "Contact" }} · ${contact.identifier}"
                        setPadding(0, dp(4), 0, dp(2))
                    }
                )
                root.addView(
                    MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                        text = "Remove"
                        setOnClickListener {
                            val fid = familyId ?: return@setOnClickListener
                            lifecycleScope.launch { runCatching { repo.deleteSafeContact(fid, contact.id) } }
                        }
                    }
                )
            }
        }
    }

    private fun sectionHeader(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 16f
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(0, dp(20), 0, dp(8))
    }

    private fun addTextInput(
        root: LinearLayout,
        hint: String,
        inputType: Int = InputType.TYPE_CLASS_TEXT,
        prefill: String = ""
    ): TextInputEditText {
        val layout = TextInputLayout(this).apply {
            this.hint = hint
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = dp(8) }
        }
        val edit = TextInputEditText(this).apply {
            this.inputType = inputType
            setText(prefill)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        layout.addView(edit)
        root.addView(layout)
        return edit
    }

    private fun matchFrameParams() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
    )

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun formatSchedule(zone: GeofenceZone): String {
        if (zone.daysOfWeek.isEmpty() && zone.startMinute == null && zone.endMinute == null) return "Always active"
        val dayNames = mapOf(
            Calendar.SUNDAY to "Sun", Calendar.MONDAY to "Mon", Calendar.TUESDAY to "Tue",
            Calendar.WEDNESDAY to "Wed", Calendar.THURSDAY to "Thu", Calendar.FRIDAY to "Fri",
            Calendar.SATURDAY to "Sat"
        )
        val days = if (zone.daysOfWeek.isEmpty()) "Every day" else zone.daysOfWeek.mapNotNull { dayNames[it] }.joinToString(", ")
        val start = zone.startMinute
        val end = zone.endMinute
        val hours = if (start != null && end != null) {
            " · %02d:%02d–%02d:%02d".format(start / 60, start % 60, end / 60, end % 60)
        } else ""
        return days + hours
    }

    private fun showGeofenceList(container: FrameLayout) {
        val listBinding = TabListBinding.inflate(layoutInflater, container, true)
        listBinding.list.layoutManager = LinearLayoutManager(this)
        listBinding.list.adapter = CardAdapter(
            geofences.map { z ->
                CardRow(
                    title = z.name,
                    subtitle = "${z.radiusM.toInt()}m · ${formatSchedule(z)}",
                    detail = "${"%.4f".format(z.lat)}, ${"%.4f".format(z.lng)}",
                    action = "Delete",
                    onAction = {
                        val fid = familyId ?: return@CardRow
                        lifecycleScope.launch { runCatching { repo.deleteGeofence(fid, z.id) } }
                    }
                )
            }
        )
    }

    private fun showPairTab(container: FrameLayout) {
        val pair = TabPairBinding.inflate(layoutInflater, container, true)
        pair.createCode.setOnClickListener {
            lifecycleScope.launch {
                runCatching {
                    repo.createPairingCode(pair.childName.text?.toString()?.ifBlank { "Child" } ?: "Child")
                }.onSuccess {
                    pair.codeLabel.text = it
                    pair.pairError.text = "Expires in 30 minutes. Enter on the child device."
                }.onFailure {
                    pair.pairError.text = it.message
                }
            }
        }
        pair.addGeofence.setOnClickListener {
            val loc = devices.firstOrNull()?.lastLocation
            if (loc == null) {
                Toast.makeText(this, "Waiting for child location", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            val fid = familyId ?: return@setOnClickListener
            val zone = GeofenceZone(
                name = pair.zoneName.text?.toString()?.ifBlank { "Zone" } ?: "Zone",
                lat = loc.lat,
                lng = loc.lng,
                radiusM = pair.zoneRadius.text?.toString()?.toFloatOrNull() ?: 200f
            )
            lifecycleScope.launch {
                runCatching { repo.addGeofence(fid, zone) }
                    .onSuccess { Toast.makeText(this@DashboardActivity, "Geofence added", Toast.LENGTH_SHORT).show() }
                    .onFailure { Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show() }
            }
        }
        pair.addSosContact.setOnClickListener {
            val fid = familyId ?: return@setOnClickListener
            val name = pair.sosName.text?.toString()?.trim().orEmpty()
            val note = pair.sosPhoneNote.text?.toString()?.trim().orEmpty()
            if (name.isBlank()) {
                Toast.makeText(this, "Enter a contact name", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            lifecycleScope.launch {
                runCatching { repo.addSosContact(fid, SosContact(name = name, phoneNote = note)) }
                    .onSuccess {
                        pair.sosName.setText("")
                        pair.sosPhoneNote.setText("")
                        Toast.makeText(this@DashboardActivity, "SOS contact added", Toast.LENGTH_SHORT).show()
                    }
                    .onFailure { Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show() }
            }
        }
    }

    data class CardRow(
        val title: String,
        val subtitle: String,
        val detail: String,
        val action: String? = null,
        val onAction: (() -> Unit)? = null
    )

    class CardAdapter(private val rows: List<CardRow>) :
        RecyclerView.Adapter<CardAdapter.VH>() {
        class VH(val binding: ItemCardBinding) : RecyclerView.ViewHolder(binding.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val binding = ItemCardBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            return VH(binding)
        }

        override fun getItemCount() = rows.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val row = rows[position]
            holder.binding.title.text = row.title
            holder.binding.subtitle.text = row.subtitle
            holder.binding.detail.text = row.detail
            if (row.action != null && row.onAction != null) {
                holder.binding.action.visibility = View.VISIBLE
                holder.binding.action.text = row.action
                holder.binding.action.setOnClickListener { row.onAction.invoke() }
            } else {
                holder.binding.action.visibility = View.GONE
            }
        }
    }
}
