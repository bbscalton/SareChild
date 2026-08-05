import * as admin from "firebase-admin";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

export const ADMIN_EMAIL = "neuereatec@gmail.com";
const TRIAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_CREDITS = 10;

/** Subcollections under families/{familyId} that must be deleted with the family. */
export const FAMILY_SUBCOLLECTIONS = [
  "devices",
  "alerts",
  "familyChat",
  "geofences",
  "mapPlaces",
  "commands",
  "appEvents",
  "usageDaily",
  "locationTrail",
  "callSmsPreviews",
  "callRecordings",
  "whatsappEvents",
  "typingEvents",
  "typingSafetySettings",
  "digests",
  "sosContacts",
  "safeContacts",
  "safetySettings",
  "appLimits",
  "appBlockSchedules",
  "screenShareSchedules",
  "liveSessions",
  "liveRecordings",
  "guardians",
];

export type AdminAuditAction =
  | "wipe_user"
  | "delete_user"
  | "revoke_sessions"
  | "adjust_trial"
  | "grant_credits"
  | "block_account"
  | "unblock_account"
  | "trigger_purge_trials"
  | "trigger_purge_retention"
  | "set_retention"
  | "set_chat_video_limit"
  | "repair_orphans"
  | "send_test_fcm"
  | "delete_paired_device"
  | "set_reseller_status"
  | "topup_reseller_credits"
  | "save_reseller_pricing"
  | "trigger_expire_paid";

export async function deleteCollectionRecursive(
  ref: FirebaseFirestore.CollectionReference,
  batchSize = 200
): Promise<void> {
  for (;;) {
    const snap = await ref.limit(batchSize).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < batchSize) return;
  }
}

async function deleteDeviceNestedSubcollections(
  familyRef: FirebaseFirestore.DocumentReference
): Promise<void> {
  const devices = await familyRef.collection("devices").get();
  for (const device of devices.docs) {
    await deleteCollectionRecursive(device.ref.collection("installedApps"));
    await deleteCollectionRecursive(device.ref.collection("photos"));
    await deleteCollectionRecursive(device.ref.collection("activityEvents"));
    // Per-device family chat thread (families/{id}/devices/{deviceId}/chatMessages).
    await deleteCollectionRecursive(device.ref.collection("chatMessages"));
  }
}

async function deleteDocsByField(
  collectionName: string,
  field: string,
  value: string
): Promise<number> {
  const snap = await db.collection(collectionName).where(field, "==", value).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

async function deleteFamilyStorage(familyId: string): Promise<void> {
  try {
    const bucket = admin.storage().bucket();
    await bucket.deleteFiles({ prefix: `families/${familyId}/` });
  } catch (err) {
    logger.warn(`Storage cleanup failed for family ${familyId}`, err);
  }
}

/** Deletes a family document and all known subcollections (including nested device apps). */
export async function wipeFamilyData(familyId: string): Promise<void> {
  const familyRef = db.collection("families").doc(familyId);
  await deleteDeviceNestedSubcollections(familyRef);
  for (const sub of FAMILY_SUBCOLLECTIONS) {
    await deleteCollectionRecursive(familyRef.collection(sub));
  }
  await familyRef.delete();
  await deleteDocsByField("pairingCodes", "familyId", familyId);
  await deleteDocsByField("guardianInvites", "familyId", familyId);
  await deleteFamilyStorage(familyId);
}

function nextUtcMidnightMs(fromMs: number): number {
  const d = new Date(fromMs);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

async function createFreshFamilyForUser(uid: string, email: string): Promise<string> {
  const now = Date.now();
  const familyRef = db.collection("families").doc();
  await familyRef.set({
    parentUid: uid,
    createdAtMs: now,
    parentEmail: email,
    retentionDays: 2,
  });
  await familyRef.collection("guardians").doc(uid).set({
    email,
    role: "OWNER",
    joinedAtMs: now,
  });
  await familyRef.collection("safetySettings").doc("default").set({
    escalationEnabled: true,
    escalationRiskThreshold: 60,
    autoLockOnCritical: false,
    checkInIntervalMinutes: 120,
    snoozedCategories: [],
    snoozeUntilMs: 0,
    alertRetentionDays: 30,
    mediaRetentionDays: 7,
  });
  return familyRef.id;
}

async function resetLiveViewQuota(uid: string): Promise<void> {
  const now = Date.now();
  await db.collection("liveViewQuota").doc(uid).set({
    creditsRemaining: DEFAULT_DAILY_CREDITS,
    dailyAllowance: DEFAULT_DAILY_CREDITS,
    resetAtMs: nextUtcMidnightMs(now),
    bonusCredits: 0,
    resetByAdminAtMs: now,
  });
}

export function assertProjectAdmin(request: CallableRequest): string {
  if (!request.auth?.token?.email) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const email = String(request.auth.token.email).trim().toLowerCase();
  if (email !== ADMIN_EMAIL.toLowerCase()) {
    throw new HttpsError("permission-denied", "Project admin access only.");
  }
  return email;
}

export async function writeAuditLog(entry: {
  action: AdminAuditAction;
  adminEmail: string;
  targetUid: string;
  targetEmail?: string | null;
  detail?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await db.collection("adminAuditLogs").add({
    ...entry,
    atMs: Date.now(),
  });
}

async function loadTargetProfile(uid: string): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
  email: string;
}> {
  const ref = db.collection("parentProfiles").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `No parentProfiles doc for uid ${uid}.`);
  }
  const data = snap.data() ?? {};
  const email = String(data.email ?? "").trim();
  return { ref, data, email };
}

function assertSelfActionAllowed(
  adminEmail: string,
  targetEmail: string,
  selfConfirm?: boolean
): void {
  if (adminEmail.toLowerCase() !== targetEmail.toLowerCase()) return;
  if (!selfConfirm) {
    throw new HttpsError(
      "failed-precondition",
      "Actions on your own admin account require selfConfirm: true."
    );
  }
}

async function detachFromNonOwnedFamilies(uid: string, ownedFamilyId: string | null): Promise<void> {
  const profiles = await db.collection("parentProfiles").where("familyId", "!=", ownedFamilyId ?? "__none__").get();
  // Guardians may appear in families/{id}/guardians/{uid} — scan families where they are a guardian but not owner.
  const families = await db.collection("families").get();
  for (const family of families.docs) {
    if (family.id === ownedFamilyId) continue;
    const guardianRef = family.ref.collection("guardians").doc(uid);
    const guardianSnap = await guardianRef.get();
    if (guardianSnap.exists) {
      await guardianRef.delete();
    }
  }
  void profiles; // profile.familyId for caregivers is handled per-user below
}

/**
 * Wipes a user's owned family data and resets their profile to a fresh empty family.
 * Keeps Firebase Auth, email, uid, and TOS acceptance fields.
 */
export async function adminWipeUserCore(
  uid: string,
  adminEmail: string
): Promise<{ newFamilyId: string; wipedFamilyId: string | null }> {
  const { ref: profileRef, data } = await loadTargetProfile(uid);
  const email = String(data.email ?? "").trim();
  const ownedFamilyId =
    (data.ownedFamilyId as string | undefined) ||
    (data.familyId as string | undefined) ||
    null;

  let wipedFamilyId: string | null = null;

  if (ownedFamilyId) {
    const familySnap = await db.collection("families").doc(ownedFamilyId).get();
    if (familySnap.exists && familySnap.get("parentUid") === uid) {
      await wipeFamilyData(ownedFamilyId);
      wipedFamilyId = ownedFamilyId;
    } else if (familySnap.exists) {
      await db
        .collection("families")
        .doc(ownedFamilyId)
        .collection("guardians")
        .doc(uid)
        .delete()
        .catch(() => undefined);
    }
  }

  await detachFromNonOwnedFamilies(uid, wipedFamilyId);

  await db.collection("adminFeatureOverrides").doc(uid).delete().catch(() => undefined);
  await resetLiveViewQuota(uid);

  const now = Date.now();
  const newFamilyId = await createFreshFamilyForUser(uid, email);

  await profileRef.set(
    {
      familyId: newFamilyId,
      ownedFamilyId: newFamilyId,
      email,
      createdAtMs: data.createdAtMs ?? now,
      registeredAt: data.registeredAt ?? data.createdAtMs ?? now,
      tosAcceptedAt: data.tosAcceptedAt ?? null,
      tosVersion: data.tosVersion ?? null,
      privacyAcceptedAt: data.privacyAcceptedAt ?? null,
      plan: "trial",
      status: "active",
      trialStartedAt: now,
      trialEndsAt: now + TRIAL_DAYS * DAY_MS,
      lastLoginAt: null,
      lastParentCheckInAt: null,
      lastActiveAt: now,
      adminBlocked: false,
      blockedAtMs: null,
      blockedReason: null,
      blockedBy: null,
      purgeWarnedAt: null,
      purgedAtMs: null,
      fcmTokens: [],
      wipedAtMs: now,
      wipedByAdmin: adminEmail,
    },
    { merge: false }
  );

  await admin.auth().revokeRefreshTokens(uid);

  return { newFamilyId, wipedFamilyId };
}

/** Wipes all user/family data and deletes the Firebase Auth account. */
export async function adminDeleteUserCore(
  uid: string,
  adminEmail: string
): Promise<{ wipedFamilyId: string | null }> {
  const { ref: profileRef, data } = await loadTargetProfile(uid);
  const ownedFamilyId =
    (data.ownedFamilyId as string | undefined) ||
    (data.familyId as string | undefined) ||
    null;

  let wipedFamilyId: string | null = null;

  if (ownedFamilyId) {
    const familySnap = await db.collection("families").doc(ownedFamilyId).get();
    if (familySnap.exists && familySnap.get("parentUid") === uid) {
      await wipeFamilyData(ownedFamilyId);
      wipedFamilyId = ownedFamilyId;
    } else if (familySnap.exists) {
      await db
        .collection("families")
        .doc(ownedFamilyId)
        .collection("guardians")
        .doc(uid)
        .delete()
        .catch(() => undefined);
    }
  }

  await detachFromNonOwnedFamilies(uid, wipedFamilyId);
  await db.collection("liveViewQuota").doc(uid).delete().catch(() => undefined);
  await db.collection("adminFeatureOverrides").doc(uid).delete().catch(() => undefined);
  await profileRef.delete();

  await admin.auth().deleteUser(uid).catch((err) => {
    logger.warn(`Auth delete failed for ${uid}`, err);
    throw new HttpsError("internal", `Firestore wiped but Auth delete failed: ${String(err)}`);
  });

  return { wipedFamilyId };
}

export const adminWipeUser = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const uid = String(request.data?.uid ?? "").trim();
  const selfConfirm = Boolean(request.data?.selfConfirm);
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

  const { email } = await loadTargetProfile(uid);
  assertSelfActionAllowed(adminEmail, email, selfConfirm);

  const result = await adminWipeUserCore(uid, adminEmail);
  await writeAuditLog({
    action: "wipe_user",
    adminEmail,
    targetUid: uid,
    targetEmail: email,
    detail: `Wiped family ${result.wipedFamilyId ?? "none"}; new family ${result.newFamilyId}`,
    meta: result,
  });

  return { ok: true, ...result };
});

export const adminDeleteUser = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const uid = String(request.data?.uid ?? "").trim();
  const selfConfirm = Boolean(request.data?.selfConfirm);
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

  const { email } = await loadTargetProfile(uid);
  assertSelfActionAllowed(adminEmail, email, selfConfirm);

  const result = await adminDeleteUserCore(uid, adminEmail);
  await writeAuditLog({
    action: "delete_user",
    adminEmail,
    targetUid: uid,
    targetEmail: email,
    detail: `Deleted Auth + profile; wiped family ${result.wipedFamilyId ?? "none"}`,
    meta: result,
  });

  return { ok: true, ...result };
});

export const adminRevokeSessions = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const uid = String(request.data?.uid ?? "").trim();
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

  const { email } = await loadTargetProfile(uid);
  await admin.auth().revokeRefreshTokens(uid);
  await db.collection("parentProfiles").doc(uid).set({ fcmTokens: [] }, { merge: true });

  await writeAuditLog({
    action: "revoke_sessions",
    adminEmail,
    targetUid: uid,
    targetEmail: email,
    detail: "Revoked refresh tokens and cleared FCM tokens",
  });

  return { ok: true };
});

export const adminAdjustTrial = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const uid = String(request.data?.uid ?? "").trim();
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

  const plan = request.data?.plan as string | undefined;
  const status = request.data?.status as string | undefined;
  const extendDays = Number(request.data?.extendDays ?? 0);
  const setTrialEndsAt = request.data?.setTrialEndsAt as number | undefined;

  const { ref, data, email } = await loadTargetProfile(uid);
  const patch: Record<string, unknown> = { lastActiveAt: Date.now() };

  if (plan === "trial" || plan === "paid") patch.plan = plan;
  if (status === "active" || status === "at_risk" || status === "blocked") {
    patch.status = status;
    if (status !== "blocked") {
      patch.adminBlocked = false;
      patch.blockedAtMs = null;
      patch.blockedReason = null;
      patch.blockedBy = null;
    }
  }

  const now = Date.now();
  if (setTrialEndsAt != null && Number.isFinite(setTrialEndsAt)) {
    patch.trialEndsAt = setTrialEndsAt;
  } else if (extendDays > 0) {
    const base = Number(data.trialEndsAt ?? now);
    patch.trialEndsAt = Math.max(base, now) + extendDays * DAY_MS;
  }

  if (patch.plan === "trial" && !data.trialStartedAt) {
    patch.trialStartedAt = now;
  }

  await ref.set(patch, { merge: true });

  await writeAuditLog({
    action: "adjust_trial",
    adminEmail,
    targetUid: uid,
    targetEmail: email,
    detail: JSON.stringify(patch),
    meta: patch,
  });

  return { ok: true, patch };
});

export const adminTriggerPurgeTrials = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const { runPurgeInactiveTrials } = await import("./purgeTrials");
  const result = await runPurgeInactiveTrials();
  await writeAuditLog({
    action: "trigger_purge_trials",
    adminEmail,
    targetUid: "system",
    detail: `Manual purge: warned=${result.warned} purged=${result.purged}`,
    meta: result,
  });
  return { ok: true, ...result };
});

export const adminRepairOrphans = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const fixes: string[] = [];
  const profiles = await db.collection("parentProfiles").get();

  for (const profileDoc of profiles.docs) {
    const data = profileDoc.data();
    const uid = profileDoc.id;
    const familyId = data.familyId as string | undefined;
    const email = String(data.email ?? "");

    if (familyId) {
      const familySnap = await db.collection("families").doc(familyId).get();
      if (!familySnap.exists) {
        const newFamilyId = await createFreshFamilyForUser(uid, email);
        await profileDoc.ref.set({ familyId: newFamilyId, ownedFamilyId: newFamilyId }, { merge: true });
        fixes.push(`Recreated missing family for ${email || uid}.`);
        continue;
      }
      const parentUid = familySnap.get("parentUid") as string | undefined;
      if (parentUid) {
        const guardianRef = db.collection("families").doc(familyId).collection("guardians").doc(parentUid);
        const guardianSnap = await guardianRef.get();
        if (!guardianSnap.exists) {
          await guardianRef.set({
            email: familySnap.get("parentEmail") || email,
            role: "OWNER",
            joinedAtMs: Date.now(),
          });
          fixes.push(`Restored OWNER guardian for family ${familyId}.`);
        }
      }
      if (!data.ownedFamilyId && parentUid === uid) {
        await profileDoc.ref.set({ ownedFamilyId: familyId }, { merge: true });
        fixes.push(`Set ownedFamilyId for ${email || uid}.`);
      }
    }
  }

  if (fixes.length === 0) fixes.push("No orphan repairs needed.");

  await writeAuditLog({
    action: "repair_orphans",
    adminEmail,
    targetUid: "system",
    detail: fixes.join(" "),
    meta: { fixes },
  });

  return { ok: true, fixes };
});

export const adminSetRetention = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const uid = String(request.data?.uid ?? "").trim();
  const familyIdArg = String(request.data?.familyId ?? "").trim();
  const retentionDays = Number(request.data?.retentionDays);

  if (!Number.isFinite(retentionDays)) {
    throw new HttpsError("invalid-argument", "retentionDays (2–90) is required.");
  }
  if (retentionDays < 2 || retentionDays > 90) {
    throw new HttpsError("invalid-argument", "retentionDays must be between 2 and 90.");
  }

  let familyId = familyIdArg;
  let targetEmail: string | null = null;

  if (uid) {
    const { data, email } = await loadTargetProfile(uid);
    targetEmail = email;
    familyId =
      familyId ||
      (data.ownedFamilyId as string | undefined) ||
      (data.familyId as string | undefined) ||
      "";
  }

  if (!familyId) {
    throw new HttpsError("invalid-argument", "uid or familyId is required.");
  }

  const familySnap = await db.collection("families").doc(familyId).get();
  if (!familySnap.exists) {
    throw new HttpsError("not-found", `Family ${familyId} not found.`);
  }

  const { adminSetFamilyRetentionDays } = await import("./purgeRetention");
  const days = await adminSetFamilyRetentionDays(familyId, retentionDays);

  await writeAuditLog({
    action: "set_retention",
    adminEmail,
    targetUid: uid || familySnap.get("parentUid") || familyId,
    targetEmail: targetEmail ?? (familySnap.get("parentEmail") as string | undefined) ?? null,
    detail: `Set retentionDays=${days} on family ${familyId}`,
    meta: { familyId, retentionDays: days },
  });

  return { ok: true, familyId, retentionDays: days };
});

/**
 * TCD-only override for how long a family's child device may record a chat video note
 * (default 180s / 3 min, selectable 1/2/3 min in the child app). Mirrors adminSetRetention
 * but writes families/{id}.maxChatVideoSeconds instead of retentionDays.
 */
export const adminSetChatVideoLimit = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const uid = String(request.data?.uid ?? "").trim();
  const familyIdArg = String(request.data?.familyId ?? "").trim();
  const maxChatVideoSeconds = Number(request.data?.maxChatVideoSeconds);

  if (!Number.isFinite(maxChatVideoSeconds)) {
    throw new HttpsError("invalid-argument", "maxChatVideoSeconds (30–600) is required.");
  }
  const seconds = Math.round(Math.min(600, Math.max(30, maxChatVideoSeconds)));

  let familyId = familyIdArg;
  let targetEmail: string | null = null;

  if (uid) {
    const { data, email } = await loadTargetProfile(uid);
    targetEmail = email;
    familyId =
      familyId ||
      (data.ownedFamilyId as string | undefined) ||
      (data.familyId as string | undefined) ||
      "";
  }

  if (!familyId) {
    throw new HttpsError("invalid-argument", "uid or familyId is required.");
  }

  const familySnap = await db.collection("families").doc(familyId).get();
  if (!familySnap.exists) {
    throw new HttpsError("not-found", `Family ${familyId} not found.`);
  }

  await db.collection("families").doc(familyId).set(
    { maxChatVideoSeconds: seconds, maxChatVideoSecondsUpdatedAtMs: Date.now() },
    { merge: true }
  );

  await writeAuditLog({
    action: "set_chat_video_limit",
    adminEmail,
    targetUid: uid || familySnap.get("parentUid") || familyId,
    targetEmail: targetEmail ?? (familySnap.get("parentEmail") as string | undefined) ?? null,
    detail: `Set maxChatVideoSeconds=${seconds} on family ${familyId}`,
    meta: { familyId, maxChatVideoSeconds: seconds },
  });

  return { ok: true, familyId, maxChatVideoSeconds: seconds };
});

export const adminTriggerPurgeRetention = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const { runPurgeExpiredRetentionData } = await import("./purgeRetention");
  const result = await runPurgeExpiredRetentionData();
  await writeAuditLog({
    action: "trigger_purge_retention",
    adminEmail,
    targetUid: "system",
    detail: `Manual retention purge: families=${result.familiesScanned} docs=${result.docsDeleted}`,
    meta: result,
  });
  return { ok: true, ...result };
});

export const adminSendTestFcm = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const familyId = String(request.data?.familyId ?? "").trim();
  const deviceId = String(request.data?.deviceId ?? "").trim();
  if (!familyId || !deviceId) {
    throw new HttpsError("invalid-argument", "familyId and deviceId are required.");
  }

  const deviceRef = db.collection("families").doc(familyId).collection("devices").doc(deviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) {
    throw new HttpsError("not-found", "Device not found.");
  }

  const tokens = (deviceSnap.get("fcmTokens") as string[] | undefined) ?? [];
  if (tokens.length === 0) {
    throw new HttpsError("failed-precondition", "Device has no FCM tokens.");
  }

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: "SareChild admin test",
      body: "Test push from TCD admin console.",
    },
    data: { type: "ADMIN_TEST", familyId, deviceId },
    android: { priority: "high" },
  });

  const successCount = response.responses.filter((r) => r.success).length;

  await writeAuditLog({
    action: "send_test_fcm",
    adminEmail,
    targetUid: deviceId,
    detail: `Sent test FCM to device ${deviceId} in ${familyId} (${successCount}/${tokens.length} ok)`,
    meta: { familyId, deviceId, successCount, tokenCount: tokens.length },
  });

  return { ok: true, successCount, tokenCount: tokens.length };
});
