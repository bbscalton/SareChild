package com.sarechild.child

import android.os.Bundle
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import com.sarechild.child.databinding.ActivityAppBlockBinding

/**
 * Full-screen scheduled app block — child cannot dismiss while the block is active.
 * Re-launched by [com.sarechild.child.monitoring.UsageMonitorHelper] when the blocked
 * app returns to the foreground.
 */
class AppBlockActivity : AppCompatActivity() {
    private lateinit var binding: ActivityAppBlockBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        )
        binding = ActivityAppBlockBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val label = intent.getStringExtra(EXTRA_LABEL).orEmpty().ifBlank { "This app" }
        val message = intent.getStringExtra(EXTRA_MESSAGE)
            ?: "Application has been blocked."
        val windowText = intent.getStringExtra(EXTRA_WINDOW).orEmpty()

        binding.title.text = label
        binding.message.text = message
        binding.windowHint.text = if (windowText.isBlank()) {
            "Protected by SareChild"
        } else {
            "Blocked during $windowText · Protected by SareChild"
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Intentionally blocked while schedule is active
    }

    companion object {
        const val EXTRA_LABEL = "label"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_WINDOW = "window"
        const val EXTRA_PACKAGE = "package"
    }
}
