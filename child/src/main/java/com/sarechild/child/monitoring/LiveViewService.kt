package com.sarechild.child.monitoring

import android.app.Activity
import android.util.Log
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.google.firebase.firestore.ListenerRegistration
import com.sarechild.child.HomeActivity
import com.sarechild.child.R
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import com.sarechild.shared.SafetyCommandStatus
import com.sarechild.shared.SareChildConstants
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.AudioTrack
import org.webrtc.VideoTrack
import org.webrtc.PeerConnection
import org.webrtc.RtpTransceiver
import org.webrtc.SessionDescription
import org.webrtc.VideoCapturer

/**
 * Foreground service that publishes camera / mic / screen over WebRTC while a parent
 * watches live. Signaling travels through Firestore `liveSessions/{sessionId}`.
 */
class LiveViewService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var repo: ChildRepository
    private var sessionId: String = ""
    private var commandId: String = ""
    private var durationMinutes: Int = SareChildConstants.LIVE_VIEW_DEFAULT_MINUTES
    private var enableVideo: Boolean = true
    private var enableAudio: Boolean = false
    private var enableScreen: Boolean = false
    private var cameraFront: Boolean = false
    private var recordEnabled: Boolean = false

    private var eglBase: EglBase? = null
    private var factory: org.webrtc.PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var videoCapturer: VideoCapturer? = null
    private var videoTrack: VideoTrack? = null
    private var audioTrack: AudioTrack? = null
    private var sessionListener: ListenerRegistration? = null
    private var timerJob: Job? = null
    private var appliedRemoteOffer = false
    private var remoteDescriptionApplied = false
    private var finishing = false
    private val appliedParentCandidateKeys = mutableSetOf<String>()
    private val pendingParentCandidates = mutableListOf<IceCandidate>()

    override fun onCreate() {
        super.onCreate()
        repo = ChildRepository(this)
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        sessionId = intent?.getStringExtra(SareChildConstants.EXTRA_LIVE_SESSION_ID).orEmpty()
        commandId = intent?.getStringExtra(SareChildConstants.EXTRA_COMMAND_ID).orEmpty()
        durationMinutes = intent?.getIntExtra(
            SareChildConstants.EXTRA_DURATION_MINUTES,
            SareChildConstants.LIVE_VIEW_DEFAULT_MINUTES
        )?.coerceIn(
            SareChildConstants.LIVE_VIEW_MIN_MINUTES,
            SareChildConstants.LIVE_VIEW_MAX_MINUTES
        ) ?: SareChildConstants.LIVE_VIEW_DEFAULT_MINUTES
        enableVideo = intent?.getBooleanExtra(SareChildConstants.EXTRA_LIVE_VIDEO, true) ?: true
        enableAudio = intent?.getBooleanExtra(SareChildConstants.EXTRA_LIVE_AUDIO, false) ?: false
        enableScreen = intent?.getBooleanExtra(SareChildConstants.EXTRA_LIVE_SCREEN, false) ?: false
        cameraFront = intent?.getBooleanExtra(SareChildConstants.EXTRA_CAMERA_FACING, false) ?: false
        recordEnabled = intent?.getBooleanExtra(SareChildConstants.EXTRA_LIVE_RECORD, false) ?: false

        if (sessionId.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }

        if (enableScreen) {
            val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                ?: Activity.RESULT_CANCELED
            @Suppress("DEPRECATION")
            val data = if (Build.VERSION.SDK_INT >= 33) {
                intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
            } else {
                intent?.getParcelableExtra(EXTRA_RESULT_DATA)
            }
            if (resultCode != Activity.RESULT_OK || data == null) {
                scope.launch {
                    repo.updateLiveSession(sessionId, mapOf("status" to "failed", "error" to "Screen capture denied"))
                    if (commandId.isNotBlank()) {
                        repo.updateCommand(commandId, SafetyCommandStatus.FAILED, error = "Screen capture denied")
                    }
                }
                stopSelf()
                return START_NOT_STICKY
            }
            startAsForeground(includeProjection = true)
            beginWebRtc(screenIntent = data)
        } else {
            startAsForeground(includeProjection = false)
            beginWebRtc(screenIntent = null)
        }
        return START_STICKY
    }

    private fun beginWebRtc(screenIntent: Intent?) {
        scope.launch {
            runCatching {
                repo.updateLiveSession(
                    sessionId,
                    mapOf(
                        "status" to "connecting",
                        "acceptedAtMs" to System.currentTimeMillis()
                    )
                )
                if (commandId.isNotBlank()) {
                    repo.updateCommand(commandId, SafetyCommandStatus.RUNNING)
                }
                repo.setActiveSessionRemote("live_view")
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.LIVE_VIEW,
                        severity = AlertSeverity.MEDIUM,
                        title = "Live viewing — ${repo.childName}",
                        snippet = "Parent is watching live for about $durationMinutes minute(s)",
                        commandId = commandId.ifBlank { null }
                    )
                )
                initPeerConnection(screenIntent)
                listenForSignaling()
                startDurationTimer()
            }.onFailure { e ->
                Log.e(TAG, "WebRTC init failed session=$sessionId", e)
                repo.updateLiveSession(sessionId, mapOf("status" to "failed", "error" to (e.message ?: "WebRTC init failed")))
                if (commandId.isNotBlank()) {
                    repo.updateCommand(commandId, SafetyCommandStatus.FAILED, error = e.message)
                }
                stopSelf()
            }
        }
    }

    private fun initPeerConnection(screenIntent: Intent?) {
        eglBase = EglBase.create()
        factory = LiveViewWebRtc.createFactory(this, eglBase!!)
        val rtcConfig = PeerConnection.RTCConfiguration(LiveViewWebRtc.iceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        peerConnection = factory!!.createPeerConnection(
            rtcConfig,
            object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                    Log.i(TAG, "ICE state=$state session=$sessionId")
                    if (state == PeerConnection.IceConnectionState.CONNECTED ||
                        state == PeerConnection.IceConnectionState.COMPLETED
                    ) {
                        scope.launch {
                            repo.updateLiveSession(
                                sessionId,
                                mapOf(
                                    "status" to "active",
                                    "startedAtMs" to System.currentTimeMillis(),
                                    "endsAtMs" to System.currentTimeMillis() + durationMinutes * 60_000L
                                )
                            )
                        }
                    }
                }
                override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) = Unit
                override fun onIceCandidate(candidate: IceCandidate?) {
                    candidate ?: return
                    scope.launch {
                        repo.addLiveSessionIceCandidate(sessionId, "child", LiveViewWebRtc.iceCandidateMap(candidate))
                    }
                }
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
                override fun onAddStream(stream: org.webrtc.MediaStream?) = Unit
                override fun onRemoveStream(stream: org.webrtc.MediaStream?) = Unit
                override fun onDataChannel(channel: org.webrtc.DataChannel?) = Unit
                override fun onRenegotiationNeeded() = Unit
                override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) = Unit
            }
        )

        val pc = peerConnection ?: return
        val f = factory ?: return
        val egl = eglBase ?: return

        if (enableScreen && screenIntent != null) {
            videoCapturer = LiveViewWebRtc.createScreenCapturer(screenIntent)
            val track = LiveViewWebRtc.attachVideoTrack(f, egl, videoCapturer!!, this@LiveViewService, 720, 1280, 15)
            videoTrack = track
            pc.addTrack(track, listOf("live_stream"))
        } else if (enableVideo) {
            videoCapturer = LiveViewWebRtc.createCameraCapturer(this, cameraFront)
                ?: error("No camera available")
            val track = LiveViewWebRtc.attachVideoTrack(f, egl, videoCapturer!!, this@LiveViewService)
            videoTrack = track
            pc.addTrack(track, listOf("live_stream"))
        }
        if (enableAudio) {
            val audio = LiveViewWebRtc.attachAudioTrack(f)
            audioTrack = audio
            pc.addTrack(audio, listOf("live_stream"))
        }
    }

    private fun flushParentIceCandidates() {
        val pc = peerConnection ?: return
        pendingParentCandidates.forEach { pc.addIceCandidate(it) }
        pendingParentCandidates.clear()
    }

    private fun enqueueParentCandidate(candidate: IceCandidate) {
        val key = candidate.sdp
        if (!appliedParentCandidateKeys.add(key)) return
        if (remoteDescriptionApplied) {
            peerConnection?.addIceCandidate(candidate)
        } else {
            pendingParentCandidates.add(candidate)
        }
    }

    private fun listenForSignaling() {
        sessionListener = repo.listenLiveSession(sessionId) { data ->
            val status = data["status"] as? String
            if (status == "ended" || status == "failed" || status == "declined") {
                val reason = (data["endReason"] as? String)
                    ?: (data["error"] as? String)
                    ?: status
                    ?: "Session ended"
                finishSession(reason, remoteEnded = true)
                return@listenLiveSession
            }
            val offerMap = data["offer"] as? Map<String, Any?>
            if (!appliedRemoteOffer && offerMap != null) {
                val offer = LiveViewWebRtc.parseSessionDescription(offerMap) ?: return@listenLiveSession
                appliedRemoteOffer = true
                peerConnection?.setRemoteDescription(object : org.webrtc.SdpObserver {
                    override fun onCreateSuccess(desc: SessionDescription?) = Unit
                    override fun onSetSuccess() {
                        remoteDescriptionApplied = true
                        Log.i(TAG, "Remote offer applied for session $sessionId")
                        flushParentIceCandidates()
                        peerConnection?.createAnswer(object : org.webrtc.SdpObserver {
                            override fun onCreateSuccess(desc: SessionDescription?) {
                                desc ?: return
                                peerConnection?.setLocalDescription(object : org.webrtc.SdpObserver {
                                    override fun onCreateSuccess(d: SessionDescription?) = Unit
                                    override fun onSetSuccess() {
                                        scope.launch {
                                            repo.updateLiveSession(
                                                sessionId,
                                                mapOf("answer" to LiveViewWebRtc.sessionDescriptionMap(desc))
                                            )
                                        }
                                    }
                                    override fun onCreateFailure(error: String?) = Unit
                                    override fun onSetFailure(error: String?) = Unit
                                }, desc)
                            }
                            override fun onSetSuccess() = Unit
                            override fun onCreateFailure(error: String?) = Unit
                            override fun onSetFailure(error: String?) = Unit
                        }, org.webrtc.MediaConstraints())
                    }
                    override fun onCreateFailure(error: String?) = Unit
                    override fun onSetFailure(error: String?) {
                        appliedRemoteOffer = false
                    }
                }, offer)
            }
            val parentCandidates = data["parentCandidates"] as? List<Map<String, Any?>> ?: emptyList()
            parentCandidates.forEach { map ->
                LiveViewWebRtc.parseIceCandidate(map)?.let { enqueueParentCandidate(it) }
            }
        }
    }

    private fun startDurationTimer() {
        timerJob?.cancel()
        timerJob = scope.launch {
            delay(durationMinutes * 60_000L)
            if (isActive) finishSession("Duration reached")
        }
    }

    private fun finishSession(reason: String, remoteEnded: Boolean = false) {
        if (finishing) return
        finishing = true
        scope.launch {
            if (!remoteEnded) {
                repo.updateLiveSession(
                    sessionId,
                    mapOf(
                        "status" to "ended",
                        "endedAtMs" to System.currentTimeMillis(),
                        "endReason" to reason
                    )
                )
                if (commandId.isNotBlank()) {
                    repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
                }
                repo.postAlert(
                    FamilyAlert(
                        type = AlertType.LIVE_VIEW,
                        severity = AlertSeverity.LOW,
                        title = "Live viewing ended — ${repo.childName}",
                        snippet = reason,
                        commandId = commandId.ifBlank { null }
                    )
                )
            } else if (commandId.isNotBlank()) {
                repo.updateCommand(commandId, SafetyCommandStatus.COMPLETED)
            }
            repo.setActiveSessionRemote(null)
            stopSelf()
        }
    }

    override fun onDestroy() {
        sessionListener?.remove()
        sessionListener = null
        timerJob?.cancel()
        runCatching { videoCapturer?.stopCapture() }
        runCatching { videoCapturer?.dispose() }
        videoCapturer = null
        runCatching { videoTrack?.dispose() }
        videoTrack = null
        runCatching { audioTrack?.dispose() }
        audioTrack = null
        runCatching { peerConnection?.close() }
        runCatching { peerConnection?.dispose() }
        peerConnection = null
        runCatching { factory?.dispose() }
        factory = null
        runCatching { eglBase?.release() }
        eglBase = null
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startAsForeground(includeProjection: Boolean) {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var type = resolveLiveViewForegroundType(includeProjection)
            try {
                startForeground(SareChildConstants.LIVE_VIEW_NOTIFICATION_ID, notification, type)
            } catch (e: SecurityException) {
                // API 34+: missing runtime permission for a declared FGS type crashes here.
                Log.w(TAG, "FGS start failed type=$type — retrying with projection-only", e)
                val fallback = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                try {
                    startForeground(SareChildConstants.LIVE_VIEW_NOTIFICATION_ID, notification, fallback)
                } catch (e2: SecurityException) {
                    Log.e(TAG, "FGS start failed — stopping live view", e2)
                    stopSelf()
                }
            }
        } else {
            startForeground(SareChildConstants.LIVE_VIEW_NOTIFICATION_ID, notification)
        }
    }

    private fun resolveLiveViewForegroundType(includeProjection: Boolean): Int {
        var type = 0
        if (enableVideo && !enableScreen) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        if (enableAudio) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        if (includeProjection || enableScreen) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        }
        return type
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, HomeActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, SareChildConstants.NOTIFICATION_CHANNEL_LIVE_VIEW)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Live viewing with parent")
            .setContentText("Camera/mic active — tap for app")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    SareChildConstants.NOTIFICATION_CHANNEL_LIVE_VIEW,
                    "Live viewing",
                    NotificationManager.IMPORTANCE_LOW
                )
            )
        }
    }

    companion object {
        private const val TAG = "LiveViewService"
        const val EXTRA_RESULT_CODE = "live_projection_result_code"
        const val EXTRA_RESULT_DATA = "live_projection_result_data"
    }
}
