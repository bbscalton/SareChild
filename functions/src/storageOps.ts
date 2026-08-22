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
const XAMPP_STORAGE_URL = process.env.XAMPP_STORAGE_URL?.trim() || "";
const XAMPP_STORAGE_SECRET = process.env.XAMPP_STORAGE_SECRET?.trim() || "";
const XAMPP_LOCAL_HEALTH = "http://127.0.0.1/sarechild-storage/health.json";
const XAMPP_INSTALL_PATH = "C:\\xampp2\\htdocs\\sarechild-storage";

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
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (v === undefined) return null;
      if (typeof v === "number" && !Number.isFinite(v)) return 0;
      return v;
    }),
  ) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function r2Fetch(path: string, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response | null> {
  if (!R2_PURGE_SECRET) return null;
  try {
    return await fetch(`${R2_PROXY_BASE}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
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
  // Full bucket listing can take 20–50s; keep this well under the callable's 120s budget.
  const res = await r2Fetch("/ops/storage-dump", {}, 55_000);
  if (!res) {
    return {
      r2: null,
      d1: {},
      error: R2_PURGE_SECRET ? "R2 dump timed out or network failed — per-family R2 bytes are unavailable" : "R2_MEDIA_PURGE_SECRET not set",
    };
  }
  if (!res.ok) return { r2: null, d1: {}, error: `R2 dump HTTP ${res.status}` };
  const body = (await res.json()) as { r2?: R2Dump; d1?: Record<string, number>; error?: string };
  if (!body.r2) {
    return { r2: null, d1: body.d1 ?? {}, error: body.error || "R2 dump missing r2 payload" };
  }
  const truncatedNote = body.r2.truncated ? "R2 listing truncated (partial bytes)" : null;
  return {
    r2: body.r2,
    d1: body.d1 ?? {},
    error: truncatedNote,
  };
}

async function fetchFirebaseStorageUsage(): Promise<{
  bytes: number;
  objects: number;
  truncated: boolean;
  error: string | null;
}> {
  // Media lives in Cloudflare R2. The default GCS bucket
  // (safechild-f34ac.firebasestorage.app) does not exist — listing it
  // only slowed dumps and added a 404 warning.
  return {
    bytes: 0,
    objects: 0,
    truncated: false,
    error: "unused — child media is on Cloudflare R2, not Firebase Storage",
  };
}

function joinXamppUrl(path: string): string {
  const base = XAMPP_STORAGE_URL.replace(/\/+$/, "");
  return `${base}/${path.replace(/^\/+/, "")}`;
}

function gcfCannotReachReason(raw: string): string | null {
  if (!raw) {
    return "XAMPP_STORAGE_URL is not set. Cloud Functions cannot see http://127.0.0.1 on this PC.";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "XAMPP_STORAGE_URL is not a valid URL.";
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) {
    return "Cloud Functions run in Google Cloud. localhost is not the Windows PC — use a Cloudflare Tunnel HTTPS hostname.";
  }
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
      return "XAMPP_STORAGE_URL is a private LAN address. GCP cannot reach RFC1918. Publish Apache via Cloudflare Tunnel (cloudflared is already installed).";
    }
  }
  return null;
}

function emptyPcBackend(error: string | null, httpStatus: number | null = null) {
  return {
    reachable: false,
    configured: Boolean(XAMPP_STORAGE_URL),
    error,
    httpStatus,
    bytes: 0,
    files: 0,
    diskUsedBytes: 0,
    diskTotalBytes: 0,
    diskPercent: 0,
    drive: "C:",
    storePath: XAMPP_INSTALL_PATH + "\\store",
    publicUrl: XAMPP_STORAGE_URL || null,
    localHealthUrl: XAMPP_LOCAL_HEALTH,
    mediaNote:
      "This PC folder is a local archive. Live child-device media still lives in Cloudflare R2 and Firestore unless you copy files here.",
  };
}

function describeXamppHttpError(status: number | null, url: string): string {
  if (status === 530 || status === 502 || status === 503 || status === 504) {
    return `PC tunnel offline (HTTP ${status}). Cloudflare could not reach this PC’s Apache — start the XAMPP tunnel / fix Worker origin. Live R2 media is unaffected.`;
  }
  if (status == null) {
    return `Functions could not reach ${url} (PC tunnel offline or network error). Live R2 media is unaffected.`;
  }
  return `HTTP ${status} from XAMPP health (${url})`;
}

async function probeXamppHealth(timeoutMs = 5000): Promise<ReturnType<typeof emptyPcBackend> & { body?: unknown; latencyMs?: number }> {
  const blocked = gcfCannotReachReason(XAMPP_STORAGE_URL);
  if (blocked) {
    return { ...emptyPcBackend(blocked, null), latencyMs: 0 };
  }
  const url = joinXamppUrl("health.json");
  const probe = await probeUrl(url, timeoutMs);
  const body = probe.body && typeof probe.body === "object" ? (probe.body as Record<string, unknown>) : null;
  const disk = (body?.disk as { usedBytes?: number; totalBytes?: number; percent?: number } | undefined) || {};
  if (!probe.ok || !body) {
    const err =
      typeof body?.error === "string"
        ? body.error
        : describeXamppHttpError(probe.status, url);
    return { ...emptyPcBackend(err, probe.status), latencyMs: probe.latencyMs, body: probe.body };
  }
  return {
    reachable: true,
    configured: true,
    error: null,
    httpStatus: probe.status,
    bytes: Number(body.storeBytes ?? 0),
    files: Number(body.storeFiles ?? 0),
    diskUsedBytes: Number(disk.usedBytes ?? 0),
    diskTotalBytes: Number(disk.totalBytes ?? 0),
    diskPercent: Number(disk.percent ?? 0),
    drive: String((disk as { drive?: string }).drive ?? "C:"),
    storePath: String(body.storePath ?? XAMPP_INSTALL_PATH + "\\store"),
    publicUrl: XAMPP_STORAGE_URL,
    localHealthUrl: XAMPP_LOCAL_HEALTH,
    mediaNote: String(body.mediaNote ?? emptyPcBackend(null).mediaNote),
    body,
    latencyMs: probe.latencyMs,
  };
}

async function xamppStorageRequest(action: "list" | "clear", extra?: Record<string, string>): Promise<Record<string, unknown>> {
  const blocked = gcfCannotReachReason(XAMPP_STORAGE_URL);
  if (blocked) {
    throw new HttpsError("failed-precondition", blocked);
  }
  if (!XAMPP_STORAGE_SECRET) {
    throw new HttpsError("failed-precondition", "XAMPP_STORAGE_SECRET is not set on Cloud Functions.");
  }
  const url = joinXamppUrl(`api.php?action=${action}`);
  const res = await fetch(url, {
    method: action === "clear" ? "POST" : "GET",
    headers: {
      "X-SareChild-Storage-Key": XAMPP_STORAGE_SECRET,
      "Content-Type": "application/json",
    },
    body: action === "clear" ? JSON.stringify({ confirm: extra?.confirm ?? "CLEAR-PC-STORE" }) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof data.error === "string" ? data.error : `XAMPP API HTTP ${res.status}`;
    throw new HttpsError(res.status === 401 ? "permission-denied" : "unavailable", msg);
  }
  return data;
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

const MAX_FAMILIES_IN_DUMP = 120;
const COUNT_BUDGET_MS = 20_000;
const R2_DUMP_BUDGET_MS = 55_000;
const MAX_DEVICES_COUNTED = 25;
const PREFERRED_FAMILY_ID = "tS2mTEiFqoY76nq7ei1d";

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
      pcXampp: emptyPcBackend("Dump ended before the PC probe."),
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

function applyR2Features(
  features: ReturnType<typeof emptyFeatureMap>,
  r2Fam: { features?: Record<string, { bytes: number; objects: number }> } | undefined,
) {
  if (!r2Fam) return;
  for (const [feat, usage] of Object.entries(r2Fam.features ?? {})) {
    const slot = features[feat] ?? (features[feat] = { docs: 0, estimatedBytes: 0, r2Bytes: 0, r2Objects: 0 });
    slot.r2Bytes += Number(usage.bytes ?? 0);
    slot.r2Objects += Number(usage.objects ?? 0);
  }
}

export async function buildStorageDump(): Promise<Record<string, unknown>> {
  const warnings: string[] = [];
  const r2Started = fetchR2Dump().catch((err) => ({
    r2: null as R2Dump | null,
    d1: {} as Record<string, number>,
    error: err instanceof Error ? err.message : String(err),
  }));

  const emptyProfiles = { docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] };
  const emptyFamilies = { docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] };

  // Never wait on R2 before listing families — a Worker timeout used to leave accounts=[].
  const [limits, firebaseStorage, profilesSnap, familiesSnap, pcXampp] = await Promise.all([
    loadLimits(),
    fetchFirebaseStorageUsage(),
    db.collection("parentProfiles").limit(400).get().catch((err) => {
      logger.warn("parentProfiles listing failed", err);
      warnings.push("Could not list parentProfiles.");
      return emptyProfiles;
    }),
    db.collection("families").limit(MAX_FAMILIES_IN_DUMP).get().catch((err) => {
      logger.warn("families listing failed", err);
      warnings.push("Could not list families.");
      return emptyFamilies;
    }),
    probeXamppHealth(4000),
  ]);

  const r2Bundle = await Promise.race([
    r2Started,
    sleep(R2_DUMP_BUDGET_MS).then(() => ({
      r2: null as R2Dump | null,
      d1: {} as Record<string, number>,
      error: "R2 dump timed out; family list is from Firestore. Per-family R2 shows unavailable until refresh succeeds.",
    })),
  ]);

  if (r2Bundle.error) warnings.push(`R2: ${r2Bundle.error}`);
  if (pcXampp.configured && pcXampp.error) warnings.push(`This PC (XAMPP): ${pcXampp.error}`);
  const r2Available = Boolean(r2Bundle.r2);

  const emailByFamily = new Map<string, { uid: string; email: string }>();
  for (const p of profilesSnap.docs) {
    const familyId = (p.get("familyId") as string | undefined) || (p.get("ownedFamilyId") as string | undefined);
    if (!familyId) continue;
    emailByFamily.set(familyId, { uid: p.id, email: (p.get("email") as string | undefined) || "" });
  }

  const familyDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  for (const family of familiesSnap.docs) familyDocs.set(family.id, family);

  if (!familyDocs.has(PREFERRED_FAMILY_ID) && !emailByFamily.has(PREFERRED_FAMILY_ID)) {
    try {
      const preferred = await db.collection("families").doc(PREFERRED_FAMILY_ID).get();
      if (preferred.exists) familyDocs.set(PREFERRED_FAMILY_ID, preferred);
    } catch (err) {
      logger.warn("preferred family fetch failed", err);
    }
  }

  let familyIds = [...new Set([...familyDocs.keys(), ...emailByFamily.keys()])];
  // Prefer real customer families (linked parentProfiles / preferred) over orphan empty shells when truncating.
  familyIds.sort((a, b) => {
    if (a === PREFERRED_FAMILY_ID) return -1;
    if (b === PREFERRED_FAMILY_ID) return 1;
    const ap = emailByFamily.has(a) ? 0 : 1;
    const bp = emailByFamily.has(b) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.localeCompare(b);
  });
  if (familyIds.length > MAX_FAMILIES_IN_DUMP) {
    warnings.push(`Truncated to ${MAX_FAMILIES_IN_DUMP} of ${familyIds.length} families for this dump`);
  }
  const ids = familyIds.slice(0, MAX_FAMILIES_IN_DUMP);

  logger.info("buildStorageDump listed families", {
    familyCount: familyIds.length,
    profileCount: profilesSnap.docs.length,
    r2Reachable: Boolean(r2Bundle.r2),
    r2Error: r2Bundle.error ?? null,
  });

  const r2Families = r2Bundle.r2?.families ?? {};
  const accounts: Array<Record<string, unknown>> = [];
  let firestoreDocs = 0;
  let countsTruncated = false;
  const countsStarted = Date.now();

  for (const familyId of ids) {
    const family = familyDocs.get(familyId);
    const owner = emailByFamily.get(familyId);
    const r2Fam = r2Families[familyId];
    const features = emptyFeatureMap();
    applyR2Features(features, r2Fam);
    let docs = 0;
    let childNames: string[] = [];
    let deviceCount = 0;
    const budgetLeft = COUNT_BUDGET_MS - (Date.now() - countsStarted);
    if (budgetLeft < 400) {
      countsTruncated = true;
    } else {
      const familyRef = family?.ref ?? db.collection("families").doc(familyId);
      try {
        const familyCounts = await Promise.all(
          FAMILY_COUNT_COLS.map(async (col) => ({ col, n: await countColSafe(familyRef.collection(col)) })),
        );
        for (const { col, n } of familyCounts) {
          docs += n;
          const feat = COL_TO_FEATURE[col] ?? "other";
          features[feat].docs += n;
          features[feat].estimatedBytes += n * ESTIMATE_BYTES_PER_DOC;
        }
      } catch (err) {
        logger.warn(`family collection counts failed for ${familyId}`, err);
      }
      try {
        const devicesSnap = await familyRef.collection("devices").limit(MAX_DEVICES_COUNTED).get();
        deviceCount = devicesSnap.size;
        childNames = devicesSnap.docs.map((d) => (d.get("childName") as string | undefined) || d.id);
        if (Date.now() - countsStarted < COUNT_BUDGET_MS) {
          const deviceCounts = await Promise.all(
            devicesSnap.docs.map(async (device) => {
              const cols = await Promise.all(
                DEVICE_COUNT_COLS.map(async (col) => ({ col, n: await countColSafe(device.ref.collection(col)) })),
              );
              return cols;
            }),
          );
          for (const cols of deviceCounts) {
            for (const { col, n } of cols) {
              docs += n;
              const feat = COL_TO_FEATURE[col] ?? "other";
              features[feat].docs += n;
              features[feat].estimatedBytes += n * ESTIMATE_BYTES_PER_DOC;
            }
          }
        }
      } catch (err) {
        logger.warn(`devices listing failed for ${familyId}`, err);
      }
    }
    firestoreDocs += docs;
    const override = Number(family?.get("storageBytesMax") ?? 0);
    const row = accountSkeleton({
      familyId,
      parentUid: owner?.uid || (family?.get("parentUid") as string | undefined) || null,
      email: owner?.email || (family?.get("parentEmail") as string | undefined) || "",
      childNames,
      deviceCount,
      features,
      firestoreDocs: docs,
      r2Bytes: Number(r2Fam?.bytes ?? 0),
      r2Objects: Number(r2Fam?.objects ?? 0),
      estimatedBytes: Object.values(features).reduce((s, f) => s + f.estimatedBytes, 0),
      accountBytesMax: override > 0 ? override : limits.defaultAccountBytesMax,
      storageBlocked: Boolean(family?.get("storageBlocked")),
    });
    (row as { r2Available?: boolean }).r2Available = r2Available;
    accounts.push(row);
  }

  if (countsTruncated) {
    warnings.push("Doc counts timed out; remaining families are listed with R2 bytes only so Clear/Reset still works.");
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
        error: r2Bundle.error ?? (r2Bundle.r2 ? null : "R2 unavailable"),
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
        error: firebaseStorage.error ?? null,
      },
      d1: r2Bundle.d1 ?? {},
      kv: { note: "Edge cache flags only — not billed per object." },
      pcXampp: {
        reachable: pcXampp.reachable,
        configured: pcXampp.configured,
        error: pcXampp.error ?? null,
        httpStatus: pcXampp.httpStatus ?? null,
        bytes: pcXampp.bytes,
        files: pcXampp.files,
        diskUsedBytes: pcXampp.diskUsedBytes,
        diskTotalBytes: pcXampp.diskTotalBytes,
        diskPercent: pcXampp.diskPercent,
        drive: pcXampp.drive,
        storePath: pcXampp.storePath,
        publicUrl: pcXampp.publicUrl,
        localHealthUrl: pcXampp.localHealthUrl,
        mediaNote: pcXampp.mediaNote,
      },
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

  logger.info("buildStorageDump complete", {
    accounts: accounts.length,
    firestoreDocs,
    r2Bytes,
    warningCount: warnings.length,
  });

  const safe = jsonSafe(dump);
  try {
    await db.collection("adminConfig").doc("storageDump").set(safe);
  } catch (err) {
    logger.warn("storageDump persist skipped", err);
    const persistNote = "Could not cache dump in Firestore (response still includes live accounts).";
    (safe as { warnings: string[] }).warnings = [...warnings, persistNote];
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

    if (scope === "pc-store") {
      if (confirm !== "CLEAR-PC-STORE") {
        throw new HttpsError("failed-precondition", "Type CLEAR-PC-STORE to confirm wiping the Windows PC archive.");
      }
      const result = await xamppStorageRequest("clear", { confirm: "CLEAR-PC-STORE" });
      await writeAuditLog({
        action: "clear_storage",
        adminEmail,
        targetUid: "pc-xampp",
        detail: `Cleared XAMPP local store: ${Number(result.deletedFiles ?? 0)} files, ${Number(result.deletedBytes ?? 0)} bytes`,
      });
      return {
        ok: true,
        docs: 0,
        media: Number(result.deletedFiles ?? 0),
        deletedBytes: Number(result.deletedBytes ?? 0),
        storePath: result.storePath,
      };
    }

    if (scope === "empty-leftovers") {
      if (confirm !== "DELETE-EMPTY-LEFTOVERS") {
        throw new HttpsError(
          "failed-precondition",
          "Type DELETE-EMPTY-LEFTOVERS to confirm deleting empty leftover families.",
        );
      }
      const requested = Array.isArray(request.data?.familyIds)
        ? (request.data.familyIds as unknown[]).map((id) => String(id).trim()).filter(Boolean)
        : [];
      const uniqueRequested = [...new Set(requested)];
      if (uniqueRequested.length === 0) {
        throw new HttpsError("invalid-argument", "Pass familyIds of empty leftover families to delete.");
      }
      if (uniqueRequested.includes(PREFERRED_FAMILY_ID)) {
        throw new HttpsError(
          "failed-precondition",
          `Refusing to delete protected family ${PREFERRED_FAMILY_ID}.`,
        );
      }

      const deleted: string[] = [];
      const skipped: Array<{ familyId: string; reason: string }> = [];

      for (const familyId of uniqueRequested) {
        if (familyId === PREFERRED_FAMILY_ID) {
          skipped.push({ familyId, reason: "protected preferred family" });
          continue;
        }
        const familyRef = db.collection("families").doc(familyId);
        const familySnap = await familyRef.get();
        if (!familySnap.exists) {
          skipped.push({ familyId, reason: "already gone" });
          continue;
        }
        const devices = await familyRef.collection("devices").limit(1).get();
        if (!devices.empty) {
          skipped.push({ familyId, reason: "has devices" });
          continue;
        }
        let docs = 0;
        for (const col of FAMILY_COUNT_COLS) {
          docs += await countColSafe(familyRef.collection(col));
          if (docs > 0) break;
        }
        if (docs > 0) {
          skipped.push({ familyId, reason: "has firestore docs" });
          continue;
        }

        await deleteR2Prefix(`families/${familyId}/`);
        await wipeFamilyData(familyId);

        const profiles = await db.collection("parentProfiles").where("familyId", "==", familyId).get();
        const owned = await db.collection("parentProfiles").where("ownedFamilyId", "==", familyId).get();
        const profileDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
        for (const p of profiles.docs) profileDocs.set(p.id, p);
        for (const p of owned.docs) profileDocs.set(p.id, p);
        for (const p of profileDocs.values()) {
          const email = (p.get("email") as string | undefined) || "";
          const newId = await createFreshFamilyForUser(p.id, email);
          await p.ref.set({ familyId: newId, ownedFamilyId: newId }, { merge: true });
        }

        deleted.push(familyId);
      }

      await writeAuditLog({
        action: "clear_storage",
        adminEmail,
        targetUid: "empty-leftovers",
        detail: `Deleted ${deleted.length} empty leftover families; skipped ${skipped.length}`,
        meta: { deleted, skipped },
      });
      return {
        ok: true,
        docs: 0,
        media: 0,
        families: deleted.length,
        deletedFamilyIds: deleted,
        skipped,
      };
    }

    throw new HttpsError(
      "invalid-argument",
      "scope must be feature, account, platform, pc-store, or empty-leftovers.",
    );
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
  const includeLegacyDroplet = Boolean((request.data as { includeLegacyDroplet?: boolean } | undefined)?.includeLegacyDroplet);
  const pcHealth = await probeXamppHealth(4000);
  const payload: Record<string, unknown> = {
    takenAtMs: Date.now(),
    droplet: null,
    cloudflare: {
      r2Bucket: "luscsl-uploads",
      worker: R2_PROXY_BASE,
      d1: "sarechild-ops",
    },
    firebase: {
      projectId: process.env.GCLOUD_PROJECT || "safechild-f34ac",
      storageBucket: "unused (media is on Cloudflare R2)",
    },
    pc: {
      provider: "xampp",
      host: "this Windows PC",
      installPath: XAMPP_INSTALL_PATH,
      localHealthUrl: XAMPP_LOCAL_HEALTH,
      publicUrl: XAMPP_STORAGE_URL || null,
      secretConfigured: Boolean(XAMPP_STORAGE_SECRET),
      roles: [
        {
          id: "ops-health",
          label: "Ops health + disk dump",
          detail: `${XAMPP_LOCAL_HEALTH} — drive used/total and bytes under store/`,
        },
        {
          id: "local-archive",
          label: "Local archive folder",
          detail: `${XAMPP_INSTALL_PATH}\\store — TCD can list/clear via Functions when a tunnel URL is set`,
        },
      ],
      reachableFromFunctions: pcHealth.reachable,
      probe: {
        ok: pcHealth.reachable,
        status: pcHealth.httpStatus ?? (pcHealth.reachable ? 200 : null),
        latencyMs: pcHealth.latencyMs ?? 0,
        body: pcHealth.body ?? null,
        inconclusive: !pcHealth.reachable && !XAMPP_STORAGE_URL,
        note: pcHealth.error ?? null,
      },
      disk: pcHealth.reachable
        ? {
            usedBytes: pcHealth.diskUsedBytes,
            totalBytes: pcHealth.diskTotalBytes,
            percent: pcHealth.diskPercent,
            drive: pcHealth.drive,
            storeBytes: pcHealth.bytes,
            storeFiles: pcHealth.files,
            storePath: pcHealth.storePath,
          }
        : null,
      mixedContentNote:
        "TCD on GitHub Pages is HTTPS. The browser cannot call http://127.0.0.1 (mixed content). Cloud Functions reach this PC through Cloudflare (free) at https://sarechild-pc-storage.neuereatec.workers.dev/sarechild-storage (Worker → this PC PHP/Apache).",
      tunnelHint:
        "Cloudflare Tunnel (free) → this PC Apache. Live health: https://sarechild-pc-storage.neuereatec.workers.dev/sarechild-storage/health.json. Live child media stays on R2.",
      mediaNote: pcHealth.mediaNote,
    },
  };

  // Default OFF. DigitalOcean is unused; do not require DO_API_TOKEN.
  if (includeLegacyDroplet) {
    const [health, staging, turn] = await Promise.all([
      probeUrl(VPS_HEALTH_URL, 2500),
      probeUrl(VPS_STAGING_URL, 2500),
      tcpReachable(VPS_HOST, 3478, 1500),
    ]);
    payload.droplet = {
      unused: true,
      provider: "legacy",
      host: VPS_HOST,
      note: "Legacy droplet unused. Not a storage backend.",
      probes: {
        opsHealth: {
          ...health,
          body: health.body ?? null,
          inconclusive: !health.ok && health.status == null,
          note: probeFailureNote("http-private", health),
        },
        staging: {
          ...staging,
          body: staging.body ?? null,
          inconclusive: !staging.ok && staging.status == null,
          note: probeFailureNote("http-private", staging),
        },
        turn3478: {
          ...turn,
          inconclusive: !turn.ok,
          note: probeFailureNote("tcp-turn", {
            ok: turn.ok,
            status: null,
            body: turn.ok ? null : { error: "tcp connect failed" },
          }),
        },
      },
    };
  }

  return jsonSafe(payload);
});

export const adminManagePcStorage = onCall({ cors: true, timeoutSeconds: 60 }, async (request) => {
  assertProjectAdmin(request);
  const action = String(request.data?.action ?? "list").trim();
  if (action === "health") {
    return jsonSafe(await probeXamppHealth(8000));
  }
  if (action === "list") {
    return jsonSafe(await xamppStorageRequest("list"));
  }
  if (action === "clear") {
    const confirm = String(request.data?.confirm ?? "").trim();
    if (confirm !== "CLEAR-PC-STORE") {
      throw new HttpsError("failed-precondition", "Type CLEAR-PC-STORE to confirm.");
    }
    return jsonSafe(await xamppStorageRequest("clear", { confirm }));
  }
  throw new HttpsError("invalid-argument", "action must be health, list, or clear.");
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
