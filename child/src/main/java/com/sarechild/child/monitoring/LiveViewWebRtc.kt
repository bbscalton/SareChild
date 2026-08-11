package com.sarechild.child.monitoring

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import com.sarechild.shared.SareChildConstants
import com.sarechild.child.BuildConfig

/**
 * WebRTC publisher helpers for child-side live viewing (camera / mic / screen).
 */
object LiveViewWebRtc {
    fun createFactory(context: Context, eglBase: EglBase): PeerConnectionFactory {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )
        val encoderFactory = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)
        val audioModule = JavaAudioDeviceModule.builder(context).createAudioDeviceModule()
        return PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .setAudioDeviceModule(audioModule)
            .createPeerConnectionFactory()
    }

    fun iceServers(): List<PeerConnection.IceServer> {
        val servers = mutableListOf(
            PeerConnection.IceServer.builder(SareChildConstants.STUN_SERVER).createIceServer()
        )
        val user = BuildConfig.TURN_USERNAME.trim()
        val cred = BuildConfig.TURN_CREDENTIAL.trim()
        if (user.isNotEmpty() && cred.isNotEmpty()) {
            servers += PeerConnection.IceServer.builder(SareChildConstants.TURN_SERVER_URL)
                .setUsername(user)
                .setPassword(cred)
                .createIceServer()
        }
        return servers
    }

    fun createCameraCapturer(context: Context, front: Boolean): VideoCapturer? {
        val enumerator = Camera2Enumerator(context)
        val deviceNames = enumerator.deviceNames
        val target = deviceNames.firstOrNull { name ->
            if (front) enumerator.isFrontFacing(name) else enumerator.isBackFacing(name)
        } ?: deviceNames.firstOrNull()
        return target?.let { enumerator.createCapturer(it, null) }
    }

    fun createScreenCapturer(resultData: Intent): VideoCapturer =
        ScreenCapturerAndroid(resultData, object : MediaProjection.Callback() {})

    fun attachVideoTrack(
        factory: PeerConnectionFactory,
        eglBase: EglBase,
        capturer: VideoCapturer,
        context: Context,
        width: Int = 640,
        height: Int = 480,
        fps: Int = 24,
    ): VideoTrack {
        val helper = SurfaceTextureHelper.create("LiveViewCapture", eglBase.eglBaseContext)
        val source = factory.createVideoSource(capturer.isScreencast)
        capturer.initialize(helper, context, source.capturerObserver)
        capturer.startCapture(width, height, fps)
        return factory.createVideoTrack("live_video", source)
    }

    fun attachAudioTrack(factory: PeerConnectionFactory): AudioTrack {
        val constraints = MediaConstraints()
        val source = factory.createAudioSource(constraints)
        return factory.createAudioTrack("live_audio", source)
    }

    fun parseSessionDescription(map: Map<String, Any?>?): SessionDescription? {
        if (map == null) return null
        val type = map["type"] as? String ?: return null
        val sdp = map["sdp"] as? String ?: return null
        val sdType = when (type.lowercase()) {
            "offer" -> SessionDescription.Type.OFFER
            "answer" -> SessionDescription.Type.ANSWER
            else -> return null
        }
        return SessionDescription(sdType, sdp)
    }

    fun sessionDescriptionMap(desc: SessionDescription): Map<String, String> = mapOf(
        "type" to desc.type.canonicalForm(),
        "sdp" to desc.description
    )

    fun iceCandidateMap(candidate: IceCandidate): Map<String, Any?> = mapOf(
        "candidate" to candidate.sdp,
        "sdpMid" to candidate.sdpMid,
        "sdpMLineIndex" to candidate.sdpMLineIndex,
        "atMs" to System.currentTimeMillis()
    )

    fun parseIceCandidate(map: Map<String, Any?>): IceCandidate? {
        val sdp = map["candidate"] as? String ?: return null
        val mid = map["sdpMid"] as? String
        val index = (map["sdpMLineIndex"] as? Number)?.toInt() ?: 0
        return IceCandidate(mid, index, sdp)
    }
}
