package com.sarechild.parent

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.firebase.auth.FirebaseAuth
import com.sarechild.parent.data.ParentRepository
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val loggedIn = FirebaseAuth.getInstance().currentUser != null
        // The boolean extra covers our own in-app-built notifications; the "screen"
        // string extra covers Android auto-launching this launcher activity (with the
        // raw FCM data payload as extras) after the system displayed the notification
        // itself because the app process was dead.
        val openChat = intent?.getBooleanExtra(SareChildConstants.EXTRA_OPEN_CHAT, false) == true ||
            intent?.getStringExtra(SareChildConstants.FCM_DATA_SCREEN) == SareChildConstants.FCM_SCREEN_FAMILY_CHAT
        val chatDeviceId = intent?.getStringExtra(SareChildConstants.EXTRA_CHAT_DEVICE_ID)
            ?: intent?.getStringExtra("deviceId")
        if (!loggedIn) {
            startActivity(Intent(this, AuthActivity::class.java))
            finish()
            return
        }
        lifecycleScope.launch {
            val repo = ParentRepository()
            val needsTerms = runCatching { repo.needsTermsAcceptance() }.getOrDefault(true)
            val next = when {
                needsTerms -> TermsActivity::class.java
                openChat -> FamilyChatActivity::class.java
                else -> DashboardActivity::class.java
            }
            startActivity(
                Intent(this@MainActivity, next).apply {
                    if (next == FamilyChatActivity::class.java && chatDeviceId != null) {
                        putExtra(SareChildConstants.EXTRA_CHAT_DEVICE_ID, chatDeviceId)
                    }
                }
            )
            finish()
        }
    }
}
