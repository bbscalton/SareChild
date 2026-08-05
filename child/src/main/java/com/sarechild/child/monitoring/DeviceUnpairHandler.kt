package com.sarechild.child.monitoring

import android.content.Context
import android.content.Intent
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.ListenerRegistration
import com.sarechild.child.MainActivity
import com.sarechild.child.data.ChildRepository
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Detects that a parent removed this device from the parent app (see
 * functions/src/deviceDelete.ts deletePairedDevice) and clears local pairing so the
 * device stops uploading and returns to the pairing screen. Two independent signals
 * feed into [unpair], since either one alone can be delayed or missed:
 *  1. An FCM data push ({type: "UNPAIR"}) — see ChildFirebaseMessagingService —
 *     delivered immediately even while the app is backgrounded.
 *  2. A direct Firestore listener on this device's own doc: once the parent deletes
 *     it, isDeviceMember() in firestore.rules can no longer read it, so the listener
 *     receives PERMISSION_DENIED (not just "doc missing") — that failure is the
 *     fallback removal signal on reconnect/app restart if the push never arrived.
 */
class DeviceUnpairHandler(
    private val context: Context,
    private val repo: ChildRepository
) {
    private var registration: ListenerRegistration? = null
    private val unpaired = AtomicBoolean(false)

    fun start() {
        stop()
        val fid = repo.familyId ?: return
        val did = repo.deviceId ?: return
        registration = repo.listenDeviceDoc(fid, did) { exists, error ->
            val permissionDenied = error?.code == FirebaseFirestoreException.Code.PERMISSION_DENIED
            if (permissionDenied || (error == null && !exists)) {
                unpair()
            }
        }
    }

    fun stop() {
        registration?.remove()
        registration = null
    }

    /** Idempotent — a listener that keeps erroring after removal must not repeat this. */
    fun unpair() {
        if (!unpaired.compareAndSet(false, true)) return
        stop()
        repo.clearPairing()
        context.stopService(Intent(context, MonitoringForegroundService::class.java))
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        context.startActivity(intent)
    }

    companion object {
        /** Entry point for the FCM UNPAIR data message — see ChildFirebaseMessagingService. */
        fun handleFcmUnpair(context: Context, repo: ChildRepository) {
            DeviceUnpairHandler(context, repo).unpair()
        }
    }
}
