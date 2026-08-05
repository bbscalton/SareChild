import * as admin from "firebase-admin";
import { logger } from "firebase-functions";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

export const DEFAULT_RETENTION_DAYS = 2;
export const MIN_RETENTION_DAYS = 2;
export const MAX_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 200;
/** Keep the newest N CRITICAL alerts even if older than the retention window. */
const KEEP_CRITICAL_ALERTS = 5;

const R2_PROXY_BASE =
  process.env.R2_MEDIA_PROXY_BASE_URL?.trim() ||
  "https://sarechild-media-proxy.neuereatec.workers.dev";
const R2_PURGE_SECRET = process.env.R2_MEDIA_PURGE_SECRET?.trim() || "";

type CollectionPurgeSpec = {
  name: string;
  timestampField: string;
  mediaFields?: string[];
  /** Only delete docs whose `status` field equals one of these values. */
  statusIn?: string[];
};

/** Operational/event collections purged by family retentionDays. Config & registry docs are kept. */
const RETENTION_COLLECTIONS: CollectionPurgeSpec[] = [
  { name: "whatsappEvents", timestampField: "createdAtMs" },
  { name: "typingEvents", timestampField: "createdAtMs" },
  { name: "callRecordings", timestampField: "createdAtMs", mediaFields: ["mediaPath", "mediaUrl"] },
  { name: "liveRecordings", timestampField: "createdAtMs", mediaFields: ["mediaPath", "mediaUrl"] },
  { name: "liveSessions", timestampField: "createdAtMs" },
  { name: "locationTrail", timestampField: "recordedAtMs" },
  { name: "familyChat", timestampField: "createdAtMs", mediaFields: ["mediaUrl"] },
  { name: "callSmsPreviews", timestampField: "atMs" },
  { name: "appEvents", timestampField: "atMs" },
  { name: "usageDaily", timestampField: "updatedAtMs" },
  { name: "digests", timestampField: "createdAtMs" },
  {
    name: "commands",
    timestampField: "requestedAtMs",
    statusIn: ["COMPLETED", "FAILED", "DECLINED"],
  },
];

export type RetentionPurgeStats = {
  familiesScanned: number;
  docsDeleted: number;
  mediaKeysQueued: number;
  mediaDeleted: number;
  mediaDeleteFailed: number;
};

function clampRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(days)));
}

let cachedDefaultRetentionDays: { value: number; loadedAtMs: number } | null = null;

async function loadGlobalDefaultRetentionDays(): Promise<number> {
  const now = Date.now();
  if (cachedDefaultRetentionDays && now - cachedDefaultRetentionDays.loadedAtMs < 60_000) {
    return cachedDefaultRetentionDays.value;
  }
  const snap = await db.collection("adminConfig").doc("features").get();
  const raw = snap.get("defaultRetentionDays") as number | undefined;
  const value = clampRetentionDays(raw ?? DEFAULT_RETENTION_DAYS);
  cachedDefaultRetentionDays = { value, loadedAtMs: now };
  return value;
}

/** Family-owned retention on families/{id}.retentionDays, else adminConfig default (2). */
export async function resolveFamilyRetentionDays(
  familyId: string,
  familyData?: FirebaseFirestore.DocumentData
): Promise<number> {
  const data = familyData ?? (await db.collection("families").doc(familyId).get()).data() ?? {};
  const familyDays = data.retentionDays as number | undefined;
  if (familyDays != null && Number.isFinite(familyDays)) {
    return clampRetentionDays(familyDays);
  }
  return loadGlobalDefaultRetentionDays();
}

function extractMediaKey(doc: FirebaseFirestore.DocumentData, mediaFields: string[]): string | null {
  for (const field of mediaFields) {
    const raw = doc[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (field === "mediaPath" || !raw.startsWith("http")) {
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
    const res = await fetch(
      `${R2_PROXY_BASE}/media/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${R2_PURGE_SECRET}` },
      }
    );
    return res.ok;
  } catch (err) {
    logger.warn("R2 delete failed", key, err);
    return false;
  }
}

async function purgeCollectionByTimestamp(
  familyRef: FirebaseFirestore.DocumentReference,
  spec: CollectionPurgeSpec,
  cutoffMs: number,
  stats: RetentionPurgeStats
): Promise<void> {
  const col = familyRef.collection(spec.name);
  for (;;) {
    const snap = await col.where(spec.timestampField, "<", cutoffMs).limit(BATCH_SIZE).get();
    if (snap.empty) return;

    const mediaKeys: string[] = [];
    const batch = db.batch();
    let deleted = 0;

    for (const doc of snap.docs) {
      const data = doc.data();
      if (spec.statusIn?.length) {
        const status = String(data.status ?? "");
        if (!spec.statusIn.includes(status)) continue;
      }
      if (spec.mediaFields?.length) {
        const key = extractMediaKey(data, spec.mediaFields);
        if (key) mediaKeys.push(key);
      }
      batch.delete(doc.ref);
      deleted++;
    }

    if (deleted === 0) {
      if (snap.size < BATCH_SIZE) return;
      continue;
    }

    await batch.commit();
    stats.docsDeleted += deleted;
    stats.mediaKeysQueued += mediaKeys.length;

    for (const key of mediaKeys) {
      const ok = await deleteR2Object(key);
      if (ok) stats.mediaDeleted++;
      else stats.mediaDeleteFailed++;
    }

    if (snap.size < BATCH_SIZE) return;
  }
}

async function purgeAlerts(
  familyRef: FirebaseFirestore.DocumentReference,
  cutoffMs: number,
  stats: RetentionPurgeStats
): Promise<void> {
  const keepIds = new Set<string>();
  const criticalSnap = await familyRef
    .collection("alerts")
    .where("severity", "==", "CRITICAL")
    .orderBy("createdAtMs", "desc")
    .limit(KEEP_CRITICAL_ALERTS)
    .get();
  criticalSnap.docs.forEach((d) => keepIds.add(d.id));

  for (;;) {
    const snap = await familyRef
      .collection("alerts")
      .where("createdAtMs", "<", cutoffMs)
      .limit(BATCH_SIZE)
      .get();
    if (snap.empty) return;

    const batch = db.batch();
    let deleted = 0;
    for (const doc of snap.docs) {
      if (keepIds.has(doc.id)) continue;
      const data = doc.data();
      const key = extractMediaKey(data, ["mediaUrl"]);
      if (key) {
        stats.mediaKeysQueued++;
        const ok = await deleteR2Object(key);
        if (ok) stats.mediaDeleted++;
        else stats.mediaDeleteFailed++;
      }
      batch.delete(doc.ref);
      deleted++;
    }

    if (deleted === 0) {
      if (snap.size < BATCH_SIZE) return;
      continue;
    }

    await batch.commit();
    stats.docsDeleted += deleted;
    if (snap.size < BATCH_SIZE) return;
  }
}

async function purgeDevicePhotos(
  familyRef: FirebaseFirestore.DocumentReference,
  cutoffMs: number,
  stats: RetentionPurgeStats
): Promise<void> {
  const devicesSnap = await familyRef.collection("devices").get();
  for (const device of devicesSnap.docs) {
    const col = device.ref.collection("photos");
    for (;;) {
      const snap = await col.where("takenAtMs", "<", cutoffMs).limit(BATCH_SIZE).get();
      if (snap.empty) break;

      const mediaKeys: string[] = [];
      const batch = db.batch();
      let deleted = 0;

      for (const doc of snap.docs) {
        const data = doc.data();
        const key = extractMediaKey(data, ["thumbPath", "fullPath", "thumbUrl", "fullUrl"]);
        if (key) mediaKeys.push(key);
        batch.delete(doc.ref);
        deleted++;
      }

      if (deleted === 0) break;
      await batch.commit();
      stats.docsDeleted += deleted;
      stats.mediaKeysQueued += mediaKeys.length;

      for (const key of mediaKeys) {
        const ok = await deleteR2Object(key);
        if (ok) stats.mediaDeleted++;
        else stats.mediaDeleteFailed++;
      }

      if (snap.size < BATCH_SIZE) break;
    }
  }
}

/** Per-device chat threads (families/{id}/devices/{deviceId}/chatMessages) — each device's
 *  conversation is purged independently, same retentionDays as the rest of the family. */
async function purgeDeviceChatMessages(
  familyRef: FirebaseFirestore.DocumentReference,
  cutoffMs: number,
  stats: RetentionPurgeStats
): Promise<void> {
  const devicesSnap = await familyRef.collection("devices").get();
  for (const device of devicesSnap.docs) {
    const col = device.ref.collection("chatMessages");
    for (;;) {
      const snap = await col.where("createdAtMs", "<", cutoffMs).limit(BATCH_SIZE).get();
      if (snap.empty) break;

      const mediaKeys: string[] = [];
      const batch = db.batch();
      let deleted = 0;

      for (const doc of snap.docs) {
        const data = doc.data();
        const key = extractMediaKey(data, ["mediaPath", "mediaUrl"]);
        if (key) mediaKeys.push(key);
        batch.delete(doc.ref);
        deleted++;
      }

      if (deleted === 0) break;
      await batch.commit();
      stats.docsDeleted += deleted;
      stats.mediaKeysQueued += mediaKeys.length;

      for (const key of mediaKeys) {
        const ok = await deleteR2Object(key);
        if (ok) stats.mediaDeleted++;
        else stats.mediaDeleteFailed++;
      }

      if (snap.size < BATCH_SIZE) break;
    }
  }
}

async function purgeDeviceActivityEvents(
  familyRef: FirebaseFirestore.DocumentReference,
  cutoffMs: number,
  stats: RetentionPurgeStats
): Promise<void> {
  const devicesSnap = await familyRef.collection("devices").get();
  for (const device of devicesSnap.docs) {
    const col = device.ref.collection("activityEvents");
    for (;;) {
      const snap = await col.where("createdAtMs", "<", cutoffMs).limit(BATCH_SIZE).get();
      if (snap.empty) break;

      const batch = db.batch();
      let deleted = 0;
      for (const doc of snap.docs) {
        batch.delete(doc.ref);
        deleted++;
      }
      if (deleted === 0) break;
      await batch.commit();
      stats.docsDeleted += deleted;
      if (snap.size < BATCH_SIZE) break;
    }
  }
}

async function purgeFamilyRetentionData(
  familyId: string,
  retentionDays: number,
  stats: RetentionPurgeStats
): Promise<void> {
  const cutoffMs = Date.now() - retentionDays * DAY_MS;
  const familyRef = db.collection("families").doc(familyId);

  for (const spec of RETENTION_COLLECTIONS) {
    await purgeCollectionByTimestamp(familyRef, spec, cutoffMs, stats);
  }
  await purgeDevicePhotos(familyRef, cutoffMs, stats);
  await purgeDeviceActivityEvents(familyRef, cutoffMs, stats);
  await purgeDeviceChatMessages(familyRef, cutoffMs, stats);
  await purgeAlerts(familyRef, cutoffMs, stats);
}

/**
 * Daily purge of operational data older than each family's retentionDays (default 2).
 * Keeps account shell, devices (incl. lastLocation), geofences, guardians, safety config.
 */
export async function runPurgeExpiredRetentionData(): Promise<RetentionPurgeStats> {
  const stats: RetentionPurgeStats = {
    familiesScanned: 0,
    docsDeleted: 0,
    mediaKeysQueued: 0,
    mediaDeleted: 0,
    mediaDeleteFailed: 0,
  };

  const defaultDays = await loadGlobalDefaultRetentionDays();
  const families = await db.collection("families").get();

  for (const family of families.docs) {
    stats.familiesScanned++;
    const retentionDays = clampRetentionDays(
      (family.get("retentionDays") as number | undefined) ?? defaultDays
    );
    try {
      await purgeFamilyRetentionData(family.id, retentionDays, stats);
    } catch (err) {
      logger.warn(`Retention purge failed for family ${family.id}`, err);
    }
  }

  logger.info("purgeExpiredRetentionData complete", stats);
  return stats;
}

export async function adminSetFamilyRetentionDays(
  familyId: string,
  retentionDays: number
): Promise<number> {
  const days = clampRetentionDays(retentionDays);
  await db.collection("families").doc(familyId).set(
    {
      retentionDays: days,
      retentionUpdatedAtMs: Date.now(),
    },
    { merge: true }
  );
  return days;
}
