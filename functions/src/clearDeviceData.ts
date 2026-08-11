import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const R2_PROXY_BASE =
  process.env.R2_MEDIA_PROXY_BASE_URL?.trim() ||
  "https://sarechild-media-proxy.neuereatec.workers.dev";
const R2_PURGE_SECRET = process.env.R2_MEDIA_PURGE_SECRET?.trim() || "";

const BATCH_SIZE = 200;

function extractMediaKey(doc: FirebaseFirestore.DocumentData, fields: string[]): string | null {
  for (const field of fields) {
    const raw = doc[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (field.endsWith("Path") || !raw.startsWith("http")) {
      const path = raw.trim();
      if (!path.includes("..")) return path.replace(/^\//, "");
    }
    try {
      const u = new URL(raw);
      const match = u.pathname.match(/\/media\/(.+)/);
      if (match?.[1]) return decodeURIComponent(match[1]);
    } catch {
      // not a URL
    }
  }
  return null;
}

async function deleteR2Object(key: string): Promise<boolean> {
  if (!R2_PURGE_SECRET || !key) return false;
  try {
    const res = await fetch(`${R2_PROXY_BASE}/media/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${R2_PURGE_SECRET}` },
    });
    return res.ok;
  } catch (err) {
    logger.warn("R2 delete failed", key, err);
    return false;
  }
}

async function assertFamilyGuardian(familyId: string, uid: string): Promise<void> {
  const familyRef = db.collection("families").doc(familyId);
  const familySnap = await familyRef.get();
  if (!familySnap.exists) {
    throw new HttpsError("not-found", "Family not found.");
  }
  const isOwner = familySnap.get("parentUid") === uid;
  const guardianSnap = await familyRef.collection("guardians").doc(uid).get();
  if (!isOwner && !guardianSnap.exists) {
    throw new HttpsError("permission-denied", "Only a guardian of this family can clear device data.");
  }
}

/**
 * Permanently deletes every screen snapshot Firestore row for one device and
 * best-effort deletes the linked R2 full + thumbnail objects.
 */
export const clearScreenSnapshots = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }

  const familyId = String(request.data?.familyId ?? "").trim();
  const deviceId = String(request.data?.deviceId ?? "").trim();
  if (!familyId || !deviceId) {
    throw new HttpsError("invalid-argument", "familyId and deviceId are required.");
  }

  await assertFamilyGuardian(familyId, uid);

  const deviceRef = db.collection("families").doc(familyId).collection("devices").doc(deviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) {
    throw new HttpsError("not-found", "Device not found.");
  }

  const col = deviceRef.collection("screenSnapshots");
  let docsDeleted = 0;
  let mediaDeleted = 0;
  let mediaDeleteFailed = 0;

  for (;;) {
    const snap = await col.limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const mediaKeys: string[] = [];
    const batch = db.batch();
    for (const doc of snap.docs) {
      const data = doc.data();
      const fullKey = extractMediaKey(data, ["r2Path", "imageUrl"]);
      const thumbKey = extractMediaKey(data, ["thumbPath", "thumbUrl"]);
      if (fullKey) mediaKeys.push(fullKey);
      if (thumbKey && thumbKey !== fullKey) mediaKeys.push(thumbKey);
      batch.delete(doc.ref);
      docsDeleted++;
    }
    await batch.commit();

    for (const key of mediaKeys) {
      const ok = await deleteR2Object(key);
      if (ok) mediaDeleted++;
      else mediaDeleteFailed++;
    }

    if (snap.size < BATCH_SIZE) break;
  }

  logger.info(
    `clearScreenSnapshots: family=${familyId} device=${deviceId} docs=${docsDeleted} media=${mediaDeleted}`,
  );

  return { ok: true, deleted: docsDeleted, mediaDeleted, mediaDeleteFailed };
});

/**
 * Permanently deletes every camera snapshot Firestore row for one device and
 * best-effort deletes the linked R2 full + thumbnail objects.
 */
export const clearCameraSnapshots = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }

  const familyId = String(request.data?.familyId ?? "").trim();
  const deviceId = String(request.data?.deviceId ?? "").trim();
  if (!familyId || !deviceId) {
    throw new HttpsError("invalid-argument", "familyId and deviceId are required.");
  }

  await assertFamilyGuardian(familyId, uid);

  const deviceRef = db.collection("families").doc(familyId).collection("devices").doc(deviceId);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) {
    throw new HttpsError("not-found", "Device not found.");
  }

  const col = deviceRef.collection("cameraSnapshots");
  let docsDeleted = 0;
  let mediaDeleted = 0;
  let mediaDeleteFailed = 0;

  for (;;) {
    const snap = await col.limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const mediaKeys: string[] = [];
    const batch = db.batch();
    for (const doc of snap.docs) {
      const data = doc.data();
      const fullKey = extractMediaKey(data, ["r2Path", "imageUrl"]);
      const thumbKey = extractMediaKey(data, ["thumbPath", "thumbUrl"]);
      if (fullKey) mediaKeys.push(fullKey);
      if (thumbKey && thumbKey !== fullKey) mediaKeys.push(thumbKey);
      batch.delete(doc.ref);
      docsDeleted++;
    }
    await batch.commit();

    for (const key of mediaKeys) {
      const ok = await deleteR2Object(key);
      if (ok) mediaDeleted++;
      else mediaDeleteFailed++;
    }

    if (snap.size < BATCH_SIZE) break;
  }

  logger.info(
    `clearCameraSnapshots: family=${familyId} device=${deviceId} docs=${docsDeleted} media=${mediaDeleted}`,
  );

  return { ok: true, deleted: docsDeleted, mediaDeleted, mediaDeleteFailed };
});
