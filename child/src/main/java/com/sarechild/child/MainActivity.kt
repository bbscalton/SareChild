package com.sarechild.child

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.sarechild.child.data.ChildRepository

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val repo = ChildRepository(this)
        val next = when {
            !repo.isPaired -> PairingActivity::class.java
            !repo.consentDone -> ConsentActivity::class.java
            else -> HomeActivity::class.java
        }
        startActivity(Intent(this, next))
        finish()
    }
}
