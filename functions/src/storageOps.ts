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

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function positiveOrDefault(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

async function loadLimits(): Promise<StorageLimits> {
  const snap = await db.collection("adminConfig").doc("storageLimits").get();
  const data = snap.data() ?? {};
  const featureBytesMax = {
    ...DEFAULT_LIMITS.featureBytesMax,
    ...((data.featureBytesMax as Record<string, number> | undefined) ?? {}),
  };
  return {
    globalBytesMax: positiveOrDefault(data.globalBytesMax, DEFAULT_LIMITS.globalBytesMax),
    defaultAccountBytesMax: positiveOrDefault(data.defaultAccountBytesMax, DEFAULT_LIMITS.defaultAccountBytesMax),
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
      signal: init.signal ?? AbortSignal.timeout(12_000),
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

async function fetchR2Dump(): Promise<{ r2: R2Dump | null; d1: Record<string, number>; error: string | null }> {
  const res = await r2Fetch("/ops/storage-dump");
  if (!res) {
    return {
      r2: null,
      d1: {},
      error: R2_PURGE_SECRET ? "R2 dump request failed (timeout or network)" : "R2_MEDIA_PURGE_SECRET not set",
    };
  }
  if (!res.ok) return { r2: null, d1: {}, error: `R2 dump HTTP ${res.status}` };
  const body = (await res.json()) as { r2?: R2Dump; d1?: Record<string, number> };
  return {
    r2: body.r2 ?? null,
    d1: body.d1 ?? {},
    error: body.r2 ? null : "R2 dump missing r2 payload",
  };
}

async function fetchFirebaseStorageUsage(): Promise<{
  bytes: number;
  objects: number;
  truncated: boolean;
  error: string | null;
}> {
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
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Firebase Storage listing failed", err);
    return { bytes: 0, objects: 0, truncated: false, error: message };
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

async function countColSafe(ref: FirebaseFirestore.CollectionReference): Promise<number> {
  try {
    return await countCol(ref);
  } catch (err) {
    logger.warn(`count() failed for ${ref.path}`, err);
    return 0;
  }
}

function accountSkeleton(opts: {
  familyId: string;
  parentUid: string | null;
  email: string;
  childNames: string[];
  deviceCount: number;
  features: ReturnType<typeof emptyFeatureMap>;
  firestoreDocs: number;
  r2Bytes: number;
  r2Objects: number;
  estimatedBytes: number;
  accountBytesMax: number;
  storageBlocked: boolean;
}): Record<string, unknown> {
  const usedBytes = opts.r2Bytes + opts.estimatedBytes;
  return {
    familyId: opts.familyId,
    parentUid: opts.parentUid,
    email: opts.email,
    childNames: opts.childNames,
    deviceCount: opts.deviceCount,
    firestoreDocs: opts.firestoreDocs,
    r2Bytes: opts.r2Bytes,
    r2Objects: opts.r2Objects,
    estimatedFirestoreBytes: opts.estimatedBytes,
    usedBytes,
    accountBytesMax: opts.accountBytesMax,
    overLimit: usedBytes > opts.accountBytesMax,
    storageBlocked: opts.storageBlocked,
    features: opts.features,
  };
}

const MAX_FAMILIES_IN_DUMP = 80;
const COUNT_BUDGET_MS = 22_000;

function emptyDumpShell(limits: StorageLimits, error: string | null, warnings: string[]): Record<string, unknown> {
  return {
    takenAtMs: Date.now(),
    error,
    warnings,
    countsTruncated: false,
    stale: false,
    limits,
    backends: {
      r2: {
        reachable: false,
        error: null,
        bytes: 0,
        objects: 0,
        truncated: false,
        otherBytes: 0,
        bucket: "luscsl-uploads",
      },
      firestore: { docs: 0, estimatedBytes: 0, families: 0 },
      firebaseStorage: { bytes: 0, objects: 0, truncated: false, error: null },
      d1: {},
      kv: { note: "Edge cache flags only — not billed per object." },
    },
    features: STORAGE_FEATURES.map((f) => ({
      ...f,
      docs: 0,
      estimatedBytes: 0,
      r2Bytes: 0,
      r2Objects: 0,
      limitBytes: limits.featureBytesMax[f.id] ?? 0,
    })),
    accounts: [],
    totals: {
      usedBytes: 0,
      r2Bytes: 0,
      firebaseStorageBytes: 0,
      accountCount: 0,
      overLimitCount: 0,
    },
  };
}

export async function buildStorageDump(): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  const [limits, r2Bundle, firebaseStorage, profilesSnap, familiesSnap] = await Promise.all([
    loadLimits(),
    fetchR2Dump().catch((err) => ({
      r2: null as R2Dump | null,
      d1: {} as Record<string, number>,
      error: err instanceof Error ? err.message : String(err),
    })),
    fetchFirebaseStorageUsage(),
    db.collection("parentProfiles").get(),
    db.collection("families").get(),
  ]);

  if (r2Bundle.error) warnings.push(`R2: ${r2Bundle.error}`);
  if (firebaseStorage.error) warnings.push(`Firebase Storage: ${firebaseStorage.error}`);

  const emailByFamily = new Map<string, { uid: string; email: string }>();
  for (const p of profilesSnap.docs) {
    const familyId = (p.get("familyId") as string | undefined) || (p.get("ownedFamilyId") as string | undefined);
    if (!familyId) continue;
    emailByFamily.set(familyId, { uid: p.id, email: (p.get("email") as string | undefined) || "" });
  }

  const familyDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const family of familiesSnap.docs) familyDocs.set(family.id, family);

  const familyIds = [...new Set([...familyDocs.keys(), ...emailByFamily.keys()])];
  if (familyIds.length > MAX_FAMILIES_IN_DUMP) {
    warnings.push(`Truncated to ${MAX_FAMILIES_IN_DUMP} of ${familyIds.length} families for this dump`);
  }
  const ids = familyIds.slice(0, MAX_FAMILIES_IN_DUMP);

  const r2Families = r2Bundle.r2?.families ?? {};
  const accounts: Array<Record<string, unknown>> = [];
  let firestoreDocs = 0;
  let countsTruncated = false;
  const countsStarted = Date.now();

  for (const familyId of ids) {
    if (Date.now() - countsStarted > COUNT_BUDGET_MS) {
      countsTruncated = true;
      break;
    }
    const family = familyDocs.get(familyId);
    const familyRef = family?.ref ?? db.collection("families").doc(familyId);
    const features = emptyFeatureMap();
    let docs = 0;
    const familyCounts = await Promise.all(FAMILY_COUNT_COLS.map(async (col) => ({ col, n: await countColSafe(familyRef.collection(col)) })));
    for (const { col, n } of familyCounts) {
      docs += n;
      const feat = COL_TO_FEATURE[col] ?? "other";
      features[feat].docs += n;
      features[feat].estimatedBytes += n * ESTIMATE_BYTES_PER_DOC;
    }
    let devicesSnap: FirebaseFirestore.QuerySnapshot | { docs: FirebaseFirestore.QueryDocumentSnapshot[]; size: number } = {
      docs: [],
      size: 0,
    };
    try {
      devicesSnap = await familyRef.collection("devices").get();
    } catch (err) {
      logger.warn(`devices listing failed for ${familyId}`, err);
    }
    const deviceCounts = await Promise.all(
      devicesSnap.docs.map(async (device) => {
        const cols = await Promise.all(DEVICE_COUNT_COLS.map(async (col) => ({ col, n: await countColSafe(device.ref.collection(col)) })));
        return { device, cols };
      }),
    );
    for (const { cols } of deviceCounts) {
      for (const { col, n } of cols) {
        docs += n;
        const feat = COL_TO_FEATURE[col] ?? "other";
        features[feat].docs += n;
        features[feat].estimatedBytes += n * ESTIMATE_BYTES_PER_DOC;
      }
    }
    firestoreDocs += docs;
    const r2Fam = r2Families[familyId];
    if (r2Fam) {
      for (const [feat, usage] of Object.entries(r2Fam.features ?? {})) {
        const slot = features[feat] ?? (features[feat] = { docs: 0, estimatedBytes: 0, r2Bytes: 0, r2Objects: 0 });
        slot.r2Bytes += usage.bytes;
        slot.r2Objects += usage.objects;
      }
    }
    const owner = emailByFamily.get(familyId);
    const override = Number(family?.get("storageBytesMax") ?? 0);
    accounts.push(
      accountSkeleton({
        familyId,
        parentUid: owner?.uid || (family?.get("parentUid") as string | undefined) || null,
        email: owner?.email || (family?.get("parentEmail") as string | undefined) || "",
        childNames: devicesSnap.docs.map((d) => (d.get("childName") as string | undefined) || d.id),
        deviceCount: devicesSnap.size,
        features,
        firestoreDocs: docs,
        r2Bytes: Number(r2Fam?.bytes ?? 0),
        r2Objects: Number(r2Fam?.objects ?? 0),
        estimatedBytes: Object.values(features).reduce((s, f) => s + f.estimatedBytes, 0),
        accountBytesMax: override > 0 ? override : limits.defaultAccountBytesMax,
        storageBlocked: Boolean(family?.get("storageBlocked")),
      }),
    );
  }

  if (countsTruncated) {
    warnings.push("Doc counts timed out; remaining families are listed with R2 bytes only so Clear/Reset still works.");
    const seen = new Set(accounts.map((a) => String(a.familyId)));
    for (const familyId of ids) {
      if (seen.has(familyId)) continue;
      const family = familyDocs.get(familyId);
      const owner = emailByFamily.get(familyId);
      const r2Fam = r2Families[familyId];
      const features = emptyFeatureMap();
      if (r2Fam) {
        for (const [feat, usage] of Object.entries(r2Fam.features ?? {})) {
          const slot = features[feat] ?? (features[feat] = { docs: 0, estimatedBytes: 0, r2Bytes: 0, r2Objects: 0 });
          slot.r2Bytes += usage.bytes;
          slot.r2Objects += usage.objects;
        }
      }
      const override = Number(family?.get("storageBytesMax") ?? 0);
      accounts.push(
        accountSkeleton({
          familyId,
          parentUid: owner?.uid || (family?.get("parentUid") as string | undefined) || null,
          email: owner?.email || (family?.get("parentEmail") as string | undefined) || "",
          childNames: [],
          deviceCount: 0,
          features,
          firestoreDocs: 0,
          r2Bytes: Number(r2Fam?.bytes ?? 0),
          r2Objects: Number(r2Fam?.objects ?? 0),
          estimatedBytes: 0,
          accountBytesMax: override > 0 ? override : limits.defaultAccountBytesMax,
          storageBlocked: Boolean(family?.get("storageBlocked")),
        }),
      );
    }
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
    error: null as string | null,
    warnings,
    countsTruncated,
    stale: false,
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
      firestore: {
        docs: firestoreDocs,
        estimatedBytes: firestoreDocs * ESTIMATE_BYTES_PER_DOC,
        families: familyIds.length,
      },
      firebaseStorage: {
        bytes: firebaseStorage.bytes,
        objects: firebaseStorage.objects,
        truncated: firebaseStorage.truncated,
        error: firebaseStorage.error,
      },
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

  const safe = jsonSafe(dump);
  try {
    await db.collection("adminConfig").doc("storageDump").set(safe);
  } catch (err) {
    logger.warn("storageDump persist skipped", err);
    const persistNote = "Could not cache dump in Firestore (response still includes live accounts).";
    const nextWarnings = [...warnings, persistNote];
    (safe as { warnings: string[] }).warnings = nextWarnings;
  }
  return jsonSafe(safe);
}

export const adminGetStorageDump = onCall(
  { cors: true, timeoutSeconds: 120, memory: "1GiB" },
  async (request) => {
    assertProjectAdmin(request);
    try {
      return await buildStorageDump();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("buildStorageDump failed", err);
      const cached = await db.collection("adminConfig").doc("storageDump").get();
      if (cached.exists) {
        return jsonSafe({
          ...cached.data(),
          stale: true,
          error: message,
        });
      }
      const limits: StorageLimits = {
        ...DEFAULT_LIMITS,
        updatedAtMs: 0,
        updatedBy: null,
      };
      return jsonSafe(emptyDumpShell(limits, message, ["Live dump failed before accounts were collected."]));
    }
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

function probeFailureNote(
  kind: "http-private" | "tcp-turn",
  probe: { ok: boolean; status: number | null; body?: unknown },
): string | null {
  if (probe.ok) return null;
  const err =
    typeof probe.body === "object" && probe.body && "error" in probe.body
      ? String((probe.body as { error: unknown }).error)
      : "";
  if (kind === "tcp-turn") {
    return "Cloud Functions TCP to :3478 is not a TURN health check (coturn is UDP/TCP). A failed connect from GCF often means GCP egress or droplet firewall — not that live viewing is down.";
  }
  const mixed =
    "GitHub Pages is HTTPS, so the TCD browser cannot fetch http://107.170.15.179:8080 (mixed content).";
  if (probe.status == null) {
    return `Cloud Functions could not reach this private HTTP port${err ? ` (${err})` : ""}. ${mixed}`;
  }
  return mixed;
}

export const adminGetInfraStatus = onCall({ cors: true, timeoutSeconds: 15 }, async (request) => {
  assertProjectAdmin(request);
  const [health, staging, turn, doMeta] = await Promise.all([
    probeUrl(VPS_HEALTH_URL, 4000),
    probeUrl(VPS_STAGING_URL, 4000),
    tcpReachable(VPS_HOST, 3478, 2500),
    fetchDoDroplet(),
  ]);
  return {
    takenAtMs: Date.now(),
    droplet: {
      provider: "digitalocean",
      host: VPS_HOST,
      roles: [
        { id: "coturn", label: "WebRTC TURN/STUN", detail: `turn:${VPS_HOST}:3478 — live viewing NAT relay (UDP/TCP; GCF TCP is not the only health signal)` },
        { id: "staging", label: "Parent-web staging", detail: `${VPS_STAGING_URL} — HTTP only; HTTPS TCD cannot probe this URL (mixed content)` },
        { id: "apk-mirror", label: "APK download mirror", detail: "nginx /downloads → Cloudflare R2 proxy" },
        { id: "ffmpeg", label: "ffmpeg media worker", detail: "/opt/sarechild/media-worker" },
        { id: "backups", label: "Firestore backup templates", detail: "/opt/sarechild/backup" },
        { id: "health-cron", label: "Outbound health cron", detail: "every 5 min → parent-web + R2 /platform-health" },
        { id: "runner", label: "Optional GitHub Actions runner", detail: "self-hosted label sarechild-vps" },
        { id: "uptime-kuma", label: "Optional Uptime Kuma", detail: "127.0.0.1:3001 via SSH tunnel" },
      ],
      probes: {
        opsHealth: {
          ...health,
          inconclusive: !health.ok && health.status == null,
          note: probeFailureNote("http-private", health),
        },
        staging: {
          ...staging,
          inconclusive: !staging.ok && staging.status == null,
          note: probeFailureNote("http-private", staging),
        },
        turn3478: {
          ...turn,
          inconclusive: !turn.ok,
          note: probeFailureNote("tcp-turn", { ok: turn.ok, status: null, body: turn.ok ? undefined : { error: "tcp connect failed" } }),
        },
      },
      mixedContentNote:
        "TCD on GitHub Pages is served over HTTPS. The droplet staging site and ops-health.json are HTTP on :8080, so the browser blocks those fetches (mixed content). Cloud Functions can use HTTP; if those probes also fail, GCP egress or the droplet firewall is blocking 107.170.15.179:8080/:3478. Confirm staging in a separate HTTP tab or over SSH.",
      digitalocean: doMeta,
      agentInstalled: Boolean(health.ok && health.body && typeof health.body === "object"),
      installHint:
        "If ops health JSON is missing, run scripts/vps/install-ops-health.sh on the droplet (see docs/VPS_OPS.md). A TCD browser fetch of http://107.170.15.179:8080/ops-health.json will always fail from HTTPS Pages.",
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
