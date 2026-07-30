package com.sarechild.parent

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.sarechild.parent.data.ParentRepository
import com.sarechild.parent.databinding.ActivityAuthBinding
import kotlinx.coroutines.launch

class AuthActivity : AppCompatActivity() {
    private lateinit var binding: ActivityAuthBinding
    private val repo = ParentRepository()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityAuthBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.signIn.setOnClickListener { submit(signUp = false) }
        binding.signUp.setOnClickListener { submit(signUp = true) }
    }

    private fun submit(signUp: Boolean) {
        val email = binding.email.text?.toString()?.trim().orEmpty()
        val password = binding.password.text?.toString().orEmpty()
        binding.error.visibility = View.GONE
        binding.loading.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = if (signUp) repo.signUp(email, password) else repo.signIn(email, password)
            binding.loading.visibility = View.GONE
            result.onSuccess {
                startActivity(Intent(this@AuthActivity, DashboardActivity::class.java))
                finish()
            }.onFailure {
                binding.error.text = it.message ?: "Auth failed"
                binding.error.visibility = View.VISIBLE
                Toast.makeText(this@AuthActivity, it.message, Toast.LENGTH_LONG).show()
            }
        }
    }
}
