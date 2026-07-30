package com.sarechild.child

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.sarechild.child.databinding.ActivityUsageLimitBinding

class UsageLimitActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val binding = ActivityUsageLimitBinding.inflate(layoutInflater)
        setContentView(binding.root)
        val label = intent.getStringExtra("label") ?: "App"
        val mode = intent.getStringExtra("mode").orEmpty()
        if (mode == "scheduled_block") {
            val window = intent.getStringExtra("window") ?: "restricted hours"
            binding.message.text =
                "$label is blocked right now ($window).\nThis screen is shown on purpose during family schedule time."
        } else {
            val minutes = intent.getIntExtra("minutes", 0)
            val limit = intent.getIntExtra("limit", 0)
            binding.message.text =
                "Daily limit for $label reached ($minutes of $limit minutes).\nThis screen is shown on purpose."
        }
        binding.ok.setOnClickListener { finish() }
    }
}
