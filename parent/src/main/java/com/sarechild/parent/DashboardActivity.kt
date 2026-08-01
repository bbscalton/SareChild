package com.sarechild.parent

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsIntent
import android.text.InputType
import android.text.format.DateUtils
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.GravityCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.google.firebase.messaging.FirebaseMessaging
import com.sarechild.parent.data.ParentRepository
import com.sarechild.parent.data.LocationTrailSample
import com.sarechild.parent.data.UsageDailySummary
import com.sarechild.parent.databinding.ActivityDashboardBinding
import com.sarechild.parent.databinding.ItemAlertCardBinding
import com.sarechild.parent.databinding.ItemCardBinding
import com.sarechild.parent.databinding.ItemDeviceCardBinding
import com.sarechild.parent.databinding.TabListBinding
import com.sarechild.parent.databinding.TabPairBinding
import com.sarechild.parent.geo.GoogleGeoApi
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.AppBlockSchedule
import com.sarechild.shared.AppLimit
import com.sarechild.shared.CallRecordingEvent
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
import com.sarechild.shared.TypingSafetyEvent
import com.sarechild.shared.WeeklyDigest
import com.sarechild.shared.WhatsAppEvent
import com.sarechild.shared.WhatsAppEventType
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
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
    private var whatsAppEvents: List<WhatsAppEvent> = emptyList()
    private var callRecordings: List<CallRecordingEvent> = emptyList()
    private var typingEvents: List<TypingSafetyEvent> = emptyList()
    private var whatsAppFilter: WhatsAppFilter = WhatsAppFilter.ALL
    private var typingFilter: TypingFilter = TypingFilter.ALL
    private var callRecordingFilter: CallRecordingFilter = CallRecordingFilter.ALL

    private enum class WhatsAppFilter { ALL, UNKNOWN, CALLS, MEDIA }
    private enum class TypingFilter { ALL, FLAGGED, UNREVIEWED }
    private enum class CallRecordingFilter { ALL, CELLULAR, VOIP, MISSED }

    private val addressCache = mutableMapOf<String, String?>()
    private val mapBitmapCache = mutableMapOf<String, Bitmap?>()
    private var alertFilter: AlertFilter = AlertFilter.ALL

    private enum class AlertFilter { ALL, CRITICAL, INFO }

    /** Currently visible sidebar section — mirrors the parent-web sidebar sections. */
    private var currentSection: String = "home"
    private var navRows: List<NavRow> = emptyList()

    private data class NavRow(val key: String, val label: String, val icon: String, val button: TextView)

    private val requestNotificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDashboardBinding.inflate(layoutInflater)
        setContentView(binding.root)

        ensureNotificationsEnabled()
        refreshFcmToken()

        binding.toolbar.inflateMenu(R.menu.dashboard_menu)
        binding.toolbar.setOnMenuItemClickListener {
            if (it.itemId == R.id.action_sign_out) {
                repo.signOut()
                startActivity(Intent(this, AuthActivity::class.java))
                finish()
                true
            } else false
        }
        binding.toolbar.setNavigationOnClickListener {
            binding.drawerLayout.openDrawer(GravityCompat.START)
        }

        setupDrawer()
        onBackPressedDispatcher.addCallback(this) {
            if (binding.drawerLayout.isDrawerOpen(GravityCompat.START)) {
                binding.drawerLayout.closeDrawer(GravityCompat.START)
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        }

        lifecycleScope.launch {
            runCatching { repo.recordLogin() }
            val trial = runCatching { repo.getTrialInfo() }.getOrNull()
            if (trial != null && trial.isBlocked) {
                showTrialBlockedPrompt(trial)
                return@launch
            }
            runCatching { repo.ensureKeywordListSeeded() }
            runCatching { repo.getFamilyId() }
                .onSuccess {
                    familyId = it
                    showSection("home")
                    observe(it)
                    runCatching { repo.recordParentCheckIn() }
                }
                .onFailure {
                    showJoinFamilyPrompt(it.message)
                }
        }
    }

    /** Builds the sidebar (nav drawer) content — grouped rows mirroring the parent-web sidebar. */
    private fun setupDrawer() {
        val container = binding.navContainer
        container.removeAllViews()
        container.setPadding(0, dp(28), 0, dp(20))

        val brandRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(4), dp(20), dp(18))
        }
        brandRow.addView(TextView(this).apply {
            text = "\uD83D\uDEE1\uFE0F"
            textSize = 22f
            setPadding(0, 0, dp(10), 0)
        })
        val brandTexts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        brandTexts.addView(TextView(this).apply {
            text = "SareChild"
            textSize = 18f
            setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_text))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        brandTexts.addView(TextView(this).apply {
            text = "Parent dashboard"
            textSize = 12f
            setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_text_muted))
        })
        brandRow.addView(brandTexts)
        container.addView(brandRow)
        container.addView(sidebarDivider())

        val rows = mutableListOf<NavRow>()
        fun addGroup(label: String, items: List<Triple<String, String, String>>) {
            container.addView(TextView(this).apply {
                text = label.uppercase(Locale.getDefault())
                textSize = 11f
                letterSpacing = 0.08f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_text_muted))
                setPadding(dp(20), dp(14), dp(20), dp(6))
            })
            items.forEach { (key, title, icon) ->
                val button = navRowButton(icon, title) { selectSection(key) }
                container.addView(button)
                rows += NavRow(key, title, icon, button)
            }
        }

        addGroup(
            "Overview",
            listOf(
                Triple("home", "Home", "\uD83C\uDFE0"),
                Triple("alerts", "Alerts", "\uD83D\uDD14"),
                Triple("chat", "Chat", "\uD83D\uDCAC"),
                Triple("livemap", "Live map", "\uD83D\uDEF0\uFE0F"),
                Triple("map", "Map & locations", "\uD83D\uDCCD"),
            )
        )
        addGroup(
            "Family",
            listOf(
                Triple("pair", "Pair a device", "\uD83D\uDCF1"),
                Triple("guardians", "Guardians", "\uD83D\uDC6A"),
            )
        )
        addGroup(
            "WhatsApp protection",
            listOf(
                Triple("whatsapp", "WhatsApp", "\uD83D\uDFE2"),
            )
        )
        addGroup(
            "Communication",
            listOf(
                Triple("callrecording", "Call recording", "\uD83D\uDCDE"),
                Triple("liveview", "Live viewing", "\uD83D\uDCF9"),
            )
        )
        addGroup(
            "Typing safety",
            listOf(
                Triple("typing", "Typing safety", "\u2328\uFE0F"),
            )
        )
        addGroup(
            "Safety tools",
            listOf(
                Triple("safety", "Safety checks", "\uD83D\uDEE1\uFE0F"),
                Triple("geofences", "Safe zones", "\uD83D\uDCD0"),
                Triple("apps", "Apps", "\uD83D\uDCF1"),
                Triple("usage", "Usage & limits", "\u23F1\uFE0F"),
                Triple("digests", "Weekly digests", "\uD83D\uDCF0"),
            )
        )
        navRows = rows

        val spacer = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        container.addView(spacer)
        container.addView(sidebarDivider())
        container.addView(
            MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "Open full web dashboard"
                setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_text))
                strokeColor = android.content.res.ColorStateList.valueOf(
                    ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_divider)
                )
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).also { it.setMargins(dp(20), dp(14), dp(20), dp(8)) }
                setOnClickListener { openWebDashboard() }
            }
        )
        container.addView(
            MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "Sign out"
                setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_text))
                strokeColor = android.content.res.ColorStateList.valueOf(
                    ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_divider)
                )
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).also { it.setMargins(dp(20), dp(14), dp(20), dp(8)) }
                setOnClickListener {
                    repo.signOut()
                    startActivity(Intent(this@DashboardActivity, AuthActivity::class.java))
                    finish()
                }
            }
        )
        updateNavHighlight()
    }

    private fun sidebarDivider(): View = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).also {
            it.setMargins(dp(20), dp(4), dp(20), dp(4))
        }
        setBackgroundColor(ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_divider))
    }

    private fun navRowButton(icon: String, title: String, onClick: () -> Unit): TextView {
        val outValue = android.util.TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackground, outValue, true)
        return TextView(this).apply {
            text = "$icon   $title"
            textSize = 14.5f
            gravity = Gravity.CENTER_VERTICAL or Gravity.START
            setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.sidebar_text))
            isClickable = true
            isFocusable = true
            foreground = ContextCompat.getDrawable(this@DashboardActivity, outValue.resourceId)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.setMargins(dp(12), dp(2), dp(12), dp(2)) }
            setPadding(dp(14), dp(12), dp(14), dp(12))
            clipToOutline = false
            setOnClickListener { onClick() }
        }
    }

    /** Highlights the active sidebar row with the brand gradient pill, like the web sidebar. */
    private fun updateNavHighlight() {
        navRows.forEach { row ->
            if (row.key == currentSection) {
                row.button.background = ContextCompat.getDrawable(this, R.drawable.bg_nav_item_active)
                row.button.setTextColor(ContextCompat.getColor(this, R.color.surface))
            } else {
                row.button.background = null
                row.button.setTextColor(ContextCompat.getColor(this, R.color.sidebar_text))
            }
        }
    }

    private fun selectSection(key: String) {
        binding.drawerLayout.closeDrawer(GravityCompat.START)
        showSection(key)
    }

    /** Android 13+ requires runtime consent to show heads-up family chat / SOS notifications. */
    private fun ensureNotificationsEnabled() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /**
     * Registers/refreshes this device's FCM token so family chat and SOS pushes keep
     * reaching it even if onNewToken() never fires again on an existing install.
     */
    private fun refreshFcmToken() {
        lifecycleScope.launch {
            runCatching {
                val token = FirebaseMessaging.getInstance().token.await()
                repo.saveFcmToken(token)
            }
        }
    }

    /** Full features while status == "active" and now < trialEndsAt (see ParentRepository.TrialInfo). */
    private fun showTrialBlockedPrompt(trial: com.sarechild.parent.data.TrialInfo) {
        val container = binding.content
        container.removeAllViews()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(24), dp(16), dp(24))
        }
        container.addView(root, matchFrameParams())
        val title = if (trial.status == "purged") {
            "This trial account was removed"
        } else {
            "Your free trial has ended"
        }
        val body = if (trial.status == "purged") {
            "This account was inactive for too long during its free trial and was automatically removed along with its family data, per our trial cleanup policy."
        } else {
            "Your 30-day free trial has finished. Paid plans are coming later — thanks for trying SareChild!"
        }
        root.addView(TextView(this).apply {
            text = title
            textSize = 20f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = body
            setPadding(0, dp(8), 0, dp(16))
        })
        root.addView(MaterialButton(this).apply {
            text = "Sign out"
            setOnClickListener {
                repo.signOut()
                startActivity(Intent(this@DashboardActivity, AuthActivity::class.java))
                finish()
            }
        })
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
                                showSection("home")
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
                    if (currentSection == "home" || currentSection == "safety" || currentSection == "map") refreshSection()
                }
            }
            launch {
                repo.observeAlerts(familyId).collectLatest {
                    alerts = it
                    if (currentSection == "home" || currentSection == "alerts") refreshSection()
                }
            }
            launch {
                repo.observeCommands(familyId).collectLatest {
                    commands = it
                    if (currentSection == "safety") refreshSection()
                }
            }
            launch {
                repo.observeUsageDaily(familyId).collectLatest {
                    usageDaily = it
                    if (currentSection == "usage") refreshSection()
                }
            }
            launch {
                repo.observeLocationTrail(familyId).collectLatest {
                    locationTrail = it
                    if (currentSection == "home" || currentSection == "map") refreshSection()
                }
            }
            launch {
                repo.observeAppLimits(familyId).collectLatest {
                    appLimits = it
                    if (currentSection == "usage") refreshSection()
                }
            }
            launch {
                repo.observeAppBlockSchedules(familyId).collectLatest {
                    appBlockSchedules = it
                    if (currentSection == "usage") refreshSection()
                }
            }
            launch {
                repo.observeCallSms(familyId).collectLatest {
                    callSmsPreviews = it
                    if (currentSection == "safety") refreshSection()
                }
            }
            launch {
                repo.observeDigests(familyId).collectLatest {
                    digests = it
                    if (currentSection == "digests") refreshSection()
                }
            }
            launch {
                repo.observeGuardians(familyId).collectLatest {
                    guardians = it
                    if (currentSection == "chat" || currentSection == "guardians") refreshSection()
                }
            }
            launch {
                repo.observeSafeContacts(familyId).collectLatest {
                    safeContacts = it
                    if (currentSection == "guardians") refreshSection()
                }
            }
            launch {
                repo.observeSafetySettings(familyId).collectLatest {
                    safetySettings = it
                    if (currentSection == "safety") refreshSection()
                }
            }
            launch {
                repo.observeGeofences(familyId).collectLatest {
                    geofences = it
                    if (currentSection == "geofences") refreshSection()
                }
            }
            launch {
                repo.observeScreenShareSchedules(familyId).collectLatest {
                    screenShareSchedules = it
                    if (currentSection == "safety") refreshSection()
                }
            }
            launch {
                repo.observeWhatsAppEvents(familyId).collectLatest {
                    whatsAppEvents = it
                    if (currentSection == "whatsapp") refreshSection()
                }
            }
            launch {
                repo.observeCallRecordings(familyId).collectLatest {
                    callRecordings = it
                    if (currentSection == "callrecording") refreshSection()
                }
            }
            launch {
                repo.observeTypingSafetyEvents(familyId).collectLatest {
                    typingEvents = it
                    if (currentSection == "typing") refreshSection()
                }
            }
            // Device "went dark" is a function of wall-clock time, not a new write, so
            // heartbeats stopping wouldn't otherwise refresh the Online/Offline pill.
            launch {
                while (true) {
                    delay(30_000)
                    if (currentSection == "home" || currentSection == "safety" || currentSection == "map") refreshSection()
                }
            }
        }
    }

    private fun isDeviceOnline(device: DeviceStatus): Boolean =
        device.lastHeartbeatMs > 0 &&
            System.currentTimeMillis() - device.lastHeartbeatMs < SareChildConstants.WENT_DARK_AFTER_MS

    private fun refreshSection() = showSection(currentSection)

    /** Renders the given sidebar section into the content frame and updates drawer highlight. */
    private fun showSection(key: String) {
        currentSection = key
        updateNavHighlight()
        supportActionBar?.title = null
        binding.toolbar.title = sectionTitle(key)
        val container = binding.content
        container.removeAllViews()
        when (key) {
            "home" -> showHomeTab(container)
            "alerts" -> showAlertsTab(container)
            "chat" -> showChatTab(container)
            "livemap" -> showLiveMapTab(container)
            "map" -> showMapTab(container)
            "whatsapp" -> showWhatsAppTab(container)
            "callrecording" -> showCallRecordingTab(container)
            "liveview" -> showLiveViewTab(container)
            "typing" -> showTypingTab(container)
            "apps" -> showAppsTab(container)
            "safety" -> showSafetyTab(container)
            "usage" -> showUsageTab(container)
            "digests" -> showDigestsTab(container)
            "guardians" -> showGuardiansTab(container)
            "geofences" -> showGeofenceList(container)
            "pair" -> showPairTab(container)
            else -> showHomeTab(container)
        }
    }

    private fun sectionTitle(key: String): String = when (key) {
        "home" -> "SareChild"
        "alerts" -> "Alerts"
        "chat" -> "Family chat"
        "livemap" -> "Live map"
        "map" -> "Map & locations"
        "whatsapp" -> "WhatsApp protection"
        "callrecording" -> "Call recording"
        "liveview" -> "Live viewing"
        "typing" -> "Typing safety"
        "apps" -> "Apps"
        "safety" -> "Safety checks"
        "usage" -> "App usage & limits"
        "digests" -> "Weekly digests"
        "guardians" -> "Guardians & caregivers"
        "geofences" -> "Safe zones"
        "pair" -> "Pair a device"
        else -> "SareChild"
    }

    /** Opens the signed-in parent web dashboard in Chrome Custom Tabs (Live map, TCD, etc.). */
    private fun openWebDashboard() {
        val url = getString(R.string.parent_web_dashboard_url)
        CustomTabsIntent.Builder()
            .setShowTitle(true)
            .build()
            .launchUrl(this, Uri.parse(url))
    }

    /** WebRTC live camera/audio/screen viewing — available on the parent web dashboard. */
    private fun showLiveViewTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        root.addView(TextView(this).apply {
            text = "Live viewing"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "Camera, microphone, and screen sharing use WebRTC on the parent web dashboard. Open it in your browser to start a live session with a paired child device."
            setPadding(0, dp(8), 0, dp(16))
        })
        root.addView(MaterialButton(this).apply {
            text = "Open live viewing in browser"
            setOnClickListener { openWebDashboard() }
        })
    }

    /** Installed-apps browser and block schedules — full UI on the parent web dashboard. */
    private fun showAppsTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        root.addView(TextView(this).apply {
            text = "Apps"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "Browse installed apps on each child device, set block schedules, and manage app limits. The full apps browser lives on the parent web dashboard; Usage & limits here covers daily time caps."
            setPadding(0, dp(8), 0, dp(16))
        })
        root.addView(MaterialButton(this).apply {
            text = "Open apps in web dashboard"
            setOnClickListener { openWebDashboard() }
        })
        root.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "Usage & limits (native)"
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = dp(8) }
            setOnClickListener { selectSection("usage") }
        })
    }

    /** Live map control center — native quick maps plus web dashboard for full experience. */
    private fun showLiveMapTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        root.addView(TextView(this).apply {
            text = "Live map control center"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "See every child's last location on the native map, or open the full web dashboard for trails, stops, and multi-device live tracking."
            setPadding(0, dp(8), 0, dp(16))
        })
        root.addView(MaterialButton(this).apply {
            text = "Open full web dashboard"
            setOnClickListener { openWebDashboard() }
        })
        if (devices.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "Pair a device to see live locations."
                setPadding(0, dp(16), 0, 0)
            })
            return
        }
        devices.forEach { device ->
            val loc = device.lastLocation
            root.addView(TextView(this).apply {
                text = device.childName
                textSize = 17f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setPadding(0, dp(16), 0, dp(4))
            })
            root.addView(TextView(this).apply {
                text = if (isDeviceOnline(device)) "Online" else "Offline"
            })
            if (loc != null) {
                root.addView(MaterialButton(this).apply {
                    text = "Open ${device.childName}'s map"
                    setOnClickListener { openDeviceMap(device) }
                })
            } else {
                root.addView(TextView(this).apply { text = "Waiting for first location…" })
            }
        }
    }

    private fun showWhatsAppTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        val unknownCount = whatsAppEvents.count { !it.contactSafe }
        root.addView(TextView(this).apply {
            text = "WhatsApp protection"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "${whatsAppEvents.size} events · $unknownCount from unknown contacts"
            setPadding(0, dp(8), 0, dp(12))
        })

        devices.forEach { device ->
            root.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "Request WhatsApp protection · ${device.childName}"
                setOnClickListener {
                    sendQuickCommand(device, SafetyCommandType.REQUEST_WHATSAPP_PROTECTION)
                }
            })
        }

        val filterRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, dp(8))
        }
        filterRow.addView(filterChip("All (${whatsAppEvents.size})", whatsAppFilter == WhatsAppFilter.ALL) {
            whatsAppFilter = WhatsAppFilter.ALL; showSection("whatsapp")
        })
        filterRow.addView(filterChip("Unknown ($unknownCount)", whatsAppFilter == WhatsAppFilter.UNKNOWN) {
            whatsAppFilter = WhatsAppFilter.UNKNOWN; showSection("whatsapp")
        })
        root.addView(filterRow)

        val filtered = when (whatsAppFilter) {
            WhatsAppFilter.ALL -> whatsAppEvents
            WhatsAppFilter.UNKNOWN -> whatsAppEvents.filter { !it.contactSafe }
            WhatsAppFilter.CALLS -> whatsAppEvents.filter { it.eventType == WhatsAppEventType.CALL }
            WhatsAppFilter.MEDIA -> whatsAppEvents.filter {
                it.eventType in listOf(
                    WhatsAppEventType.IMAGE, WhatsAppEventType.VOICE_NOTE,
                    WhatsAppEventType.VIDEO, WhatsAppEventType.DOCUMENT
                )
            }
        }

        if (filtered.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "No WhatsApp activity yet. Enable protection on the child device and send a test message."
                setPadding(0, dp(12), 0, 0)
            })
            return
        }

        filtered.take(50).forEach { ev ->
            val deviceName = devices.firstOrNull { it.id == ev.deviceId }?.childName ?: "Child"
            root.addView(TextView(this).apply {
                text = buildString {
                    append("${ev.contactLabel} · ${ev.eventType.name} · ${ev.direction}")
                    append("\n$deviceName · ${relativeTime(ev.createdAtMs)}")
                    ev.preview?.let { append("\n\"$it\"") }
                    if (ev.riskFlag) append("\n⚠ Review recommended")
                }
                setPadding(0, dp(10), 0, dp(4))
            })
            if (!ev.mediaUrl.isNullOrBlank()) {
                root.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    text = "Open media"
                    setOnClickListener {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ev.mediaUrl)))
                    }
                })
            }
        }
    }

    private fun showCallRecordingTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        val withAudio = callRecordings.count { it.audioCaptured }
        root.addView(TextView(this).apply {
            text = "Call recording"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "${callRecordings.size} recordings · $withAudio with audio. Cellular and VoIP (mic-side) capture on the child device."
            setPadding(0, dp(8), 0, dp(12))
        })

        devices.forEach { device ->
            root.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "Request call recording · ${device.childName}"
                setOnClickListener {
                    sendQuickCommand(device, SafetyCommandType.REQUEST_CALL_RECORDING)
                }
            })
        }

        if (callRecordings.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "No call recordings yet. Request consent on the child device first."
                setPadding(0, dp(12), 0, 0)
            })
            return
        }

        callRecordings.take(40).forEach { rec ->
            val deviceName = devices.firstOrNull { it.id == rec.deviceId }?.childName ?: "Child"
            root.addView(TextView(this).apply {
                text = buildString {
                    append("${rec.callType.name} · ${rec.direction}")
                    rec.contactLabel?.let { append(" · $it") }
                    rec.numberMasked?.let { append(" · $it") }
                    append("\n$deviceName · ${rec.durationSec}s · ${relativeTime(rec.createdAtMs)}")
                    if (rec.audioCaptured) append(" · audio captured")
                    rec.audioSourceNote?.let { append("\n$it") }
                }
                setPadding(0, dp(10), 0, dp(4))
            })
            if (!rec.audioUrl.isNullOrBlank()) {
                root.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    text = "Play recording"
                    setOnClickListener {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(rec.audioUrl)))
                    }
                })
            }
        }
    }

    private fun showTypingTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        val flagged = typingEvents.count { it.matchedWords.isNotEmpty() }
        val unreviewed = typingEvents.count { it.matchedWords.isNotEmpty() && !it.reviewed }
        root.addView(TextView(this).apply {
            text = "Typing safety"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "${typingEvents.size} events · $flagged flagged · $unreviewed unreviewed"
            setPadding(0, dp(8), 0, dp(12))
        })

        val filterRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(4), 0, dp(8))
        }
        filterRow.addView(filterChip("All", typingFilter == TypingFilter.ALL) {
            typingFilter = TypingFilter.ALL; showSection("typing")
        })
        filterRow.addView(filterChip("Flagged ($flagged)", typingFilter == TypingFilter.FLAGGED) {
            typingFilter = TypingFilter.FLAGGED; showSection("typing")
        })
        filterRow.addView(filterChip("Unreviewed ($unreviewed)", typingFilter == TypingFilter.UNREVIEWED) {
            typingFilter = TypingFilter.UNREVIEWED; showSection("typing")
        })
        root.addView(filterRow)

        val filtered = when (typingFilter) {
            TypingFilter.ALL -> typingEvents
            TypingFilter.FLAGGED -> typingEvents.filter { it.matchedWords.isNotEmpty() }
            TypingFilter.UNREVIEWED -> typingEvents.filter { it.matchedWords.isNotEmpty() && !it.reviewed }
        }

        if (filtered.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "No typing safety events yet. Enable message monitoring on the child device."
                setPadding(0, dp(12), 0, 0)
            })
            return
        }

        filtered.take(50).forEach { ev ->
            val deviceName = devices.firstOrNull { it.id == ev.deviceId }?.childName ?: "Child"
            root.addView(TextView(this).apply {
                text = buildString {
                    append("${ev.appLabel} · ${ev.severity.name}")
                    if (ev.matchedWords.isNotEmpty()) append(" · matched: ${ev.matchedWords.joinToString(", ")}")
                    append("\n$deviceName · ${relativeTime(ev.createdAtMs)}")
                    if (ev.snippet.isNotBlank()) append("\n\"${ev.snippet.take(120)}\"")
                }
                setPadding(0, dp(10), 0, dp(4))
            })
            if (ev.matchedWords.isNotEmpty() && !ev.reviewed) {
                root.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    text = "Mark reviewed"
                    setOnClickListener {
                        val fid = familyId ?: return@setOnClickListener
                        lifecycleScope.launch {
                            runCatching { repo.markTypingEventReviewed(fid, ev.id) }
                        }
                    }
                })
            }
        }
    }

    /** Bigger map-first view of every paired child's last known location, for sidebar parity with the web dashboard. */
    private fun showMapTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        if (devices.isEmpty()) {
            root.addView(TextView(this).apply { text = "Pair a device to see its location here." })
            return
        }
        devices.forEach { device ->
            prefetchLocationMeta(device)
            val card = com.google.android.material.card.MaterialCardView(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).also { it.bottomMargin = dp(14) }
                radius = dp(18).toFloat()
                cardElevation = 0f
                strokeWidth = dp(1)
                strokeColor = ContextCompat.getColor(this@DashboardActivity, R.color.outline)
                setCardBackgroundColor(ContextCompat.getColor(this@DashboardActivity, R.color.surface))
            }
            val inner = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(14), dp(14), dp(14))
            }
            inner.addView(TextView(this).apply {
                text = device.childName
                textSize = 17f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            val loc = device.lastLocation
            if (loc != null) {
                val key = "%.4f,%.4f".format(loc.lat, loc.lng)
                val bitmap = mapBitmapCache[key]
                val address = addressCache[key]
                if (bitmap != null) {
                    inner.addView(ImageView(this).apply {
                        setImageBitmap(bitmap)
                        adjustViewBounds = true
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).also { it.topMargin = dp(8) }
                        setOnClickListener { openDeviceMap(device) }
                    })
                } else {
                    inner.addView(TextView(this).apply {
                        text = "Loading map…"
                        setPadding(0, dp(8), 0, dp(4))
                    })
                }
                if (!address.isNullOrBlank()) {
                    inner.addView(TextView(this).apply {
                        text = "\uD83D\uDCCD $address"
                        setPadding(0, dp(6), 0, 0)
                        setTypeface(typeface, android.graphics.Typeface.BOLD)
                    })
                }
                inner.addView(MaterialButton(this).apply {
                    text = "Open in Google Maps"
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).also { it.topMargin = dp(10) }
                    setOnClickListener { openDeviceMap(device) }
                })
            } else {
                inner.addView(TextView(this).apply {
                    text = "Waiting for first location…"
                    setPadding(0, dp(8), 0, 0)
                })
            }
            card.addView(inner)
            root.addView(card)
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
            text = "Family chat"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "Children online: $childOnline · Guardians online: $guardianOnline"
            setPadding(0, dp(8), 0, dp(6))
        })
        root.addView(TextView(this).apply {
            text = "A warm check-in goes a long way. Share encouragement, photos, or a quick voice note with your child and every guardian."
            setPadding(0, 0, 0, dp(12))
        })
        root.addView(MaterialButton(this@DashboardActivity).apply {
            text = "Open family chat"
            setOnClickListener { startActivity(Intent(this@DashboardActivity, FamilyChatActivity::class.java)) }
        })
    }

    /** One-glance parent home: a rich card per child with a map pin, address, and quick actions. */
    private fun showHomeTab(container: FrameLayout) {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(4))
        }
        scroll.addView(root)
        container.addView(scroll, matchFrameParams())

        if (devices.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "Welcome to SareChild"
                textSize = 22f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            root.addView(TextView(this).apply {
                text = "Pair your child's phone to see their location, alerts, and safety status here."
                setPadding(0, dp(8), 0, dp(16))
                setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.text_secondary))
            })
            root.addView(MaterialButton(this).apply {
                text = "Pair a device"
                setOnClickListener { showSection("pair") }
            })
            return
        }

        val onlineCount = devices.count { isDeviceOnline(it) }
        root.addView(TextView(this).apply {
            text = if (devices.size == 1) devices[0].childName else "Your family"
            textSize = 24f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "$onlineCount of ${devices.size} online"
            setPadding(0, dp(4), 0, dp(4))
            setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.text_secondary))
        })

        val latestUnread = alerts.firstOrNull { !it.read }
        if (latestUnread != null) {
            root.addView(
                homeAlertBanner(latestUnread) {
                    showSection("alerts")
                }
            )
        }

        val recycler = RecyclerView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = dp(12) }
            isNestedScrollingEnabled = false
            layoutManager = LinearLayoutManager(this@DashboardActivity)
        }
        root.addView(recycler)
        devices.forEach { prefetchLocationMeta(it) }
        recycler.adapter = DeviceCardAdapter(devices)
    }

    /** Small reassuring/alerting strip at the top of Home summarizing the newest unread alert. */
    private fun homeAlertBanner(alert: FamilyAlert, onClick: () -> Unit): View {
        val (fg, bg) = severityColors(alert.severity)
        val card = com.google.android.material.card.MaterialCardView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = dp(8) }
            radius = dp(14).toFloat()
            cardElevation = 0f
            setCardBackgroundColor(bg)
            isClickable = true
            isFocusable = true
            setOnClickListener { onClick() }
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        row.addView(ImageView(this).apply {
            setImageResource(alertIconRes(alert.type))
            imageTintList = android.content.res.ColorStateList.valueOf(fg)
            layoutParams = LinearLayout.LayoutParams(dp(20), dp(20))
        })
        row.addView(TextView(this).apply {
            text = "${alert.title} · ${relativeTime(alert.createdAtMs)}"
            setTextColor(fg)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            textSize = 13f
            setPadding(dp(10), 0, 0, 0)
        })
        card.addView(row)
        return card
    }

    /** Kicks off (cached) reverse-geocoding + a map-pin thumbnail for a device's last known spot. */
    private fun prefetchLocationMeta(device: DeviceStatus) {
        val loc = device.lastLocation ?: return
        val key = "%.4f,%.4f".format(loc.lat, loc.lng)
        if (addressCache.containsKey(key) && mapBitmapCache.containsKey(key)) return
        lifecycleScope.launch {
            if (!addressCache.containsKey(key)) {
                addressCache[key] = runCatching { GoogleGeoApi.reverseGeocode(this@DashboardActivity, loc.lat, loc.lng) }.getOrNull()
            }
            if (!mapBitmapCache.containsKey(key)) {
                mapBitmapCache[key] = runCatching {
                    GoogleGeoApi.staticMapBitmap(this@DashboardActivity, loc.lat, loc.lng, 640, 280)
                }.getOrNull()
            }
            if (currentSection == "home" || currentSection == "map") refreshSection()
        }
    }

    private inner class DeviceCardAdapter(private val rows: List<DeviceStatus>) :
        RecyclerView.Adapter<DeviceCardAdapter.VH>() {
        inner class VH(val binding: ItemDeviceCardBinding) : RecyclerView.ViewHolder(binding.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
            VH(ItemDeviceCardBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun getItemCount() = rows.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val d = rows[position]
            val b = holder.binding
            val online = isDeviceOnline(d)

            b.childName.text = d.childName
            b.statusPill.text = if (online) "Online" else "Offline"
            val (fg, bg) = if (online) {
                ContextCompat.getColor(this@DashboardActivity, R.color.status_online) to
                    ContextCompat.getColor(this@DashboardActivity, R.color.status_online_bg)
            } else {
                ContextCompat.getColor(this@DashboardActivity, R.color.status_offline) to
                    ContextCompat.getColor(this@DashboardActivity, R.color.status_offline_bg)
            }
            b.statusPill.setTextColor(fg)
            (b.statusPill.background as? android.graphics.drawable.GradientDrawable)?.mutate()
                ?.let { (it as android.graphics.drawable.GradientDrawable).setColor(bg) }

            b.metaLine.text = buildString {
                append(if (d.batteryPercent >= 0) "Battery ${d.batteryPercent}%" else "Battery unknown")
                if (d.charging) append(" (charging)")
                append(" · Screen time today: ${d.todayScreenMinutes} min")
            }

            val loc = d.lastLocation
            if (loc != null) {
                val key = "%.4f,%.4f".format(loc.lat, loc.lng)
                val bitmap = mapBitmapCache[key]
                val address = addressCache[key]
                b.mapPlaceholderText.visibility = if (bitmap != null) View.GONE else View.VISIBLE
                b.mapPlaceholderText.text = address ?: "Loading map…"
                b.mapThumb.visibility = if (bitmap != null) View.VISIBLE else View.GONE
                if (bitmap != null) b.mapThumb.setImageBitmap(bitmap)
                if (!address.isNullOrBlank()) {
                    b.addressLine.visibility = View.VISIBLE
                    b.addressLine.text = address
                } else {
                    b.addressLine.visibility = View.GONE
                }
                b.mapFrame.setOnClickListener { openDeviceMap(d) }
                b.actionMap.visibility = View.VISIBLE
                b.actionMap.setOnClickListener { openDeviceMap(d) }
            } else {
                b.mapThumb.visibility = View.GONE
                b.mapPlaceholderText.visibility = View.VISIBLE
                b.mapPlaceholderText.text = "Waiting for first location…"
                b.addressLine.visibility = View.GONE
                b.actionMap.visibility = View.GONE
                b.mapFrame.setOnClickListener(null)
            }

            val latestAlert = alerts.filter { it.deviceId == d.id }.maxByOrNull { it.createdAtMs }
            if (latestAlert != null) {
                b.latestAlertRow.visibility = View.VISIBLE
                b.latestAlertIcon.setImageResource(alertIconRes(latestAlert.type))
                val (fgSev, _) = severityColors(latestAlert.severity)
                b.latestAlertIcon.imageTintList = android.content.res.ColorStateList.valueOf(fgSev)
                b.latestAlertText.text = "${latestAlert.title} · ${relativeTime(latestAlert.createdAtMs)}"
                b.latestAlertRow.setOnClickListener { showSection("alerts") }
            } else {
                b.latestAlertRow.visibility = View.GONE
            }

            b.actionChat.setOnClickListener {
                startActivity(Intent(this@DashboardActivity, FamilyChatActivity::class.java))
            }
            val locked = isDeviceLocked(d.id)
            b.actionLock.text = if (locked) "Unlock" else "Lock"
            b.actionLock.setOnClickListener {
                sendQuickCommand(d, if (locked) SafetyCommandType.UNLOCK_DEVICE else SafetyCommandType.LOCK_DEVICE)
            }
            b.actionScreenShare.setOnClickListener {
                sendQuickCommand(d, SafetyCommandType.SCREEN_SHARE, screenShareDurationMinutes)
            }

            b.detailText.text = buildString {
                append("Monitoring: ${if (d.monitoringActive) "on" else "off"} · Notification access: ${if (d.notificationAccess) "on" else "off"}\n")
                append(
                    "Consents — screen:${d.screenShareConsent} camera:${d.cameraCheckConsent} " +
                        "mic:${d.micCheckConsent} messages:${d.messageMonitorConsent} usage:${d.usageConsent}"
                )
                if (d.offlineCallEnabled) {
                    append("\nOffline auto-call enabled to ${d.offlineCallNumber ?: "not set"}")
                }
            }
            b.detailText.visibility = View.GONE
            b.moreDetails.text = "Show more details"
            b.moreDetails.setOnClickListener {
                val show = b.detailText.visibility != View.VISIBLE
                b.detailText.visibility = if (show) View.VISIBLE else View.GONE
                b.moreDetails.text = if (show) "Hide details" else "Show more details"
            }
        }
    }

    /** Best-effort "is it locked right now" from the most recent LOCK/UNLOCK command for this device. */
    private fun isDeviceLocked(deviceId: String): Boolean {
        val latest = commands
            .filter { it.deviceId == deviceId && (it.type == SafetyCommandType.LOCK_DEVICE || it.type == SafetyCommandType.UNLOCK_DEVICE) }
            .maxByOrNull { it.requestedAtMs }
            ?: return false
        return latest.type == SafetyCommandType.LOCK_DEVICE &&
            latest.status != com.sarechild.shared.SafetyCommandStatus.DECLINED &&
            latest.status != com.sarechild.shared.SafetyCommandStatus.FAILED &&
            latest.status != com.sarechild.shared.SafetyCommandStatus.CANCELLED
    }

    private fun openDeviceMap(d: DeviceStatus) {
        val loc = d.lastLocation ?: return
        // Wider window than before (60 vs 20 samples, ~1hr at the ~60s heartbeat
        // cadence) so on-device stop detection has enough points to work with.
        val trail = locationTrail.filter { it.deviceId == d.id && it.location != null }.takeLast(60)
        val intent = Intent(this, DeviceMapActivity::class.java).apply {
            putExtra(DeviceMapActivity.EXTRA_CHILD_NAME, d.childName)
            putExtra(DeviceMapActivity.EXTRA_LAT, loc.lat)
            putExtra(DeviceMapActivity.EXTRA_LNG, loc.lng)
            putExtra(DeviceMapActivity.EXTRA_TRAIL_LATS, trail.map { it.location!!.lat }.toDoubleArray())
            putExtra(DeviceMapActivity.EXTRA_TRAIL_LNGS, trail.map { it.location!!.lng }.toDoubleArray())
            putExtra(DeviceMapActivity.EXTRA_TRAIL_ATS, trail.map { it.recordedAtMs }.toLongArray())
        }
        startActivity(intent)
    }

    private fun sendQuickCommand(device: DeviceStatus, type: SafetyCommandType, durationMinutes: Int? = null) {
        val fid = familyId ?: return
        lifecycleScope.launch {
            runCatching { repo.createSafetyCommand(fid, device.id, type, durationMinutes) }
                .onSuccess {
                    Toast.makeText(this@DashboardActivity, "Request sent — child must Accept on their phone", Toast.LENGTH_LONG).show()
                }
                .onFailure { Toast.makeText(this@DashboardActivity, it.message, Toast.LENGTH_LONG).show() }
        }
    }

    /** "3 min ago" style relative time, falling back to a date for anything older than a week. */
    private fun relativeTime(atMs: Long): String {
        if (atMs <= 0L) return "unknown time"
        val now = System.currentTimeMillis()
        val diff = now - atMs
        if (diff < 0 || diff > 7L * 24 * 60 * 60 * 1000) {
            return SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(Date(atMs))
        }
        return DateUtils.getRelativeTimeSpanString(
            atMs, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE
        ).toString()
    }

    /** (foreground, background) color pair for a severity, used for icon tint + chip fill. */
    private fun severityColors(severity: AlertSeverity): Pair<Int, Int> {
        val (fgRes, bgRes) = when (severity) {
            AlertSeverity.CRITICAL -> R.color.severity_critical to R.color.severity_critical_bg
            AlertSeverity.HIGH -> R.color.severity_high to R.color.severity_high_bg
            AlertSeverity.MEDIUM -> R.color.severity_medium to R.color.severity_medium_bg
            AlertSeverity.LOW -> R.color.severity_low to R.color.severity_low_bg
        }
        return ContextCompat.getColor(this, fgRes) to ContextCompat.getColor(this, bgRes)
    }

    /** Groups the (already technical) AlertType enum into a small set of plain-language icons. */
    private fun alertIconRes(type: AlertType): Int = when (type) {
        AlertType.SOS -> R.drawable.ic_alert_sos
        AlertType.GEOFENCE_ENTER, AlertType.GEOFENCE_EXIT -> R.drawable.ic_alert_location
        AlertType.LOW_BATTERY -> R.drawable.ic_alert_battery
        AlertType.WENT_DARK -> R.drawable.ic_offline
        AlertType.TAMPER, AlertType.PERMISSION_REVOKED, AlertType.DEVICE_LOCKED, AlertType.DEVICE_UNLOCKED,
        AlertType.SCREEN_SHARE, AlertType.CAMERA_CHECK, AlertType.MIC_CHECK, AlertType.RING_DEVICE -> R.drawable.ic_alert_shield
        AlertType.LIVE_VIEW -> R.drawable.ic_alert_shield
        AlertType.KEYWORD, AlertType.MESSAGE_PREVIEW, AlertType.UNIDENTIFIED_CONTACT,
        AlertType.WHATSAPP_MEDIA, AlertType.WHATSAPP_CALL, AlertType.TYPING_SAFETY,
        AlertType.CALL_RECORDING -> R.drawable.ic_alert_message
        AlertType.APP_INSTALL, AlertType.APP_UNINSTALL, AlertType.USAGE_LIMIT, AlertType.APP_BLOCKED -> R.drawable.ic_alert_app
        AlertType.CHECK_IN, AlertType.OFFLINE_EVIDENCE, AlertType.CALL_SMS_SYNC -> R.drawable.ic_alert_info
    }

    /** Human, plain-language summary of an alert category — avoids parents needing to know enum jargon. */
    private fun alertCategoryLabel(type: AlertType): String = when (type) {
        AlertType.SOS -> "Emergency SOS"
        AlertType.GEOFENCE_ENTER, AlertType.GEOFENCE_EXIT -> "Safe zone"
        AlertType.LOW_BATTERY -> "Battery"
        AlertType.WENT_DARK -> "Connection"
        AlertType.TAMPER, AlertType.PERMISSION_REVOKED -> "Device tampering"
        AlertType.SCREEN_SHARE, AlertType.CAMERA_CHECK, AlertType.MIC_CHECK, AlertType.RING_DEVICE,
        AlertType.DEVICE_LOCKED, AlertType.DEVICE_UNLOCKED, AlertType.LIVE_VIEW -> "Safety check"
        AlertType.KEYWORD, AlertType.MESSAGE_PREVIEW, AlertType.UNIDENTIFIED_CONTACT -> "Message safety"
        AlertType.TYPING_SAFETY -> "Typing safety"
        AlertType.WHATSAPP_MEDIA, AlertType.WHATSAPP_CALL -> "WhatsApp"
        AlertType.CALL_RECORDING -> "Call recording"
        AlertType.APP_INSTALL, AlertType.APP_UNINSTALL -> "App activity"
        AlertType.USAGE_LIMIT, AlertType.APP_BLOCKED -> "Screen time"
        AlertType.CHECK_IN -> "Check-in"
        AlertType.OFFLINE_EVIDENCE, AlertType.CALL_SMS_SYNC -> "Update"
    }

    private fun showAlertsTab(container: FrameLayout) {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), 0)
        }
        container.addView(root, matchFrameParams())

        root.addView(TextView(this).apply {
            text = "Alerts"
            textSize = 22f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })

        val filterRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(10), 0, dp(10))
        }
        val criticalCount = alerts.count { it.severity == AlertSeverity.CRITICAL || it.severity == AlertSeverity.HIGH }
        filterRow.addView(filterChip("All (${alerts.size})", alertFilter == AlertFilter.ALL) {
            alertFilter = AlertFilter.ALL
            showSection("alerts")
        })
        filterRow.addView(filterChip("Critical ($criticalCount)", alertFilter == AlertFilter.CRITICAL) {
            alertFilter = AlertFilter.CRITICAL
            showSection("alerts")
        })
        filterRow.addView(filterChip("Info", alertFilter == AlertFilter.INFO) {
            alertFilter = AlertFilter.INFO
            showSection("alerts")
        })
        root.addView(filterRow)

        val filtered = when (alertFilter) {
            AlertFilter.ALL -> alerts
            AlertFilter.CRITICAL -> alerts.filter { it.severity == AlertSeverity.CRITICAL || it.severity == AlertSeverity.HIGH }
            AlertFilter.INFO -> alerts.filter { it.severity == AlertSeverity.LOW || it.severity == AlertSeverity.MEDIUM }
        }

        if (filtered.isEmpty()) {
            val emptyBox = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(dp(16), dp(48), dp(16), dp(24))
            }
            emptyBox.addView(ImageView(this).apply {
                setImageResource(R.drawable.ic_alert_shield)
                imageTintList = android.content.res.ColorStateList.valueOf(
                    ContextCompat.getColor(this@DashboardActivity, R.color.brand_green)
                )
                layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
            })
            emptyBox.addView(TextView(this).apply {
                text = if (alerts.isEmpty()) "All quiet — no alerts yet" else "No alerts in this filter"
                textSize = 17f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setPadding(0, dp(12), 0, dp(4))
            })
            emptyBox.addView(TextView(this).apply {
                text = "That's a good thing! Safety alerts from your child's device will show up here."
                setTextColor(ContextCompat.getColor(this@DashboardActivity, R.color.text_secondary))
                gravity = Gravity.CENTER_HORIZONTAL
            })
            root.addView(emptyBox)
            return
        }

        val recycler = RecyclerView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            layoutManager = LinearLayoutManager(this@DashboardActivity)
            setPadding(0, 0, 0, dp(16))
            clipToPadding = false
        }
        root.addView(recycler)
        recycler.adapter = AlertCardAdapter(filtered)
    }

    private fun filterChip(label: String, selected: Boolean, onClick: () -> Unit): View {
        return MaterialButton(
            this,
            null,
            if (selected) 0 else com.google.android.material.R.attr.materialButtonOutlinedStyle
        ).apply {
            text = label
            textSize = 12f
            insetTop = 0
            insetBottom = 0
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.marginEnd = dp(8) }
            setOnClickListener { onClick() }
        }
    }

    private inner class AlertCardAdapter(private val rows: List<FamilyAlert>) :
        RecyclerView.Adapter<AlertCardAdapter.VH>() {
        inner class VH(val binding: ItemAlertCardBinding) : RecyclerView.ViewHolder(binding.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
            VH(ItemAlertCardBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun getItemCount() = rows.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val a = rows[position]
            val b = holder.binding
            val (fg, bg) = severityColors(a.severity)

            b.alertIcon.setImageResource(alertIconRes(a.type))
            b.alertIcon.imageTintList = android.content.res.ColorStateList.valueOf(fg)
            (b.alertIcon.parent as? View)?.background?.mutate()
                ?.let { (it as? android.graphics.drawable.GradientDrawable)?.setColor(bg) }

            b.alertTitle.text = a.title
            val deviceName = devices.firstOrNull { it.id == a.deviceId }?.childName
            b.alertMeta.text = buildString {
                append(alertCategoryLabel(a.type))
                if (!deviceName.isNullOrBlank()) append(" · $deviceName")
                append(" · ${relativeTime(a.createdAtMs)}")
            }
            if (!a.snippet.isNullOrBlank()) {
                b.alertSnippet.visibility = View.VISIBLE
                b.alertSnippet.text = a.snippet
            } else {
                b.alertSnippet.visibility = View.GONE
            }
            b.unreadDot.visibility = if (a.read) View.GONE else View.VISIBLE
            (b.unreadDot.background as? android.graphics.drawable.GradientDrawable)?.mutate()
                ?.let { (it as android.graphics.drawable.GradientDrawable).setColor(fg) }

            val device = devices.firstOrNull { it.id == a.deviceId }
            val hasLocation = a.location != null || device?.lastLocation != null
            if (hasLocation) {
                b.alertActionMap.visibility = View.VISIBLE
                b.alertActionMap.setOnClickListener {
                    val loc = a.location ?: device?.lastLocation ?: return@setOnClickListener
                    val intent = Intent(this@DashboardActivity, DeviceMapActivity::class.java).apply {
                        putExtra(DeviceMapActivity.EXTRA_CHILD_NAME, deviceName ?: "Child")
                        putExtra(DeviceMapActivity.EXTRA_LAT, loc.lat)
                        putExtra(DeviceMapActivity.EXTRA_LNG, loc.lng)
                    }
                    startActivity(intent)
                }
            } else {
                b.alertActionMap.visibility = View.GONE
            }

            when {
                !a.mediaUrl.isNullOrBlank() -> {
                    b.alertActionSecondary.visibility = View.VISIBLE
                    b.alertActionSecondary.text = "Open media"
                    b.alertActionSecondary.setOnClickListener {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(a.mediaUrl)))
                        if (!a.read) markAlertReadSilently(a)
                    }
                }
                !a.read -> {
                    b.alertActionSecondary.visibility = View.VISIBLE
                    b.alertActionSecondary.text = "Mark read"
                    b.alertActionSecondary.setOnClickListener { markAlertReadSilently(a) }
                }
                else -> b.alertActionSecondary.visibility = View.GONE
            }
        }
    }

    private fun markAlertReadSilently(alert: FamilyAlert) {
        val fid = familyId ?: return
        lifecycleScope.launch { runCatching { repo.markAlertRead(fid, alert.id) } }
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
                        append(if (isDeviceOnline(device)) "Online" else "Offline")
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
                        showSection("safety")
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
                                showSection("guardians")
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
                    subtitle = "${z.radiusM.toInt()}m radius · ${formatSchedule(z)}",
                    detail = "Center point: ${"%.4f".format(z.lat)}, ${"%.4f".format(z.lng)}",
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
