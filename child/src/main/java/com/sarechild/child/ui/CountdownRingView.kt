package com.sarechild.child.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator

/**
 * Big, unmissable circular progress ring used for the parent-request
 * auto-allow countdown (see [AllowCountdownController]). Sweeps clockwise
 * from a full circle down to nothing as time runs out, with an optional
 * gentle pulse so a pending request is impossible to miss even at a glance.
 */
class CountdownRingView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.parseColor("#40FFFFFF")
    }
    private val progressPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        color = Color.WHITE
    }
    private val bounds = RectF()
    private var progress = 1f
    private var pulseScale = 1f
    private var pulseAnimator: ValueAnimator? = null

    var ringColor: Int
        get() = progressPaint.color
        set(value) {
            progressPaint.color = value
            invalidate()
        }

    var trackColor: Int
        get() = trackPaint.color
        set(value) {
            trackPaint.color = value
            invalidate()
        }

    /** 1f = full time remaining, 0f = out of time. */
    fun setProgress(fraction: Float) {
        progress = fraction.coerceIn(0f, 1f)
        invalidate()
    }

    fun startPulse() {
        pulseAnimator?.cancel()
        pulseAnimator = ValueAnimator.ofFloat(1f, 1.05f, 1f).apply {
            duration = 1100L
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener {
                pulseScale = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    fun stopPulse() {
        pulseAnimator?.cancel()
        pulseAnimator = null
        pulseScale = 1f
        invalidate()
    }

    override fun onDetachedFromWindow() {
        stopPulse()
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val strokeWidth = w.coerceAtMost(h) * 0.09f
        trackPaint.strokeWidth = strokeWidth
        progressPaint.strokeWidth = strokeWidth
        val inset = strokeWidth / 2f + 4f
        bounds.set(inset, inset, w - inset, h - inset)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save()
        canvas.scale(pulseScale, pulseScale, width / 2f, height / 2f)
        canvas.drawArc(bounds, 0f, 360f, false, trackPaint)
        canvas.drawArc(bounds, -90f, 360f * progress, false, progressPaint)
        canvas.restore()
    }
}
