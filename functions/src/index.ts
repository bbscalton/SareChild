import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { runPurgeInactiveTrials } from "./purgeTrials";
import { runPurgeExpiredRetentionData } from "./purgeRetention";

export {
  adminWipeUser,
  adminDeleteUser,
  adminRevokeSessions,
  adminAdjustTrial,
  adminTriggerPurgeTrials,
  adminSetRetention,
  adminSetChatVideoLimit,
  adminTriggerPurgeRetention,
  adminRepairOrphans,
  adminSendTestFcm,
} from "./admin";
export { deletePairedDevice } from "./deviceDelete";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const WENT_DARK_MS = 5 * 60 * 1000;
const ALERT_RETENTION_DAYS = 30;
const MEDIA_RETENTION_DAYS = 7;

/** Daily cron: warns or purges inactive trial accounts (see purgeTrials.ts). */
export const purgeInactiveTrials = onSchedule("every 24 hours", async () => {
  await runPurgeInactiveTrials();
});

/** Daily cron: purges operational family data older than retentionDays (default 2). */
export const purgeExpiredRetentionData = onSchedule("every 24 hours", async () => {
  await runPurgeExpiredRetentionData();
});

type FcmMessage = {
  notification: { title: string; body: string };
  data: Record<string, string>;
};

type SafetySettings = {
  escalationEnabled: boolean;
  escalationRiskThreshold: number;
  autoLockOnCritical: boolean;
  checkInIntervalMinutes: number;
  snoozedCategories: string[];
  snoozeUntilMs: number;
  alertRetentionDays: number;
  mediaRetentionDays: number;
};

async function loadSafetySettings(familyId: string): Promise<SafetySettings> {
  const doc = await db
    .collection("families")
    .doc(familyId)
    .collection("safetySettings")
    .doc("default")
    .get();
  return {
    escalationEnabled: (doc.get("escalationEnabled") as boolean | undefined) ?? true,
    escalationRiskThreshold: (doc.get("escalationRiskThreshold") as number | undefined) ?? 60,
    autoLockOnCritical: (doc.get("autoLockOnCritical") as boolean | undefined) ?? false,
    checkInIntervalMinutes: (doc.get("checkInIntervalMinutes") as number | undefined) ?? 120,
    snoozedCategories: (doc.get("snoozedCategories") as string[] | undefined) ?? [],
    snoozeUntilMs: (doc.get("snoozeUntilMs") as number | undefined) ?? 0,
    alertRetentionDays: (doc.get("alertRetentionDays") as number | undefined) ?? ALERT_RETENTION_DAYS,
    mediaRetentionDays: (doc.get("mediaRetentionDays") as number | undefined) ?? MEDIA_RETENTION_DAYS,
  };
}

/**
 * Resolves every recipient uid for a family (the legacy parentUid plus every
 * guardian listed in families/{familyId}/guardians) and their FCM tokens.
 */
async function collectFamilyTokens(
  familyId: string,
  parentUid?: string | null
): Promise<Map<string, string[]>> {
  const uids = new Set<string>();
  if (parentUid) uids.add(parentUid);

  const guardians = await db
    .collection("families")
    .doc(familyId)
    .collection("guardians")
    .get();
  guardians.docs.forEach((g) => uids.add(g.id));

  const tokensByUid = new Map<string, string[]>();
  await Promise.all(
    Array.from(uids).map(async (uid) => {
      const profile = await db.collection("parentProfiles").doc(uid).get();
      const tokens = (profile.get("fcmTokens") as string[] | undefined) ?? [];
      if (tokens.length) tokensByUid.set(uid, tokens);
    })
  );
  return tokensByUid;
}

/** Sends an FCM notification to every guardian + parent of a family, pruning dead tokens. */
async function sendToFamily(
  familyId: string,
  parentUid: string | null | undefined,
  message: FcmMessage
): Promise<void> {
  const tokensByUid = await collectFamilyTokens(familyId, parentUid);
  if (tokensByUid.size === 0) {
    logger.info("No FCM tokens for family", familyId);
    return;
  }

  const allTokens: string[] = [];
  const ownerOfToken = new Map<string, string>();
  tokensByUid.forEach((tokens, uid) => {
    tokens.forEach((t) => {
      allTokens.push(t);
      ownerOfToken.set(t, uid);
    });
  });

  const response = await admin.messaging().sendEachForMulticast({
    tokens: allTokens,
    notification: message.notification,
    data: message.data,
    android: { priority: "high" },
  });

  const badByUid = new Map<string, string[]>();
  response.responses.forEach((r, i) => {
    if (!r.success) {
      const token = allTokens[i];
      const uid = ownerOfToken.get(token);
      if (!uid) return;
      const list = badByUid.get(uid) ?? [];
      list.push(token);
      badByUid.set(uid, list);
    }
  });

  await Promise.all(
    Array.from(badByUid.entries()).map(([uid, bad]) =>
      db
        .collection("parentProfiles")
        .doc(uid)
        .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...bad) })
    )
  );
}

/** Fan out FCM to the parent and all guardians when a family alert is created. */
export const onAlertCreated = onDocumentCreated(
  "families/{familyId}/alerts/{alertId}",
  async (event) => {
    const familyId = event.params.familyId;
    const data = event.data?.data();
    if (!data) return;

    const familySnap = await db.collection("families").doc(familyId).get();
    const parentUid = familySnap.get("parentUid") as string | undefined;
    const settings = await loadSafetySettings(familyId);
    const now = Date.now();
    const category = String(data.category ?? "");
    if (now < settings.snoozeUntilMs && settings.snoozedCategories.includes(category)) {
      logger.info("Alert category snoozed", familyId, category);
      return;
    }

    const title = (data.title as string) || "SareChild alert";
    const body = (data.snippet as string) || (data.type as string) || "Open SareChild";

    await sendToFamily(familyId, parentUid, {
      notification: { title, body },
      data: {
        type: String(data.type ?? ""),
        severity: String(data.severity ?? ""),
        familyId,
        alertId: event.params.alertId,
      },
    });

    const riskScore = Number(data.riskScore ?? 0);
    const severity = String(data.severity ?? "LOW");
    const shouldEscalate =
      settings.escalationEnabled &&
      (riskScore >= settings.escalationRiskThreshold ||
        severity === "CRITICAL" ||
        data.type === "UNIDENTIFIED_CONTACT");
    if (shouldEscalate) {
      await db.collection("families").doc(familyId).collection("alerts").add({
        type: "TAMPER",
        severity: "HIGH",
        title: "Escalation triggered",
        snippet: `Auto escalation from ${String(data.type ?? "alert")} (risk ${riskScore})`,
        deviceId: String(data.deviceId ?? ""),
        createdAtMs: Date.now(),
        read: false,
        retainUntilMs: Date.now() + settings.alertRetentionDays * 24 * 60 * 60 * 1000,
      });
      if (settings.autoLockOnCritical && data.deviceId) {
        await db.collection("families").doc(familyId).collection("commands").add({
          type: "LOCK_DEVICE",
          status: "PENDING",
          deviceId: String(data.deviceId),
          requestedAtMs: Date.now(),
          acceptedAtMs: null,
          completedAtMs: null,
          resultPath: null,
          resultUrl: null,
          error: null,
          durationMinutes: null,
        });
      }
    }
  }
);

/** Mark devices offline / create went-dark alerts when heartbeat is stale. */
export const checkWentDark = onSchedule("every 5 minutes", async () => {
  const cutoff = Date.now() - WENT_DARK_MS;
  const families = await db.collection("families").get();

  for (const family of families.docs) {
    const devices = await family.ref.collection("devices").get();
    for (const device of devices.docs) {
      const lastHb = (device.get("lastHeartbeatMs") as number) || 0;
      const alreadyOffline = device.get("online") === false;
      const wentDarkAlerted = device.get("wentDarkAlerted") === true;

      if (lastHb > 0 && lastHb < cutoff) {
        if (!alreadyOffline) {
          await device.ref.update({ online: false });
        }
        if (!wentDarkAlerted) {
          await family.ref.collection("alerts").add({
            type: "WENT_DARK",
            severity: "HIGH",
            title: `Device went dark — ${device.get("childName") || "Child"}`,
            snippet: "No heartbeat from the child device",
            deviceId: device.id,
            createdAtMs: Date.now(),
            read: false,
            retainUntilMs: Date.now() + ALERT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
          });
          await device.ref.update({ wentDarkAlerted: true });
        }
      } else if (lastHb >= cutoff && wentDarkAlerted) {
        await device.ref.update({ wentDarkAlerted: false, online: true });
      }
    }
  }
});

/** Optional daily cleanup of expired alerts. */
export const purgeExpiredAlerts = onSchedule("every 24 hours", async () => {
  const now = Date.now();
  const families = await db.collection("families").get();
  for (const family of families.docs) {
    const settings = await loadSafetySettings(family.id);
    const cutoff = now - settings.alertRetentionDays * 24 * 60 * 60 * 1000;
    const expired = await family.ref
      .collection("alerts")
      .where("createdAtMs", "<", cutoff)
      .limit(200)
      .get();
    const batch = db.batch();
    expired.docs.forEach((d) => batch.delete(d.ref));
    if (!expired.empty) await batch.commit();
  }
});

/** Daily cleanup of media (screen frames, photos, audio) older than the retention window. */
export const purgeExpiredMedia = onSchedule("every 24 hours", async () => {
  const now = Date.now();
  const bucket = admin.storage().bucket();
  const [files] = await bucket.getFiles({ prefix: "families/" });
  const families = await db.collection("families").get();
  const retentionByFamily = new Map<string, number>();
  await Promise.all(
    families.docs.map(async (f) => {
      const s = await loadSafetySettings(f.id);
      retentionByFamily.set(f.id, s.mediaRetentionDays);
    })
  );

  let deleted = 0;
  await Promise.all(
    files.map(async (file) => {
      const createdRaw = file.metadata.timeCreated;
      if (!createdRaw) return;
      const createdMs = new Date(createdRaw).getTime();
      if (Number.isNaN(createdMs)) return;
      const parts = file.name.split("/");
      const familyId = parts.length >= 2 && parts[0] === "families" ? parts[1] : "";
      const retentionDays = retentionByFamily.get(familyId) ?? MEDIA_RETENTION_DAYS;
      const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
      if (createdMs >= cutoffMs) return;
      try {
        await file.delete();
        deleted++;
      } catch (err) {
        logger.warn("Failed to delete expired media", file.name, err);
      }
    })
  );
  logger.info(`purgeExpiredMedia deleted ${deleted} file(s)`);
});

// ---------- Family chat push (per-device, emergency-aware) ----------
// Each paired device has its own isolated chat thread
// (families/{familyId}/devices/{deviceId}/chatMessages/{msgId}) — a message there should
// reach the family owner (parent), every guardian *assigned to that specific device*, and
// that device itself (when the sender isn't the device), never every other device's thread.
// Deliberately separate from sendToFamily()/onAlertCreated above: chat has its own recipient
// set (the child device is a real push target here, not just guardians) and its own urgency
// escalation.
const URGENT_CHAT_KEYWORDS = [
  "help", "emergency", "911", "sos", "danger", "unsafe", "scared",
  "hurt me", "please help", "call the police", "i'm in trouble", "im in trouble",
  "can't breathe", "cant breathe", "kidnap", "following me", "someone is here",
  "i need help", "not safe", "he hit me", "she hit me", "bleeding",
];

function isUrgentChatText(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return URGENT_CHAT_KEYWORDS.some((kw) => normalized.includes(kw));
}

interface TokenOwner {
  ref: FirebaseFirestore.DocumentReference;
  tokens: string[];
}

/**
 * Recipients for one device's chat thread: the family owner (parent) plus every guardian
 * listed in that device's `assignedGuardianUids` — never every guardian in the family, and
 * never any other device. [excludeUid] drops the sender so they don't get pushed their own
 * message.
 */
async function collectDeviceChatGuardianTokenRefs(
  familyId: string,
  deviceSnap: FirebaseFirestore.DocumentSnapshot,
  parentUid?: string | null,
  excludeUid?: string | null
): Promise<Map<string, TokenOwner>> {
  const uids = new Set<string>();
  if (parentUid) uids.add(parentUid);
  const assigned = (deviceSnap.get("assignedGuardianUids") as string[] | undefined) ?? [];
  assigned.forEach((uid) => uids.add(uid));
  if (excludeUid) uids.delete(excludeUid);

  const result = new Map<string, TokenOwner>();
  await Promise.all(
    Array.from(uids).map(async (uid) => {
      const ref = db.collection("parentProfiles").doc(uid);
      const profile = await ref.get();
      const tokens = (profile.get("fcmTokens") as string[] | undefined) ?? [];
      if (tokens.length) result.set(uid, { ref, tokens });
    })
  );
  return result;
}

/** This one device's own FCM tokens (its push target when a parent/guardian messages it). */
function collectSingleDeviceTokens(
  deviceSnap: FirebaseFirestore.DocumentSnapshot
): Map<string, TokenOwner> {
  const result = new Map<string, TokenOwner>();
  const tokens = (deviceSnap.get("fcmTokens") as string[] | undefined) ?? [];
  if (tokens.length) result.set(deviceSnap.id, { ref: deviceSnap.ref, tokens });
  return result;
}

/** Generic multicast sender that prunes dead tokens off whichever doc registered them. */
async function sendMulticastAndPrune(
  tokens: string[],
  ownerOfToken: Map<string, FirebaseFirestore.DocumentReference>,
  message: FcmMessage,
  androidNotification: admin.messaging.AndroidNotification
): Promise<void> {
  if (tokens.length === 0) return;
  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: message.notification,
    data: message.data,
    android: {
      priority: "high",
      notification: androidNotification,
    },
  });

  const badByPath = new Map<string, { ref: FirebaseFirestore.DocumentReference; tokens: string[] }>();
  response.responses.forEach((r, i) => {
    if (!r.success) {
      const token = tokens[i];
      const ref = ownerOfToken.get(token);
      if (!ref) return;
      const entry = badByPath.get(ref.path) ?? { ref, tokens: [] };
      entry.tokens.push(token);
      badByPath.set(ref.path, entry);
    }
  });
  await Promise.all(
    Array.from(badByPath.values()).map(({ ref, tokens: bad }) =>
      ref.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...bad) }).catch(() => undefined)
    )
  );
}

/**
 * Fan out a push to everyone who can see *this specific device's* chat thread, except the
 * sender — the parent + every guardian assigned to this device get a message the child
 * sent, and the child device gets a message the parent/an assigned guardian sent. Never
 * touches any other device's thread. Messages that look urgent (keyword match) escalate to
 * the louder "family_chat_urgent" channel/sound.
 */
export const onDeviceChatMessageCreated = onDocumentCreated(
  "families/{familyId}/devices/{deviceId}/chatMessages/{messageId}",
  async (event) => {
    const familyId = event.params.familyId;
    const deviceId = event.params.deviceId;
    const data = event.data?.data();
    if (!data) return;

    const senderUid = String(data.senderUid ?? "");
    const senderName = String(data.senderName ?? "Family member");
    const senderRole = String(data.senderRole ?? "GUARDIAN").toUpperCase();
    const text = (data.text as string | undefined) ?? null;
    const mediaType = (data.mediaType as string | undefined) ?? null;

    const bodyPreview = text
      ? text.length > 160
        ? `${text.slice(0, 157)}...`
        : text
      : mediaType === "image"
        ? "📷 Sent a photo"
        : mediaType === "video"
          ? "🎥 Sent a video"
          : mediaType === "audio"
            ? "🎤 Sent a voice message"
            : "Sent a message";

    const [familySnap, deviceSnap] = await Promise.all([
      db.collection("families").doc(familyId).get(),
      db.collection("families").doc(familyId).collection("devices").doc(deviceId).get(),
    ]);
    if (!deviceSnap.exists) return;
    const parentUid = familySnap.get("parentUid") as string | undefined;
    const childName = String(deviceSnap.get("childName") ?? "Child");

    const urgent = isUrgentChatText(text);
    const title = urgent ? `🚨 Urgent — ${senderName}` : `${senderName} · ${childName}'s chat`;

    const guardianRefs = await collectDeviceChatGuardianTokenRefs(
      familyId,
      deviceSnap,
      parentUid,
      senderUid || undefined
    );
    const deviceRefs =
      senderRole === "CHILD" ? new Map<string, TokenOwner>() : collectSingleDeviceTokens(deviceSnap);

    const tokens: string[] = [];
    const ownerOfToken = new Map<string, FirebaseFirestore.DocumentReference>();
    [guardianRefs, deviceRefs].forEach((map) => {
      map.forEach(({ ref, tokens: t }) => {
        t.forEach((tok) => {
          tokens.push(tok);
          ownerOfToken.set(tok, ref);
        });
      });
    });

    if (tokens.length === 0) {
      logger.info("onDeviceChatMessageCreated: no recipient tokens", familyId, deviceId);
      return;
    }

    const channelId = urgent ? "family_chat_urgent" : "family_chat";
    await sendMulticastAndPrune(
      tokens,
      ownerOfToken,
      {
        notification: { title, body: bodyPreview },
        data: {
          type: "FAMILY_CHAT",
          screen: "family_chat",
          familyId,
          deviceId,
          messageId: event.params.messageId,
          senderUid,
          senderRole,
          urgent: String(urgent),
          title,
          body: bodyPreview,
        },
      },
      {
        channelId,
        visibility: "public",
        sound: "default",
        priority: urgent ? "max" : "high",
      }
    );

    logger.info(
      `onDeviceChatMessageCreated: family=${familyId} device=${deviceId} sender=${senderRole} urgent=${urgent} recipients=${tokens.length}`
    );
  }
);

export const platformHealth = onRequest(
  { cors: true },
  async (_req, res) => {
    const now = Date.now();
    const familiesSnap = await db.collection("families").limit(25).get();
    let deviceCount = 0;
    let staleCount = 0;
    for (const family of familiesSnap.docs) {
      const devices = await family.ref.collection("devices").get();
      deviceCount += devices.size;
      devices.docs.forEach((d) => {
        const hb = Number(d.get("lastHeartbeatMs") ?? 0);
        if (hb <= 0 || now - hb > WENT_DARK_MS) staleCount += 1;
      });
    }
    res.status(200).json({
      ok: true,
      generatedAtMs: now,
      sampleFamilyCount: familiesSnap.size,
      sampleDeviceCount: deviceCount,
      staleDeviceCount: staleCount,
      services: {
        firestore: "ok",
        storage: "ok",
        functions: "ok",
      },
    });
  }
);

export const autoRepairData = onSchedule("every 30 minutes", async () => {
  const now = Date.now();
  const families = await db.collection("families").get();
  for (const family of families.docs) {
    await family.ref.collection("safetySettings").doc("default").set(
      {
        escalationEnabled: true,
        escalationRiskThreshold: 60,
        autoLockOnCritical: false,
        checkInIntervalMinutes: 120,
        snoozedCategories: [],
        snoozeUntilMs: 0,
        alertRetentionDays: ALERT_RETENTION_DAYS,
        mediaRetentionDays: MEDIA_RETENTION_DAYS,
      },
      { merge: true }
    );
    const devices = await family.ref.collection("devices").get();
    for (const device of devices.docs) {
      const hb = Number(device.get("lastHeartbeatMs") ?? 0);
      if (hb > 0 && now - hb > WENT_DARK_MS && device.get("online") !== false) {
        await device.ref.set({ online: false }, { merge: true });
      }
    }
  }
});

const ALERT_TYPE_LABELS: Record<string, string> = {
  SOS: "SOS",
  KEYWORD: "Keyword match",
  GEOFENCE_ENTER: "Entered zone",
  GEOFENCE_EXIT: "Left zone",
  LOW_BATTERY: "Low battery",
  WENT_DARK: "Went dark",
  TAMPER: "Tamper detected",
  PERMISSION_REVOKED: "Permission revoked",
  SCREEN_SHARE: "Screen share",
  CAMERA_CHECK: "Camera check",
  MIC_CHECK: "Mic check",
  MESSAGE_PREVIEW: "Message preview",
  APP_INSTALL: "App installed",
  APP_UNINSTALL: "App uninstalled",
  RING_DEVICE: "Ring device",
  USAGE_LIMIT: "Usage limit reached",
  UNIDENTIFIED_CONTACT: "Unidentified contact",
  CALL_SMS_SYNC: "Call/SMS sync",
  TYPING_SAFETY: "Typing safety flag",
};

function weekIdFor(weekStartMs: number): string {
  return `week_${weekStartMs}`;
}

/** Every Monday 9am: summarize the last 7 days of alerts per family into a digest doc. */
export const weeklySafetyDigest = onSchedule("0 9 * * 1", async () => {
  const now = Date.now();
  const weekStartMs = now - 7 * 24 * 60 * 60 * 1000;
  const weekEndMs = now;
  const families = await db.collection("families").get();

  for (const family of families.docs) {
    const alertsSnap = await family.ref
      .collection("alerts")
      .where("createdAtMs", ">=", weekStartMs)
      .where("createdAtMs", "<=", weekEndMs)
      .get();

    const counts = new Map<string, number>();
    alertsSnap.docs.forEach((d) => {
      const type = (d.get("type") as string) || "UNKNOWN";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    });

    const topAlertTypes = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type]) => type);

    const alertCount = alertsSnap.size;
    const summary =
      alertCount === 0
        ? "No safety alerts this week — all quiet."
        : `${alertCount} alert${alertCount === 1 ? "" : "s"} this week. Top: ${topAlertTypes
            .map((t) => ALERT_TYPE_LABELS[t] || t)
            .join(", ")}.`;

    const weekId = weekIdFor(weekStartMs);
    await family.ref.collection("digests").doc(weekId).set({
      summary,
      alertCount,
      topAlertTypes,
      weekStartMs,
      weekEndMs,
      createdAtMs: now,
    });

    const parentUid = family.get("parentUid") as string | undefined;
    await sendToFamily(family.id, parentUid, {
      notification: {
        title: "Weekly safety digest ready",
        body: summary,
      },
      data: {
        familyId: family.id,
        digestId: weekId,
        type: "WEEKLY_DIGEST",
      },
    });
  }
});
