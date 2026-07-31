package com.sarechild.child.ui

import android.content.Context
import android.os.Build
import android.os.CountDownTimer
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.widget.TextView
import com.sarechild.shared.SareChildConstants

/**
 * Drives the "auto-allow" safety countdown shown on every parent-initiated
 * in-app Allow screen (screen share / camera check / mic check requests,
 * routed through SafetyRequestActivity). If a child can't reach the phone —
 * the exact scenario this exists for — the request is allowed automatically
 * once the timer reaches zero instead of leaving a parent stuck during an
 * emergency. Tapping Allow or Not now at any point cancels the countdown.
 *
 * This intentionally never touches OS-controlled system permission dialogs
 * (camera/mic/screen-capture consent) — those still require a real tap from
 * the user or the child; this only governs our own in-app "please allow"
 * screens.
 */
class AllowCountdownController(
    private val context: Context,
    private val ring: CountdownRingView,
    private val secondsLabel: TextView,
    private val totalSeconds: Int = SareChildConstants.PARENT_REQUEST_AUTO_ALLOW_SECONDS,
    private val onTick: ((secondsRemaining: Int) -> Unit)? = null,
    private val onAutoAllow: () -> Unit
) {
    private var timer: CountDownTimer? = null
    private var lastWholeSecond = -1

    var hasFinished = false
        private set

    fun start() {
        cancel()
        hasFinished = false
        lastWholeSecond = -1
        ring.setProgress(1f)
        secondsLabel.text = totalSeconds.toString()
        val totalMs = totalSeconds * 1000L
        timer = object : CountDownTimer(totalMs, 80L) {
            override fun onTick(msRemaining: Long) {
                val fraction = (msRemaining.toFloat() / totalMs).coerceIn(0f, 1f)
                ring.setProgress(fraction)
                val wholeSecond = ((msRemaining + 999) / 1000).toInt().coerceIn(0, totalSeconds)
                if (wholeSecond != lastWholeSecond) {
                    lastWholeSecond = wholeSecond
                    secondsLabel.text = wholeSecond.toString()
                    onTick?.invoke(wholeSecond)
                    if (wholeSecond in 1..5) buzz(strong = false)
                }
            }

            override fun onFinish() {
                if (hasFinished) return
                hasFinished = true
                ring.setProgress(0f)
                secondsLabel.text = "0"
                buzz(strong = true)
                onAutoAllow()
            }
        }.start()
    }

    fun cancel() {
        timer?.cancel()
        timer = null
    }

    private fun buzz(strong: Boolean) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
        val durationMs = if (strong) 260L else 45L
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(durationMs)
        }
    }
}
