package com.sarechild.child.monitoring

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent
import com.sarechild.child.data.ChildRepository
import com.sarechild.shared.AlertSeverity
import com.sarechild.shared.AlertType
import com.sarechild.shared.FamilyAlert
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class GeofenceBroadcastReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) return
        val transition = event.geofenceTransition
        val type = when (transition) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> AlertType.GEOFENCE_ENTER
            Geofence.GEOFENCE_TRANSITION_EXIT -> AlertType.GEOFENCE_EXIT
            else -> return
        }
        val triggering = event.triggeringGeofences ?: return
        val repo = ChildRepository(context)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                for (g in triggering) {
                    val zone = repo.loadGeofenceById(g.requestId)
                    if (zone != null && !zone.isScheduleActiveNow()) continue
                    val name = zone?.name ?: g.requestId
                    repo.postAlert(
                        FamilyAlert(
                            type = type,
                            severity = AlertSeverity.MEDIUM,
                            title = if (type == AlertType.GEOFENCE_ENTER) {
                                "Entered $name"
                            } else {
                                "Left $name"
                            },
                            snippet = "Geofence transition on ${repo.childName}"
                        )
                    )
                }
            } finally {
                pending.finish()
            }
        }
    }
}
