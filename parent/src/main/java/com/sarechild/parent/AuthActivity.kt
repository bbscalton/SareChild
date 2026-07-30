package com.sarechild.parent

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.sarechild.parent.data.ParentRepository
import com.sarechild.parent.databinding.ActivityAuthBinding
import kotlinx.coroutines.launch

class AuthActivity : AppCompatActivity() {
    private lateinit var binding: ActivityAuthBinding
    private val repo = ParentRepository()
    private lateinit var googleSignInClient: GoogleSignInClient

    private val googleSignInLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val task = GoogleSignIn.getSignedInAccountFromIntent(result.data)
        try {
            val account = task.getResult(ApiException::class.java)
            val idToken = account.idToken
            if (idToken == null) {
                showError("Google sign-in failed: no ID token returned")
                return@registerForActivityResult
            }
            submitGoogleIdToken(idToken)
        } catch (e: ApiException) {
            showError("Google sign-in cancelled or failed (${e.statusCode})")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityAuthBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(getString(R.string.default_web_client_id))
            .requestEmail()
            .build()
        googleSignInClient = GoogleSignIn.getClient(this, gso)

        binding.signIn.setOnClickListener { submit(signUp = false) }
        binding.signUp.setOnClickListener { submit(signUp = true) }
        binding.googleSignIn.setOnClickListener {
            googleSignInLauncher.launch(googleSignInClient.signInIntent)
        }
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
                goToDashboard()
            }.onFailure {
                showError(it.message ?: "Auth failed")
            }
        }
    }

    private fun submitGoogleIdToken(idToken: String) {
        binding.error.visibility = View.GONE
        binding.loading.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = repo.signInWithGoogleIdToken(idToken)
            binding.loading.visibility = View.GONE
            result.onSuccess {
                goToDashboard()
            }.onFailure {
                val message = if (it is FirebaseAuthUserCollisionException) {
                    "An account already exists with this email using a password. Sign in with your email and password instead."
                } else {
                    it.message ?: "Google sign-in failed"
                }
                showError(message)
            }
        }
    }

    private fun goToDashboard() {
        startActivity(Intent(this@AuthActivity, DashboardActivity::class.java))
        finish()
    }

    private fun showError(message: String) {
        binding.error.text = message
        binding.error.visibility = View.VISIBLE
        Toast.makeText(this@AuthActivity, message, Toast.LENGTH_LONG).show()
    }
}
