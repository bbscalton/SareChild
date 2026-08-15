import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { assertProjectAdmin, writeAuditLog, deleteCollectionRecursive, wipeFamilyData, createFreshFamilyForUser } from "./admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const R2_PROXY_BASE =
  process.env.R2_MEDIA_PROXY_BASE_URL?.trim() ||
  "https://sarechild-media-proxy.neuereatec.workers.dev";
const R2_PURGE_SECRET = process.env.R2_MEDIA_PURGE_SECRET?.trim() || "";
const VPS_HOST = process.env.VPS_HOST?.trim() || "107.170.15.179";
const VPS_HEALTH_URL =
  process.env.VPS_HEALTH_URL?.trim() || `http://${VPS_HOST}:8080/ops-health.json`;
const VPS_STAGING_URL = process.env.VPS_STAGING_URL?.trim() || `http://${VPS_HOST}:8080/`;
const DO_API_TOKEN = process.env.DO_API_TOKEN?.trim() || "";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const ESTIMATE_BYTES_PER_DOC = 2048;

export const STORAGE_FEATURES = [
  { id: "photos", label: "Photo gallery" },
  { id: "screenSnapshots", label: "Screen snapshots" },
  { id: "cameraSnapshots", label: "Camera snapshots" },
  { id: "whatsappWatchdog", label: "WhatsApp Watchdog" },
  { id: "whatsappMedia", label: "WhatsApp media" },
  { id: "callRecordings", label: "Call capture" },
  { id: "liveRecordings", label: "Live viewing recordings" },
  { id: "chat", label: "Family chat" },
  { id: "safetyChecks", label: "Safety check-ins" },
  { id: "whatsappEvents", label: "WhatsApp event log" },
  { id: "typingEvents", label: "Typing safety" },
  { id: "alerts", label: "Alerts" },
  { id: "locationTrail", label: "Location trail" },
  { id: "offlineEvidence", label: "Offline evidence" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "other", label: "Other" },
] as const;

export type StorageFeatureId = (typeof STORAGE_FEATURES)[number]["id"];

export type StorageLimits = {
  globalBytesMax: number;
  defaultAccountBytesMax: number;
  featureBytesMax: Record<string, number>;
  updatedAtMs: number;
  updatedBy: string | null;
};

const DEFAULT_LIMITS: Omit<StorageLimits, "updatedAtMs" | "updatedBy"> = {
  globalBytesMax: 50 * GiB,
  defaultAccountBytesMax: 2 * GiB,
  featureBytesMax: {
    photos: 512 * MiB,
    screenSnapshots: 800 * MiB,
    cameraSnapshots: 300 * MiB,
    whatsappWatchdog: 400 * MiB,
    whatsappMedia: 300 * MiB,
    callRecordings: 400 * MiB,
    liveRecordings: 500 * MiB,
    chat: 200 * MiB,
    safetyChecks: 150 * MiB,
    whatsappEvents: 80 * MiB,
    typingEvents: 40 * MiB,
    alerts: 40 * MiB,
    locationTrail: 80 * MiB,
    offlineEvidence: 150 * MiB,
    diagnostics: 40 * MiB,
    other: 200 * MiB,
  },
};

const FAMILY_COUNT_COLS = [
  "alerts",
  "familyChat",
  "commands",
  "appEvents",
  "usageDaily",
  "locationTrail",
  "callSmsPreviews",
  "callRecordings",
  "whatsappEvents",
  "typingEvents",
  "liveSessions",
  "liveRecordings",
  "digests",
];

const DEVICE_COUNT_COLS = [
  "photos",
  "screenSnapshots",
  "cameraSnapshots",
  "chatMessages",
  "activityEvents",
  "whatsappWatchdogSnapshots",
];

const COL_TO_FEATURE: Record<string, StorageFeatureId> = {
  photos: "photos",
  screenSnapshots: "screenSnapshots",
  cameraSnapshots: "cameraSnapshots",
  chatMessages: "chat",
  familyChat: "chat",
  whatsappWatchdogSnapshots: "whatsappWatchdog",
  callRecordings: "callRecordings",
  liveRecordings: "liveRecordings",
  whatsappEvents: "whatsappEvents",
  typingEvents: "typingEvents",
  alerts: "alerts",
  locationTrail: "locationTrail",
};

const FEATURE_R2_FOLDERS: Record<string, string[]> = {
  photos: ["photos"],
  screenSnapshots: ["screenSnapshots"],
  cameraSnapshots: ["cameraSnapshots"],
  whatsappWatchdog: ["whatsappWatchdog"],
  whatsappMedia: ["whatsappMedia"],
  callRecordings: ["callRecordings"],
  liveRecordings: ["liveRecordings"],
  chat: ["chat"],
  safetyChecks: ["camera", "mic", "screen"],
  offlineEvidence: ["offlineEvidence"],
  diagnostics: ["diagnostics"],
};

async function countCol(ref: FirebaseFirestore.CollectionReference): Promise<number> {
  const snap = await ref.count().get();
  return snap.data().count;
}

function emptyFeatureMap(): Record<string, { docs: number; estimatedBytes: number; r2Bytes: number; r2Objects: number }> {
  const out: Record<string, { docs: number; estimatedBytes: number; r2Bytes: number; r2Objects: number }> = {};
  for (const f of STORAGE_FEATURES) {
    out[f.id] = { docs: 0, estimatedBytes: 0, r2Bytes: 0, r2Objects: 0 };
  }
  return out;
}

async function loadLimits(): Promise<StorageLimits> {
  const snap = await db.collection("adminConfig").doc("storageLimits").get();
  const data = snap.data() ?? {};
  const featureBytesMax = {
    ...DEFAULT_LIMITS.featureBytesMax,
    ...((data.featureBytesMax as Record<string, number> | undefined) ?? {}),
  };
  return {
    globalBytesMax: Number(data.globalBytesMax ?? DEFAULT_LIMITS.globalBytesMax),
    defaultAccountBytesMax: Number(data.defaultAccountBytesMax ?? DEFAULT_LIMITS.defaultAccountBytesMax),
    featureBytesMax,
    updatedAtMs: Number(data.updatedAtMs ?? 0),
    updatedBy: (data.updatedBy as string | undefined) ?? null,
  };
}

async function r2Fetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  if (!R2_PURGE_SECRET) return null;
  try {
    return await fetch(`${R2_PROXY_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${R2_PURGE_SECRET}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    logger.warn("R2 ops request failed", err);
    return null;
  }
}

async function deleteR2Prefix(prefix: string): Promise<number> {
  const res = await r2Fetch(`/prefix/${encodeURIComponent(prefix)}`, { method: "DELETE" });
  if (!res) return 0;
  if (!res.ok) {
    logger.warn(`R2 prefix delete failed (${res.status}) for ${prefix}`);
    return 0;
  }
  const body = (await res.json().catch(() => ({}))) as { deleted?: number };
  return Number(body.deleted ?? 0);
}

type R2Dump = {
  objects: number;
  bytes: number;
  truncated: boolean;
  families: Record<
    string,
    { bytes: number; objects: number; features: Record<string, { bytes: number; objects: number }> }
  >;
  features: Record<string, { bytes: number; objects: number }>;
  otherBytes: number;
  otherObjects: number;
};

async function fetchR2Dump(): Promise<{ r2: R2Dump | null; d1: Record<string, number>; error?: string }> {
  const res = await r2Fetch("/ops/storage-dump");
  if (!res) return { r2: null, d1: {}, error: "R2_MEDIA_PURGE_SECRET not set" };
  if (!res.ok) return { r2: null, d1: {}, error: `R2 dump HTTP ${res.status}` };
  const body = (await res.json()) as { r2?: R2Dump; d1?: Record<string, number> };
  return { r2: body.r2 ?? null, d1: body.d1 ?? {} };
}

async function fetchFirebaseStorageUsage(): Promise<{ bytes: number; objects: number; truncated: boolean }> {
  try {
    const bucket = admin.storage().bucket();
    const [files, , api] = await bucket.getFiles({
      prefix: "families/",
      autoPaginate: false,
      maxResults: 4000,
    });
    let bytes = 0;
    for (const f of files) bytes += Number(f.metadata?.size ?? 0);
    return {
      bytes,
      objects: files.length,
      truncated: Boolean((api as { nextPageToken?: string } | undefined)?.nextPageToken),
    };
  } catch (err) {
    logger.warn("Firebase Storage listing failed", err);
    return { bytes: 0, objects: 0, truncated: false };
  }
}

async function probeUrl(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number | null; latencyMs: number; body?: unknown }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - started;
    let body: unknown;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) body = await res.json().catch(() => undefined);
    return { ok: res.ok, status: res.status, latencyMs, body };
  } catch (err) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function tcpReachable(host: string, port: number, timeoutMs = 4000): Promise<{ ok: boolean; latencyMs: number }> {
  const net = await import("node:net");
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

async function fetchDoDroplet(): Promise<Record<string, unknown>> {
  if (!DO_API_TOKEN) {
    return { configured: false, ip: VPS_HOST, message: "Set DO_API_TOKEN on Cloud Functions to load droplet metrics." };
  }
  try {
    const res = await fetch("https://api.digitalocean.com/v2/droplets?per_page=200", {
      headers: { Authorization: `Bearer ${DO_API_TOKEN}` },
    });
    if (!res.ok) {
      return { configured: true, ip: VPS_HOST, error: `DigitalOcean API HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      droplets?: Array<{
        id: number;
        name: string;
        status: string;
        memory: number;
        vcpus: number;
        disk: number;
        region?: { slug?: string; name?: string };
        size_slug?: string;
        networks?: { v4?: Array<{ ip_address: string; type: string }>; };
      }>;
    };
    const droplet = (data.droplets ?? []).find((d) =>
      (d.networks?.v4 ?? []).some((n) => n.ip_address === VPS_HOST),
    );
    if (!droplet) {
      return { configured: true, ip: VPS_HOST, error: `No droplet found with IP ${VPS_HOST}` };
    }
    return {
      configured: true,
      ip: VPS_HOST,
      id: droplet.id,
      name: droplet.name,
      status: droplet.status,
      memoryMb: droplet.memory,
      vcpus: droplet.vcpus,
      diskGb: droplet.disk,
      region: droplet.region?.slug ?? droplet.region?.name,
      size: droplet.size_slug,
    };
  } catch (err) {
    return { configured: true, ip: VPS_HOST, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function buildStorageDump(): Promise<Record<string, unknown>> {
  const [limits, r2Bundle, firebaseStorage, profilesSnap, familiesSnap] = await Promise.all([
    loadLimits(),
    fetchR2Dump(),
    fetchFirebaseStorageUsage(),
    db.collection("parentProfiles").get(),
    db.collection("families").get(),
  ]);

  const emailByFamily = new Map<string, { uid: string; email: string }>();
  for (const p of profilesSnap.docs) {
    const familyId = (p.get("familyId") as string | undefined) || (p.get("ownedFamilyId") as string | undefined);
    if (!familyId) continue;
    emailByFamily.set(familyId, { uid: p.id, email: (p.get("email") as string | undefined) || "" });
  }

  const r2Families = r2Bundle.r2?.families ?? {};
  const accounts: Array<Record<string, unknown>> = [];
  let firestoreDocs = 0;

  for (const family of familiesSnap.docs) {
    const features = emptyFeatureMap();
    let docs = 0;
    for (const col of FAMILY_COUNT_COLS) {
      const n = await countCol(family.ref.collection(col));
      docs += n;
      const feat = COL_TO_FEATURE[col] ?? "other";
      features[feat].docs += n;
      features[feat].estimatedBytes += n * ESTIMATE_BYTES_PER_DOC;
    }
    const devicesSnap = await family.ref.collection("devices").get();
    for (const device of devicesSnap.docs) {
      for (const col of DEVICE_COUNT_COLS) {
        const n = await countCol(device.ref.collection(col));
        docs += n;
        const feat = COL_TO_FEATURE[col] ?? "other";
        features[feat].docs += n;
        features[feat].estimatedBytes += n * ESTIMATE_BYTES_PER_DOC;
      }
    }
    firestoreDocs += docs;
    const r2Fam = r2Families[family.id];
    if (r2Fam) {
      for (const [feat, usage] of Object.entries(r2Fam.features ?? {})) {
        const slot = features[feat] ?? (features[feat] = { docs: 0, estimatedBytes: 0, r2Bytes: 0, r2Objects: 0 });
        slot.r2Bytes += usage.bytes;
        slot.r2Objects += usage.objects;
      }
    }
    const r2Bytes = Number(r2Fam?.bytes ?? 0);
    const estimatedBytes = Object.values(features).reduce((s, f) => s + f.estimatedBytes, 0);
    const usedBytes = r2Bytes + estimatedBytes;
    const override = Number(family.get("storageBytesMax") ?? 0);
    const accountMax = override > 0 ? override : limits.defaultAccountBytesMax;
    const owner = emailByFamily.get(family.id);
    accounts.push({
      familyId: family.id,
      parentUid: owner?.uid || family.get("parentUid") || null,
      email: owner?.email || family.get("parentEmail") || "",
      childNames: devicesSnap.docs.map((d) => d.get("childName") || d.id),
      deviceCount: devicesSnap.size,
      firestoreDocs: docs,
      r2Bytes,
      r2Objects: Number(r2Fam?.objects ?? 0),
      estimatedFirestoreBytes: estimatedBytes,
      usedBytes,
      accountBytesMax: accountMax,
      overLimit: usedBytes > accountMax,
      storageBlocked: Boolean(family.get("storageBlocked")),
      features,
    });
  }

  accounts.sort((a, b) => Number(b.usedBytes) - Number(a.usedBytes));

  const featureTotals = emptyFeatureMap();
  for (const acct of accounts) {
    const feats = acct.features as typeof featureTotals;
    for (const id of Object.keys(feats)) {
      featureTotals[id].docs += feats[id].docs;
      featureTotals[id].estimatedBytes += feats[id].estimatedBytes;
      featureTotals[id].r2Bytes += feats[id].r2Bytes;
      featureTotals[id].r2Objects += feats[id].r2Objects;
    }
  }

  const r2Bytes = Number(r2Bundle.r2?.bytes ?? 0);
  const dump = {
    takenAtMs: Date.now(),
    limits,
    backends: {
      r2: {
        reachable: Boolean(r2Bundle.r2),
        error: r2Bundle.error,
        bytes: r2Bytes,
        objects: Number(r2Bundle.r2?.objects ?? 0),
        truncated: Boolean(r2Bundle.r2?.truncated),
        otherBytes: Number(r2Bundle.r2?.otherBytes ?? 0),
        bucket: "luscsl-uploads",
      },
      firestore: { docs: firestoreDocs, estimatedBytes: firestoreDocs * ESTIMATE_BYTES_PER_DOC, families: familiesSnap.size },
      firebaseStorage: firebaseStorage,
      d1: r2Bundle.d1,
      kv: { note: "Edge cache flags only — not billed per object." },
    },
    features: STORAGE_FEATURES.map((f) => ({
      ...f,
      ...featureTotals[f.id],
      limitBytes: limits.featureBytesMax[f.id] ?? 0,
    })),
    accounts,
    totals: {
      usedBytes: r2Bytes + firebaseStorage.bytes + firestoreDocs * ESTIMATE_BYTES_PER_DOC,
      r2Bytes,
      firebaseStorageBytes: firebaseStorage.bytes,
      accountCount: accounts.length,
      overLimitCount: accounts.filter((a) => a.overLimit).length,
    },
  };

  await db.collection("adminConfig").doc("storageDump").set(dump, { merge: true });
  return dump;
}

export const adminGetStorageDump = onCall(
  { cors: true, timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    assertProjectAdmin(request);
    return buildStorageDump();
  },
);

export const adminSetStorageLimits = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const data = (request.data ?? {}) as Partial<StorageLimits> & {
    familyId?: string;
    accountBytesMax?: number | null;
  };
  if (data.familyId) {
    const familyId = String(data.familyId).trim();
    const max = data.accountBytesMax == null ? null : Math.max(64 * MiB, Number(data.accountBytesMax));
    await db
      .collection("families")
      .doc(familyId)
      .set({ storageBytesMax: max, storageLimitsUpdatedAtMs: Date.now() }, { merge: true });
    await writeAuditLog({
      action: "set_storage_limits",
      adminEmail,
      targetUid: familyId,
      detail: `Account cap ${max ?? "default"} for family ${familyId}`,
    });
    return { ok: true, familyId, accountBytesMax: max };
  }

  const current = await loadLimits();
  const next: StorageLimits = {
    globalBytesMax: Number(data.globalBytesMax ?? current.globalBytesMax),
    defaultAccountBytesMax: Number(data.defaultAccountBytesMax ?? current.defaultAccountBytesMax),
    featureBytesMax: { ...current.featureBytesMax, ...(data.featureBytesMax ?? {}) },
    updatedAtMs: Date.now(),
    updatedBy: adminEmail,
  };
  await db.collection("adminConfig").doc("storageLimits").set(next, { merge: true });
  await writeAuditLog({
    action: "set_storage_limits",
    adminEmail,
    targetUid: "platform",
    detail: `Global cap ${next.globalBytesMax}, default account ${next.defaultAccountBytesMax}`,
  });
  return { ok: true, limits: next };
});

async function clearFeatureForFamily(familyId: string, feature: string): Promise<{ docs: number; media: number }> {
  const familyRef = db.collection("families").doc(familyId);
  let docs = 0;
  let media = 0;
  const devices = await familyRef.collection("devices").get();
  const folders = FEATURE_R2_FOLDERS[feature] ?? [feature];
  for (const device of devices.docs) {
    const nested = Object.entries(COL_TO_FEATURE)
      .filter(([, feat]) => feat === feature)
      .map(([col]) => col)
      .filter((col) => DEVICE_COUNT_COLS.includes(col));
    for (const col of nested) {
      const before = await countCol(device.ref.collection(col));
      await deleteCollectionRecursive(device.ref.collection(col));
      docs += before;
    }
    for (const folder of folders) {
      media += await deleteR2Prefix(`families/${familyId}/devices/${device.id}/${folder}/`);
    }
  }
  const familyCols = Object.entries(COL_TO_FEATURE)
    .filter(([, feat]) => feat === feature)
    .map(([col]) => col)
    .filter((col) => FAMILY_COUNT_COLS.includes(col));
  for (const col of familyCols) {
    const before = await countCol(familyRef.collection(col));
    await deleteCollectionRecursive(familyRef.collection(col));
    docs += before;
  }
  return { docs, media };
}

export const adminClearStorage = onCall(
  { cors: true, timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const adminEmail = assertProjectAdmin(request);
    const scope = String(request.data?.scope ?? "").trim();
    const familyId = String(request.data?.familyId ?? "").trim();
    const feature = String(request.data?.feature ?? "").trim();
    const confirm = String(request.data?.confirm ?? "").trim();

    if (scope === "feature") {
      if (!familyId || !feature) throw new HttpsError("invalid-argument", "familyId and feature are required.");
      const result = await clearFeatureForFamily(familyId, feature);
      await writeAuditLog({
        action: "clear_storage",
        adminEmail,
        targetUid: familyId,
        detail: `Cleared feature ${feature}: ${result.docs} docs, ${result.media} objects`,
      });
      return { ok: true, ...result };
    }

    if (scope === "account") {
      if (!familyId) throw new HttpsError("invalid-argument", "familyId is required.");
      if (confirm !== "CLEAR-ACCOUNT") throw new HttpsError("failed-precondition", "Type CLEAR-ACCOUNT to confirm.");
      let docs = 0;
      let media = 0;
      const familyRef = db.collection("families").doc(familyId);
      for (const col of FAMILY_COUNT_COLS) {
        const n = await countCol(familyRef.collection(col));
        await deleteCollectionRecursive(familyRef.collection(col));
        docs += n;
      }
      const devices = await familyRef.collection("devices").get();
      for (const device of devices.docs) {
        for (const col of DEVICE_COUNT_COLS) {
          const n = await countCol(device.ref.collection(col));
          await deleteCollectionRecursive(device.ref.collection(col));
          docs += n;
        }
        media += await deleteR2Prefix(`families/${familyId}/devices/${device.id}/`);
      }
      try {
        await admin.storage().bucket().deleteFiles({ prefix: `families/${familyId}/` });
      } catch (err) {
        logger.warn("Firebase Storage family delete failed", err);
      }
      await familyRef.set({ storageBlocked: false, storageClearedAtMs: Date.now() }, { merge: true });
      await writeAuditLog({
        action: "clear_storage",
        adminEmail,
        targetUid: familyId,
        detail: `Cleared account data: ${docs} docs, ${media} R2 objects. Pairing kept.`,
      });
      return { ok: true, docs, media };
    }

    if (scope === "platform") {
      if (confirm !== "RESET-PLATFORM") {
        throw new HttpsError("failed-precondition", "Type RESET-PLATFORM to confirm wiping all operational data.");
      }
      const families = await db.collection("families").get();
      let docs = 0;
      let media = 0;
      for (const family of families.docs) {
        const familyRef = family.ref;
        for (const col of FAMILY_COUNT_COLS) {
          const n = await countCol(familyRef.collection(col));
          await deleteCollectionRecursive(familyRef.collection(col));
          docs += n;
        }
        const devices = await familyRef.collection("devices").get();
        for (const device of devices.docs) {
          for (const col of DEVICE_COUNT_COLS) {
            const n = await countCol(device.ref.collection(col));
            await deleteCollectionRecursive(device.ref.collection(col));
            docs += n;
          }
          media += await deleteR2Prefix(`families/${family.id}/devices/${device.id}/`);
        }
        media += await deleteR2Prefix(`families/${family.id}/`);
      }
      await writeAuditLog({
        action: "factory_reset_storage",
        adminEmail,
        targetUid: "platform",
        detail: `Platform operational wipe: ${docs} docs, ${media} objects across ${families.size} families`,
      });
      return { ok: true, docs, media, families: families.size };
    }

    throw new HttpsError("invalid-argument", "scope must be feature, account, or platform.");
  },
);

export const adminFactoryResetAccount = onCall({ cors: true, timeoutSeconds: 180 }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const familyId = String(request.data?.familyId ?? "").trim();
  const confirm = String(request.data?.confirm ?? "").trim();
  if (!familyId) throw new HttpsError("invalid-argument", "familyId is required.");
  if (confirm !== "FACTORY-RESET") {
    throw new HttpsError("failed-precondition", "Type FACTORY-RESET to confirm.");
  }
  await deleteR2Prefix(`families/${familyId}/`);
  await wipeFamilyData(familyId);
  const profiles = await db.collection("parentProfiles").where("familyId", "==", familyId).get();
  for (const p of profiles.docs) {
    const email = (p.get("email") as string | undefined) || "";
    const newId = await createFreshFamilyForUser(p.id, email);
    await p.ref.set({ familyId: newId, ownedFamilyId: newId }, { merge: true });
  }
  await writeAuditLog({
    action: "factory_reset_storage",
    adminEmail,
    targetUid: familyId,
    detail: `Factory-reset family ${familyId} (devices + media + event data gone; account login kept if profile remains)`,
  });
  return { ok: true, familyId };
});

export const adminGetInfraStatus = onCall({ cors: true, timeoutSeconds: 30 }, async (request) => {
  assertProjectAdmin(request);
  const [health, staging, turn, doMeta] = await Promise.all([
    probeUrl(VPS_HEALTH_URL),
    probeUrl(VPS_STAGING_URL),
    tcpReachable(VPS_HOST, 3478),
    fetchDoDroplet(),
  ]);
  return {
    takenAtMs: Date.now(),
    droplet: {
      provider: "digitalocean",
      host: VPS_HOST,
      roles: [
        { id: "coturn", label: "WebRTC TURN/STUN", detail: `turn:${VPS_HOST}:3478 — live viewing NAT relay` },
        { id: "staging", label: "Parent-web staging", detail: `${VPS_STAGING_URL}` },
        { id: "apk-mirror", label: "APK download mirror", detail: "nginx /downloads → Cloudflare R2 proxy" },
        { id: "ffmpeg", label: "ffmpeg media worker", detail: "/opt/sarechild/media-worker" },
        { id: "backups", label: "Firestore backup templates", detail: "/opt/sarechild/backup" },
        { id: "health-cron", label: "Outbound health cron", detail: "every 5 min → parent-web + R2 /platform-health" },
        { id: "runner", label: "Optional GitHub Actions runner", detail: "self-hosted label sarechild-vps" },
        { id: "uptime-kuma", label: "Optional Uptime Kuma", detail: "127.0.0.1:3001 via SSH tunnel" },
      ],
      probes: {
        opsHealth: health,
        staging,
        turn3478: turn,
      },
      digitalocean: doMeta,
      agentInstalled: Boolean(health.ok && health.body && typeof health.body === "object"),
      installHint:
        "If ops health JSON is missing, run scripts/vps/install-ops-health.sh on the droplet (see docs/VPS_OPS.md).",
      docs: "docs/VPS_OPS.md",
      consoleUrl: "https://cloud.digitalocean.com/droplets",
    },
    cloudflare: {
      r2Bucket: "luscsl-uploads",
      worker: R2_PROXY_BASE,
      d1: "sarechild-ops",
    },
    firebase: {
      projectId: process.env.GCLOUD_PROJECT || "safechild-f34ac",
      storageBucket: admin.storage().bucket().name,
    },
  };
});

export const enforceStorageLimits = onSchedule(
  { schedule: "every 6 hours", timeoutSeconds: 300, memory: "1GiB" },
  async () => {
    const dump = (await buildStorageDump()) as {
      limits: StorageLimits;
      accounts: Array<{ familyId: string; usedBytes: number; accountBytesMax: number; overLimit: boolean }>;
    };
    const quotas = dump.accounts.map((a) => ({
      familyId: a.familyId,
      usedBytes: a.usedBytes,
      maxBytes: a.accountBytesMax,
      blocked: a.overLimit,
    }));
    await r2Fetch("/ops/quotas", { method: "POST", body: JSON.stringify({ families: quotas }) });
    let blocked = 0;
    for (const acct of dump.accounts) {
      if (!acct.overLimit) continue;
      await db
        .collection("families")
        .doc(acct.familyId)
        .set({ storageBlocked: true, storageBlockedAtMs: Date.now() }, { merge: true });
      blocked += 1;
    }
    logger.info(`enforceStorageLimits scanned=${dump.accounts.length} blocked=${blocked}`);
  },
);
