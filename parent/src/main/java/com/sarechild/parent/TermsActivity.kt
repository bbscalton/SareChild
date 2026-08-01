package com.sarechild.parent

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sarechild.parent.data.ParentRepository
import com.sarechild.parent.databinding.ActivityTermsBinding
import kotlinx.coroutines.launch

class TermsActivity : AppCompatActivity() {
    private lateinit var binding: ActivityTermsBinding
    private val repo = ParentRepository()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityTermsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.accept.setOnClickListener {
            if (!binding.acceptTerms.isChecked || !binding.acceptPrivacy.isChecked) {
                Toast.makeText(this, "Please accept both policies to continue.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            binding.loading.visibility = View.VISIBLE
            lifecycleScope.launch {
                runCatching { repo.acceptTermsOfService() }
                    .onSuccess {
                        startActivity(Intent(this@TermsActivity, DashboardActivity::class.java))
                        finish()
                    }
                    .onFailure {
                        binding.loading.visibility = View.GONE
                        Toast.makeText(this@TermsActivity, it.message ?: "Could not save agreement", Toast.LENGTH_LONG).show()
                    }
            }
        }

        binding.signOut.setOnClickListener {
            repo.signOut()
            startActivity(Intent(this, AuthActivity::class.java))
            finish()
        }
    }
}
