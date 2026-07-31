package com.sarechild.child

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityConsentBinding
import kotlinx.coroutines.launch

class ConsentActivity : AppCompatActivity() {
    private lateinit var binding: ActivityConsentBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityConsentBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val refresh = {
            binding.continueBtn.isEnabled =
                binding.checkLocation.isChecked &&
                    binding.checkNotif.isChecked &&
                    binding.checkVisible.isChecked
        }
        listOf(
            binding.checkLocation,
            binding.checkNotif,
            binding.checkVisible,
            binding.checkScreen,
            binding.checkCamera,
            binding.checkMic,
            binding.checkMessages,
            binding.checkInstalls,
            binding.checkUsage,
            binding.checkCallSms,
            binding.checkOfflineSmsFallback,
            binding.checkOfflineAutoCall,
            binding.checkWhatsapp
        ).forEach { it.setOnCheckedChangeListener { _, _ -> refresh() } }

        binding.continueBtn.setOnClickListener {
            val repo = ChildRepository(this)
            repo.consentDone = true
            repo.screenShareConsent = binding.checkScreen.isChecked
            repo.cameraCheckConsent = binding.checkCamera.isChecked
            repo.micCheckConsent = binding.checkMic.isChecked
            repo.messageMonitorConsent = binding.checkMessages.isChecked
            repo.installMonitorConsent = binding.checkInstalls.isChecked
            repo.usageConsent = binding.checkUsage.isChecked
            repo.callSmsConsent = binding.checkCallSms.isChecked
            repo.offlineSmsFallbackConsent = binding.checkOfflineSmsFallback.isChecked
            repo.offlineAutoCallConsent = binding.checkOfflineAutoCall.isChecked
            repo.whatsappMonitorConsent = binding.checkWhatsapp.isChecked
            lifecycleScope.launch {
                runCatching { repo.syncConsentFlags() }
                startActivity(Intent(this@ConsentActivity, PermissionsActivity::class.java))
                finish()
            }
        }
    }
}
