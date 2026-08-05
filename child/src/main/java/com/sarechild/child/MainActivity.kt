package com.sarechild.child

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.SareChildConstants

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val repo = ChildRepository(this)
        // The explicit boolean extra covers our own in-app-built notifications; the
        // "screen" string extra covers the case where Android killed the process and
        // the *system* auto-displayed the FCM notification payload, then relaunched
        // this launcher activity on tap with the raw data payload as string extras.
        val openChat = intent?.getBooleanExtra(SareChildConstants.EXTRA_OPEN_CHAT, false) == true ||
            intent?.getStringExtra(SareChildConstants.FCM_DATA_SCREEN) == SareChildConstants.FCM_SCREEN_FAMILY_CHAT
        val next = when {
            !repo.isPaired -> PairingActivity::class.java
            !repo.consentDone -> ConsentActivity::class.java
            openChat -> FamilyChatActivity::class.java
            else -> HomeActivity::class.java
        }
        startActivity(Intent(this, next))
        finish()
    }
}
