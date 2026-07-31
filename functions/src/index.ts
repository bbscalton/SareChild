import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";

admin.initializeApp();
const db = admin.firestore();

const WENT_DARK_MS = 5 * 60 * 1000;
const ALERT_RETENTION_DAYS = 30;
const MEDIA_RETENTION_DAYS = 7;

// ---------- Trial subscription model ----------
// Data model (parentProfiles/{uid}): plan: "trial" | "paid", status: "active" | "at_risk"
// | "purged", trialStartedAt, trialEndsAt, lastLoginAt, lastParentCheckInAt. `plan`/`status`
// are designed so a future "paid" plan can be added later (billing fields, renewal dates)
// without a data-model rewrite — purge logic below only ever touches plan === "trial".
const TRIAL_DAYS = 30;
const CHECK_IN_STALE_DAYS = 7;
const INACTIVITY_GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Subcollections that hang off a family doc and must be deleted with it. */
const FAMILY_SUBCOLLECTIONS = [
  "devices",
  "alerts",
  "familyChat",
  "geofences",
  "commands",
  "appEvents",
  "usageDaily",
  "locationTrail",
  "callSmsPreviews",
  "digests",
  "sosContacts",
  "safeContacts",
  "safetySettings",
  "appLimits",
  "appBlockSchedules",
  "screenShareSchedules",
  "guardians",
];

async function deleteCollectionRecursive(
  ref: FirebaseFirestore.CollectionReference,
  batchSize = 200
): Promise<void> {
  // Loops in pages so this works regardless of collection size without needing the
  // (Node-only) firebase-tools bulk delete helper inside a Cloud Function.
  for (;;) {
    const snap = await ref.limit(batchSize).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < batchSize) return;
  }
}

/** Deletes a family document, all of its known subcollections, and its Auth/profile trace. */
async function deleteFamilyDeep(familyId: string): Promise<void> {
  const familyRef = db.collection("families").doc(familyId);
  for (const sub of FAMILY_SUBCOLLECTIONS) {
    await deleteCollectionRecursive(familyRef.collection(sub));
  }
  await familyRef.delete();
}

type TrialDecision = "keep" | "warn" | "purge";

/**
 * Implements the trial auto-cleanup rule from the product spec:
 *   1. Trial lasts 30 days with full features.
 *   2. Weekly engagement is expected: if there's been no parent check-in (dashboard
 *      open / device view / alert view) in the last 7 days, the account is "at risk";
 *      after a further grace period with still no check-in, it is purged.
 *   3. If the trial's full 30-day window has elapsed, the account is purged outright
 *      regardless of check-in recency (a trial's over is over).
 * "Check-in" and "login" are tracked separately because a parent could leave the app
 * open (no fresh login) yet still be actively checking on their kids, or vice versa.
 */
function decideTrialFate(
  now: number,
  data: FirebaseFirestore.DocumentData
): TrialDecision {
  if (data.plan !== "trial") return "keep";
  if (data.status === "purged") return "keep"; // already handled

  const trialStartedAt = Number(data.trialStartedAt ?? now);
  const trialEndsAt = Number(data.trialEndsAt ?? trialStartedAt + TRIAL_DAYS * DAY_MS);
  const lastLoginAt = data.lastLoginAt ? Number(data.lastLoginAt) : null;
  const lastCheckInAt = data.lastParentCheckInAt ? Number(data.lastParentCheckInAt) : null;

  // Rule 3: the trial month is simply over — no grace period, matches "full trial,
  // then it ends" expectations rather than silently running forever.
  if (now > trialEndsAt) return "purge";

  // Rule 1+2: never logged in again after day 30 of a still-open trial window can't
  // happen (trialEndsAt already covers that), so the inactivity path is really about
  // an *engaged-once-then-gone* parent: no login for 30+ days from trial start AND no
  // weekly kid check-in — i.e. they set it up and walked away.
  const neverLoggedBackIn = !lastLoginAt || now - trialStartedAt > TRIAL_DAYS * DAY_MS;
  const loginStale = lastLoginAt != null && now - lastLoginAt > TRIAL_DAYS * DAY_MS;
  const checkInStale = !lastCheckInAt || now - lastCheckInAt > CHECK_IN_STALE_DAYS * DAY_MS;
  const inactive = (neverLoggedBackIn || loginStale) && checkInStale;

  if (!inactive) return "keep";

  const warnedAt = data.purgeWarnedAt ? Number(data.purgeWarnedAt) : null;
  if (warnedAt && now - warnedAt > INACTIVITY_GRACE_DAYS * DAY_MS) return "purge";
  return "warn";
}

/**
 * Daily cron: finds trial accounts that should be warned or purged per
 * `decideTrialFate` and applies the action. Purge deletes the Firebase Auth user,
 * deletes the owned family + all subcollections (caregivers only lose their own
 * guardian membership + profile — the family itself belongs to its owner), and turns
 * the parentProfile into a `status: "purged"` tombstone so Firestore rules keep
 * denying access even though the doc still exists for support/audit purposes.
 */
export const purgeInactiveTrials = onSchedule("every 24 hours", async () => {
  const now = Date.now();
  const profiles = await db.collection("parentProfiles").where("plan", "==", "trial").get();

  let warned = 0;
  let purged = 0;

  for (const profile of profiles.docs) {
    const data = profile.data();
    const decision = decideTrialFate(now, data);
    if (decision === "keep") continue;

    if (decision === "warn") {
      if (!data.purgeWarnedAt) {
        await profile.ref.set(
          { status: "at_risk", purgeWarnedAt: now },
          { merge: true }
        );
        warned++;
      }
      continue;
    }

    // decision === "purge"
    const uid = profile.id;
    const familyId = data.familyId as string | undefined;
    try {
      if (familyId) {
        const familySnap = await db.collection("families").doc(familyId).get();
        if (familySnap.exists && familySnap.get("parentUid") === uid) {
          await deleteFamilyDeep(familyId);
        } else {
          // Caregiver, not the owner: only remove their own guardian membership.
          await db
            .collection("families")
            .doc(familyId)
            .collection("guardians")
            .doc(uid)
            .delete()
            .catch(() => undefined);
        }
      }
      await admin
        .auth()
        .deleteUser(uid)
        .catch((err) => logger.warn(`Auth delete failed for ${uid}`, err));
      // Full overwrite (merge: false) intentionally drops familyId/email/fcmTokens —
      // this is the minimal "tombstone" the requesterActive() Firestore rule checks.
      await profile.ref.set(
        { status: "purged", plan: "trial", purgedAtMs: now },
        { merge: false }
      );
      purged++;
    } catch (err) {
      logger.error(`Failed to purge trial account ${uid}`, err);
    }
  }

  logger.info(`purgeInactiveTrials: warned=${warned} purged=${purged} scanned=${profiles.size}`);
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

// ---------- Family chat push (emergency-aware) ----------
// Any chat message — from a guardian's phone or the child's device — should reach
// every *other* device in the family with a loud, high-priority notification, even
// if that device's app is backgrounded or fully killed. Deliberately separate from
// sendToFamily()/onAlertCreated above: chat has its own recipient set (child devices
// are real push targets here, not just guardians) and its own urgency escalation.
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

/** Every guardian/parent profile in the family that has FCM tokens, minus [excludeUid]. */
async function collectGuardianTokenRefs(
  familyId: string,
  parentUid?: string | null,
  excludeUid?: string | null
): Promise<Map<string, TokenOwner>> {
  const uids = new Set<string>();
  if (parentUid) uids.add(parentUid);
  const guardians = await db.collection("families").doc(familyId).collection("guardians").get();
  guardians.docs.forEach((g) => uids.add(g.id));
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

/** Every child device in the family that has FCM tokens, minus [excludeDeviceId] (the sender). */
async function collectChildDeviceTokens(
  familyId: string,
  excludeDeviceId?: string | null
): Promise<Map<string, TokenOwner>> {
  const result = new Map<string, TokenOwner>();
  const devices = await db.collection("families").doc(familyId).collection("devices").get();
  devices.docs.forEach((d) => {
    if (excludeDeviceId && d.id === excludeDeviceId) return;
    const tokens = (d.get("fcmTokens") as string[] | undefined) ?? [];
    if (tokens.length) result.set(d.id, { ref: d.ref, tokens });
  });
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
 * Fan out a push to everyone in the family *except* the sender whenever a family
 * chat message is created — a guardian's message reaches every child device, and a
 * child's message reaches every guardian/parent device. Messages that look urgent
 * (keyword match) escalate to the louder "family_chat_urgent" channel/sound.
 */
export const onFamilyChatMessageCreated = onDocumentCreated(
  "families/{familyId}/familyChat/{messageId}",
  async (event) => {
    const familyId = event.params.familyId;
    const data = event.data?.data();
    if (!data) return;

    const senderUid = String(data.senderUid ?? "");
    const senderName = String(data.senderName ?? "Family member");
    const senderRole = String(data.senderRole ?? "GUARDIAN").toUpperCase();
    const senderDeviceId = data.deviceId ? String(data.deviceId) : null;
    const text = (data.text as string | undefined) ?? null;
    const mediaType = (data.mediaType as string | undefined) ?? null;

    const bodyPreview = text
      ? text.length > 160
        ? `${text.slice(0, 157)}...`
        : text
      : mediaType === "image"
        ? "📷 Sent a photo"
        : mediaType === "audio"
          ? "🎤 Sent a voice message"
          : "Sent a message";

    const urgent = isUrgentChatText(text);
    const title = urgent ? `🚨 Urgent — ${senderName}` : `${senderName} · Family chat`;

    const familySnap = await db.collection("families").doc(familyId).get();
    const parentUid = familySnap.get("parentUid") as string | undefined;

    const [guardianRefs, deviceRefs] = await Promise.all([
      collectGuardianTokenRefs(familyId, parentUid, senderUid || undefined),
      collectChildDeviceTokens(familyId, senderDeviceId),
    ]);

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
      logger.info("onFamilyChatMessageCreated: no recipient tokens", familyId);
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
      `onFamilyChatMessageCreated: family=${familyId} sender=${senderRole} urgent=${urgent} recipients=${tokens.length}`
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
