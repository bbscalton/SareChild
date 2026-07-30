package com.sarechild.parent

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val loggedIn = FirebaseAuth.getInstance().currentUser != null
        startActivity(
            Intent(
                this,
                if (loggedIn) DashboardActivity::class.java else AuthActivity::class.java
            )
        )
        finish()
    }
}
