package com.sarechild.child

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.sarechild.child.databinding.ActivityPermissionsBinding
import com.sarechild.child.monitoring.MonitoringForegroundService

class PermissionsActivity : AppCompatActivity() {
    private lateinit var binding: ActivityPermissionsBinding

    private val requestPerms = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { }

    private val requestBackground = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPermissionsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnLocation.setOnClickListener {
            val needed = mutableListOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                needed += Manifest.permission.POST_NOTIFICATIONS
            }
            requestPerms.launch(needed.toTypedArray())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val fine = ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                if (fine) {
                    requestBackground.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                }
            }
        }
        binding.btnNotifications.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                requestPerms.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            }
        }
        binding.btnNotifAccess.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        binding.btnBattery.setOnClickListener {
            val pm = getSystemService(PowerManager::class.java)
            if (pm?.isIgnoringBatteryOptimizations(packageName) == true) return@setOnClickListener
            try {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                )
            } catch (_: Exception) {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }
        binding.btnAccessibility.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        binding.btnUsage.setOnClickListener {
            com.sarechild.child.monitoring.UsageMonitorHelper.openUsageSettings(this)
        }
        binding.btnCallSms.setOnClickListener {
            requestPerms.launch(
                arrayOf(
                    Manifest.permission.READ_CALL_LOG,
                    Manifest.permission.READ_SMS,
                    Manifest.permission.SEND_SMS,
                    Manifest.permission.CALL_PHONE
                )
            )
        }
        binding.btnStart.setOnClickListener {
            MonitoringForegroundService.start(this)
            startActivity(Intent(this, HomeActivity::class.java))
            finish()
        }
    }
}
