package com.sarechild.child

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.firebase.auth.FirebaseAuthException
import com.sarechild.child.data.ChildRepository
import com.sarechild.child.databinding.ActivityPairingBinding
import kotlinx.coroutines.launch

class PairingActivity : AppCompatActivity() {
    private lateinit var binding: ActivityPairingBinding
    private lateinit var repo: ChildRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPairingBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = ChildRepository(this)

        binding.pair.setOnClickListener {
            val code = binding.code.text?.toString().orEmpty()
            binding.error.visibility = View.GONE
            binding.loading.visibility = View.VISIBLE
            lifecycleScope.launch {
                val result = repo.claimPairingCode(code)
                binding.loading.visibility = View.GONE
                result.onSuccess {
                    startActivity(Intent(this@PairingActivity, ConsentActivity::class.java))
                    finish()
                }.onFailure { err ->
                    binding.error.text = friendlyPairingError(err)
                    binding.error.visibility = View.VISIBLE
                }
            }
        }
    }

    private fun friendlyPairingError(err: Throwable): String {
        val msg = err.message.orEmpty()
        return when {
            err is FirebaseAuthException &&
                (err.errorCode.contains("OPERATION_NOT_ALLOWED", true) ||
                    msg.contains("OPERATION_NOT_ALLOWED", true)) ->
                "Anonymous sign-in is disabled. Enable it in Firebase Authentication → Sign-in method."
            msg.contains("API key not valid", true) ||
                msg.contains("API_KEY_INVALID", true) ->
                "Child app is using the wrong Firebase config. Replace child/google-services.json with the SafeChild file."
            msg.contains("Unable to resolve host", true) ||
                msg.contains("network", true) ->
                "Network error. Check internet connection and try again."
            msg.contains("PERMISSION_DENIED", true) ->
                "Firestore permission denied. Check Firebase rules / Anonymous auth."
            msg.isNotBlank() -> msg
            else -> "Pairing failed"
        }
    }
}
