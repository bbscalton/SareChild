import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { deleteCollectionRecursive, writeAuditLog } from "./admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const R2_PROXY_BASE =
  process.env.R2_MEDIA_PROXY_BASE_URL?.trim() ||
  "https://sarechild-media-proxy.neuereatec.workers.dev";
const R2_PURGE_SECRET = process.env.R2_MEDIA_PURGE_SECRET?.trim() || "";

/** Subcollections nested under families/{familyId}/devices/{deviceId}. */
const DEVICE_SUBCOLLECTIONS = ["installedApps", "photos", "activityEvents", "chatMessages"];

/**
 * Family-level collections (families/{familyId}/{name}/*) whose docs carry a
 * `deviceId` field tying them to one specific device. Collections that are
 * family-wide (geofences, guardians, familyChat, safetySettings, digests, etc.)
 * are intentionally excluded — removing one device must never touch them.
 */
const FAMILY_COLLECTIONS_WITH_DEVICE_ID = [
  "alerts",
  "commands",
  "appEvents",
  "usageDaily",
  "locationTrail",
  "callSmsPreviews",
  "whatsappEvents",
  "callRecordings",
  "typingEvents",
  "appLimits",
  "appBlockSchedules",
  "screenShareSchedules",
  "liveSessions",
  "liveRecordings",
];

async function deleteDeviceSubcollections(
  deviceRef: FirebaseFirestore.DocumentReference
): Promise<void> {
  for (const sub of DEVICE_SUBCOLLECTIONS) {
    await deleteCollectionRecursive(deviceRef.collection(sub));
  }
}

async function deleteCollectionByDeviceId(
  familyRef: FirebaseFirestore.DocumentReference,
  collectionName: string,
  deviceId: string,
  batchSize = 300
): Promise<number> {
  const col = familyRef.collection(collectionName);
  let total = 0;
  for (;;) {
    const snap = await col.where("deviceId", "==", deviceId).limit(batchSize).get();
    if (snap.empty) return total;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < batchSize) return total;
  }
}

async function deleteFamilyDeviceRefs(
  familyRef: FirebaseFirestore.DocumentReference,
  deviceId: string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const col of FAMILY_COLLECTIONS_WITH_DEVICE_ID) {
    counts[col] = await deleteCollectionByDeviceId(familyRef, col, deviceId);
  }
  return counts;
}

/** Firebase Storage fallback path — uploadMedia() on the child writes here if the R2 PUT fails. */
async function deleteDeviceFirebaseStorage(familyId: string, deviceId: string): Promise<void> {
  try {
    const bucket = admin.storage().bucket();
    await bucket.deleteFiles({ prefix: `families/${familyId}/devices/${deviceId}/` });
  } catch (err) {
    logger.warn(`Firebase Storage cleanup failed for device ${deviceId}`, err);
  }
}

/** Primary media store — every device upload (photos, call/live recordings, WhatsApp media,
 * camera/mic checks, screen frames) is written under this exact prefix by the child app. */
async function deleteDeviceR2Media(
  familyId: string,
  deviceId: string
): Promise<{ ok: boolean; deleted?: number }> {
  if (!R2_PURGE_SECRET) {
    logger.warn("R2_MEDIA_PURGE_SECRET not configured — skipping R2 media cleanup");
    return { ok: false };
  }
  const prefix = `families/${familyId}/devices/${deviceId}/`;
  try {
    const res = await fetch(`${R2_PROXY_BASE}/prefix/${encodeURIComponent(prefix)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${R2_PURGE_SECRET}` },
    });
    if (!res.ok) {
      logger.warn(`R2 prefix delete failed (${res.status}) for ${prefix}`);
      return { ok: false };
    }
    const body = (await res.json().catch(() => ({}))) as { deleted?: number };
    return { ok: true, deleted: body.deleted };
  } catch (err) {
    logger.warn("R2 prefix delete request failed", err);
    return { ok: false };
  }
}

/** Removes the edge D1/KV heartbeat + fleet cache rows for this device (best effort). */
async function purgeDeviceEdgeCache(familyId: string, deviceId: string): Promise<void> {
  if (!R2_PURGE_SECRET) return;
  try {
    await fetch(`${R2_PROXY_BASE}/edge/purge/device`, {
      method: "POST",
      headers: { Authorization: `Bearer ${R2_PURGE_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ familyId, deviceId }),
    });
  } catch (err) {
    logger.warn("Edge cache purge failed", err);
  }
}

/** Best-effort push telling the child app to unpair immediately, even while backgrounded. */
async function sendUnpairPush(
  familyId: string,
  deviceId: string,
  tokens: string[]
): Promise<void> {
  if (tokens.length === 0) return;
  try {
    await admin.messaging().sendEachForMulticast({
      tokens,
      data: { type: "UNPAIR", familyId, deviceId },
      android: { priority: "high" },
    });
  } catch (err) {
    logger.warn(`UNPAIR push failed for device ${deviceId}`, err);
  }
}

/**
 * Cascade-deletes a single paired child device and every record tied to it:
 * the device doc + its subcollections, every family-level doc keyed by
 * deviceId, its R2/Storage media, and its D1/KV edge cache rows. Only a
 * guardian (or the owning parent) of the device's family may call this.
 * Leaves the family document, other devices, and family-wide collections
 * (geofences, guardians, family chat, safety settings, etc.) untouched.
 */
export const deletePairedDevice = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const callerEmail = String(request.auth?.token?.email ?? "").trim();

  const familyId = String(request.data?.familyId ?? "").trim();
  const deviceId = String(request.data?.deviceId ?? "").trim();
  if (!familyId || !deviceId) {
    throw new HttpsError("invalid-argument", "familyId and deviceId are required.");
  }

  const familyRef = db.collection("families").doc(familyId);
  const familySnap = await familyRef.get();
  if (!familySnap.exists) {
    throw new HttpsError("not-found", "Family not found.");
  }

  const isOwner = familySnap.get("parentUid") === uid;
  const guardianSnap = await familyRef.collection("guardians").doc(uid).get();
  if (!isOwner && !guardianSnap.exists) {
    throw new HttpsError("permission-denied", "Only a guardian of this family can remove a device.");
  }

  const deviceRef = familyRef.collection("devices").doc(deviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) {
    throw new HttpsError("not-found", "Device not found.");
  }
  const deviceData = deviceSnap.data() ?? {};
  const childName = String(deviceData.childName ?? "Child");
  const tokens = (deviceData.fcmTokens as string[] | undefined) ?? [];

  await sendUnpairPush(familyId, deviceId, tokens);

  await deleteDeviceSubcollections(deviceRef);
  await deviceRef.delete();

  const deletedCounts = await deleteFamilyDeviceRefs(familyRef, deviceId);

  const [r2Result] = await Promise.all([
    deleteDeviceR2Media(familyId, deviceId),
    deleteDeviceFirebaseStorage(familyId, deviceId),
    purgeDeviceEdgeCache(familyId, deviceId),
  ]);

  await writeAuditLog({
    action: "delete_paired_device",
    adminEmail: callerEmail || uid,
    targetUid: uid,
    targetEmail: callerEmail || null,
    detail: `Removed device ${deviceId} (${childName}) from family ${familyId}`,
    meta: { familyId, deviceId, childName, deletedCounts, r2Result },
  });

  logger.info(`deletePairedDevice: family=${familyId} device=${deviceId} counts=`, deletedCounts);

  return { ok: true, deviceId, childName };
});
