type Env = {
  MEDIA_BUCKET: R2Bucket;
  DB: D1Database;
  EDGE_CACHE: KVNamespace;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_API_KEY?: string;
  FIREBASE_AUTH_DOMAIN?: string;
  WENT_DARK_AFTER_MS?: string;
  MEDIA_PURGE_SECRET?: string;
  // Server-side-only Google Maps Platform key, restricted (API restriction) to the Roads
  // API — never shipped to the browser. Lets parent-web snap GPS trails to real streets
  // without needing a browser-referrer-restricted key (Roads API has no CORS headers and
  // Google does not support HTTP-referrer restriction for it), and without touching the
  // Android-restricted "SareChild Parent Maps (Android)" key. Set via:
  //   wrangler secret put GOOGLE_ROADS_SERVER_KEY
  GOOGLE_ROADS_SERVER_KEY?: string;
};

type Status = "ok" | "warn" | "fail";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,HEAD,PUT,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-family-id",
      "cache-control": "no-store",
    },
  });
}

function wentDarkMs(env: Env): number {
  const raw = Number(env.WENT_DARK_AFTER_MS ?? 300000);
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

async function probeFirebase(env: Env): Promise<{
  status: Status;
  message: string;
  latencyMs: number | null;
}> {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  const apiKey = env.FIREBASE_API_KEY?.trim();
  const authDomain = env.FIREBASE_AUTH_DOMAIN?.trim();
  if (!projectId && !apiKey && !authDomain) {
    return { status: "warn", message: "Firebase probe vars not set on Worker.", latencyMs: null };
  }

  const started = Date.now();
  try {
    if (apiKey) {
      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`,
        { method: "GET" },
      );
      const latencyMs = Date.now() - started;
      if (res.status === 200 || res.status === 400 || res.status === 403) {
        return {
          status: "ok",
          message: `Firebase Auth API reachable from Cloudflare (HTTP ${res.status}).`,
          latencyMs,
        };
      }
      return { status: "fail", message: `Firebase Auth API returned HTTP ${res.status}.`, latencyMs };
    }

    const host = authDomain || `${projectId}.firebaseapp.com`;
    const res = await fetch(`https://${host}/__/firebase/init.json`, { method: "GET" });
    const latencyMs = Date.now() - started;
    if (res.ok || res.status === 404) {
      return { status: "ok", message: `Firebase hosting/auth domain reachable (${host}).`, latencyMs };
    }
    return { status: "fail", message: `Firebase domain probe returned HTTP ${res.status}.`, latencyMs };
  } catch (error) {
    return {
      status: "fail",
      message: error instanceof Error ? error.message : "Firebase probe failed.",
      latencyMs: Date.now() - started,
    };
  }
}

async function probeD1(env: Env): Promise<{ status: Status; message: string; latencyMs: number }> {
  const started = Date.now();
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return { status: "ok", message: "D1 ops database is reachable.", latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: "fail",
      message: error instanceof Error ? error.message : "D1 probe failed.",
      latencyMs: Date.now() - started,
    };
  }
}

async function probeKv(env: Env): Promise<{ status: Status; message: string; latencyMs: number }> {
  const started = Date.now();
  const probeKey = "__health_probe";
  try {
    // Read-only first — health checks run often; unique put() keys exhaust daily KV write quota.
    const existing = await env.EDGE_CACHE.get(probeKey);
    if (existing != null) {
      return {
        status: "ok",
        message: "KV edge cache is reachable.",
        latencyMs: Date.now() - started,
      };
    }
    try {
      await env.EDGE_CACHE.put(probeKey, "1", { expirationTtl: 86400 });
    } catch (putError) {
      const msg = putError instanceof Error ? putError.message : String(putError);
      if (/limit exceeded/i.test(msg)) {
        return {
          status: "warn",
          message: "KV reads OK; daily write quota reached (health probe is read-only).",
          latencyMs: Date.now() - started,
        };
      }
      throw putError;
    }
    const value = await env.EDGE_CACHE.get(probeKey);
    return {
      status: value === "1" ? "ok" : "fail",
      message: value === "1" ? "KV edge cache is reachable." : "KV write/read mismatch.",
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      status: "fail",
      message: error instanceof Error ? error.message : "KV probe failed.",
      latencyMs: Date.now() - started,
    };
  }
}

type FleetSnapshot = {
  familyId: string;
  registeredDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  guardians: number;
  alertsLast24h: number;
  criticalAlertsLast24h: number;
  pendingCommands: number;
  latestHeartbeatMs: number;
  source: string;
  updatedAtMs: number;
};

async function upsertFleetSnapshot(env: Env, snap: FleetSnapshot): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fleet_snapshots (
      family_id, registered_devices, online_devices, offline_devices, guardians,
      alerts_last_24h, critical_alerts_last_24h, pending_commands, latest_heartbeat_ms,
      source, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(family_id) DO UPDATE SET
      registered_devices=excluded.registered_devices,
      online_devices=excluded.online_devices,
      offline_devices=excluded.offline_devices,
      guardians=excluded.guardians,
      alerts_last_24h=excluded.alerts_last_24h,
      critical_alerts_last_24h=excluded.critical_alerts_last_24h,
      pending_commands=excluded.pending_commands,
      latest_heartbeat_ms=excluded.latest_heartbeat_ms,
      source=excluded.source,
      updated_at_ms=excluded.updated_at_ms`,
  )
    .bind(
      snap.familyId,
      snap.registeredDevices,
      snap.onlineDevices,
      snap.offlineDevices,
      snap.guardians,
      snap.alertsLast24h,
      snap.criticalAlertsLast24h,
      snap.pendingCommands,
      snap.latestHeartbeatMs,
      snap.source,
      snap.updatedAtMs,
    )
    .run();

  await env.EDGE_CACHE.put(`fleet:${snap.familyId}`, JSON.stringify(snap), {
    expirationTtl: 60 * 30,
  });
}

async function readFleetSnapshot(env: Env, familyId: string): Promise<FleetSnapshot | null> {
  const cached = await env.EDGE_CACHE.get(`fleet:${familyId}`, "json");
  if (cached && typeof cached === "object") {
    return cached as FleetSnapshot;
  }
  const row = await env.DB.prepare(
    `SELECT family_id as familyId, registered_devices as registeredDevices,
      online_devices as onlineDevices, offline_devices as offlineDevices,
      guardians, alerts_last_24h as alertsLast24h,
      critical_alerts_last_24h as criticalAlertsLast24h,
      pending_commands as pendingCommands, latest_heartbeat_ms as latestHeartbeatMs,
      source, updated_at_ms as updatedAtMs
     FROM fleet_snapshots WHERE family_id = ?`,
  )
    .bind(familyId)
    .first<FleetSnapshot>();
  return row ?? null;
}

type RoadPoint = { lat: number; lng: number };
type SnappedPoint = { lat: number; lng: number; originalIndex: number | null };

const ROADS_API_MAX_POINTS = 100; // Roads API hard limit per snapToRoads request.

/** Evenly downsamples to at most `max` points, always keeping the first and last. */
function downsamplePoints(points: RoadPoint[], max: number): RoadPoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: RoadPoint[] = [];
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]!);
  }
  return out;
}

/**
 * Snaps a raw GPS path to real streets via the Roads API `snapToRoads` endpoint, using a
 * server-side-only key (never exposed to the browser — Roads API also has no CORS headers,
 * so browsers cannot call it directly regardless of key type). Input is downsampled to the
 * API's 100-point cap first; `interpolate=true` still fills in road-following geometry
 * between the kept points. Returns `originalIndex` (into the *downsampled* input) for every
 * snapped point that corresponds 1:1 to an input point, `null` for Google's own interpolated
 * in-between points — the caller uses this to re-attach/interpolate timestamps.
 */
async function snapToRoads(
  env: Env,
  rawPoints: RoadPoint[],
): Promise<{ ok: true; input: RoadPoint[]; snapped: SnappedPoint[] } | { ok: false; error: string }> {
  const key = env.GOOGLE_ROADS_SERVER_KEY?.trim();
  if (!key) return { ok: false, error: "Roads API server key not configured on the Worker." };
  if (rawPoints.length < 2) return { ok: false, error: "Need at least 2 points to snap." };

  const input = downsamplePoints(rawPoints, ROADS_API_MAX_POINTS);
  const path = input.map((p) => `${p.lat},${p.lng}`).join("|");
  const apiUrl = `https://roads.googleapis.com/v1/snapToRoads?interpolate=true&key=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`;

  try {
    const res = await fetch(apiUrl, { method: "GET" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Roads API HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = (await res.json()) as {
      snappedPoints?: Array<{
        location: { latitude: number; longitude: number };
        originalIndex?: number;
      }>;
      error?: { message?: string };
    };
    if (data.error) return { ok: false, error: data.error.message || "Roads API error" };
    const snappedPoints = data.snappedPoints ?? [];
    if (snappedPoints.length < 2) return { ok: false, error: "Roads API returned too few points." };
    const snapped: SnappedPoint[] = snappedPoints.map((sp) => ({
      lat: sp.location.latitude,
      lng: sp.location.longitude,
      originalIndex: typeof sp.originalIndex === "number" ? sp.originalIndex : null,
    }));
    return { ok: true, input, snapped };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Roads API request failed." };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({ ok: true });

    // Snap a raw GPS trail to real streets for the parent Live Map's history playback +
    // live trail polyline (see parent-web/src/lib/geo.ts `snapToRoads()`, which caches
    // results client-side so scrubbing/re-renders don't re-call this endpoint).
    if (request.method === "POST" && url.pathname === "/roads/snap") {
      let body: { points?: unknown };
      try {
        body = (await request.json()) as { points?: unknown };
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const rawPoints = Array.isArray(body.points)
        ? (body.points as unknown[])
            .map((p) => {
              if (!p || typeof p !== "object") return null;
              const m = p as Record<string, unknown>;
              const lat = Number(m.lat);
              const lng = Number(m.lng);
              return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
            })
            .filter((p): p is RoadPoint => p !== null)
        : [];
      if (rawPoints.length < 2) {
        return json({ ok: false, error: "Provide at least 2 { lat, lng } points." }, 400);
      }
      const result = await snapToRoads(env, rawPoints);
      if (!result.ok) return json(result, result.error.includes("not configured") ? 501 : 502);
      return json({ ok: true, input: result.input, snapped: result.snapped });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "sarechild-media-proxy",
        timestamp: Date.now(),
        bucketBound: Boolean(env.MEDIA_BUCKET),
        edge: { d1: Boolean(env.DB), kv: Boolean(env.EDGE_CACHE) },
      });
    }

    if (request.method === "GET" && url.pathname === "/platform-health") {
      const started = Date.now();
      let r2Status: Status = "fail";
      let r2Message = "R2 bucket binding missing.";
      try {
        await env.MEDIA_BUCKET.list({ limit: 1 });
        r2Status = "ok";
        r2Message = "R2 bucket binding is healthy.";
      } catch (error) {
        r2Message = error instanceof Error ? error.message : "R2 probe failed.";
      }

      const [firebase, d1, kv] = await Promise.all([probeFirebase(env), probeD1(env), probeKv(env)]);
      const ok = r2Status === "ok" && d1.status !== "fail" && kv.status !== "fail" && firebase.status !== "fail";

      try {
        await env.DB.prepare(
          `INSERT INTO health_events (generated_at_ms, ok, r2_status, d1_status, kv_status, firebase_status, latency_ms, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            Date.now(),
            ok ? 1 : 0,
            r2Status,
            d1.status,
            kv.status,
            firebase.status,
            Date.now() - started,
            JSON.stringify({ r2Message, firebase, d1, kv }),
          )
          .run();
      } catch {
        // Health history should never break the health endpoint.
      }

      return json(
        {
          ok,
          service: "sarechild-platform-health",
          generatedAtMs: Date.now(),
          latencyMs: Date.now() - started,
          provider: "cloudflare",
          loadBalancing: "cloudflare-global-edge",
          redundancy: {
            primaryReads: "firebase-firestore",
            edgeCache: "cloudflare-kv",
            edgeOpsDb: "cloudflare-d1",
            media: "cloudflare-r2",
          },
          checks: {
            cloudflareWorker: { status: "ok", message: "Worker is serving requests on Cloudflare edge." },
            r2: { status: r2Status, message: r2Message },
            d1: d1,
            kv: kv,
            firebase: firebase,
          },
        },
        ok ? 200 : 503,
      );
    }

    // Fast fleet snapshot for TCD (KV → D1 failover).
    if (request.method === "GET" && url.pathname.startsWith("/edge/fleet/")) {
      const familyId = decodeURIComponent(url.pathname.replace("/edge/fleet/", ""));
      if (!familyId) return json({ error: "familyId required" }, 400);
      const started = Date.now();
      const snap = await readFleetSnapshot(env, familyId);
      if (!snap) {
        return json(
          {
            ok: false,
            source: "miss",
            message: "No edge snapshot yet. Sync from parent TCD after Firestore load.",
            latencyMs: Date.now() - started,
          },
          404,
        );
      }
      return json({
        ok: true,
        source: (await env.EDGE_CACHE.get(`fleet:${familyId}`)) ? "kv" : "d1",
        latencyMs: Date.now() - started,
        snapshot: snap,
      });
    }

    // Parent/TCD pushes fleet overview into edge cache for fast global reads.
    if (request.method === "POST" && url.pathname === "/edge/sync/fleet") {
      const body = (await request.json()) as Partial<FleetSnapshot> & { familyId?: string };
      if (!body.familyId) return json({ error: "familyId required" }, 400);
      const now = Date.now();
      const snap: FleetSnapshot = {
        familyId: body.familyId,
        registeredDevices: Number(body.registeredDevices ?? 0),
        onlineDevices: Number(body.onlineDevices ?? 0),
        offlineDevices: Number(body.offlineDevices ?? 0),
        guardians: Number(body.guardians ?? 0),
        alertsLast24h: Number(body.alertsLast24h ?? 0),
        criticalAlertsLast24h: Number(body.criticalAlertsLast24h ?? 0),
        pendingCommands: Number(body.pendingCommands ?? 0),
        latestHeartbeatMs: Number(body.latestHeartbeatMs ?? 0),
        source: String(body.source || "firebase"),
        updatedAtMs: now,
      };
      await upsertFleetSnapshot(env, snap);
      return json({ ok: true, cached: true, updatedAtMs: now });
    }

    // Child/device heartbeat dual-write for edge redundancy.
    if (request.method === "POST" && url.pathname === "/edge/sync/device") {
      const body = (await request.json()) as {
        familyId?: string;
        deviceId?: string;
        childName?: string;
        lastHeartbeatMs?: number;
        batteryPercent?: number;
        monitoringActive?: boolean;
      };
      if (!body.familyId || !body.deviceId) return json({ error: "familyId and deviceId required" }, 400);
      const now = Date.now();
      const hb = Number(body.lastHeartbeatMs ?? now);
      const online = now - hb < wentDarkMs(env) ? 1 : 0;
      await env.DB.prepare(
        `INSERT INTO device_heartbeats (
          family_id, device_id, child_name, last_heartbeat_ms, battery_percent, monitoring_active, online, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(family_id, device_id) DO UPDATE SET
          child_name=excluded.child_name,
          last_heartbeat_ms=excluded.last_heartbeat_ms,
          battery_percent=excluded.battery_percent,
          monitoring_active=excluded.monitoring_active,
          online=excluded.online,
          updated_at_ms=excluded.updated_at_ms`,
      )
        .bind(
          body.familyId,
          body.deviceId,
          body.childName || "Child",
          hb,
          body.batteryPercent ?? -1,
          body.monitoringActive ? 1 : 0,
          online,
          now,
        )
        .run();

      const agg = await env.DB.prepare(
        `SELECT COUNT(*) as registered,
                SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as online,
                MAX(last_heartbeat_ms) as latestHb
         FROM device_heartbeats WHERE family_id = ?`,
      )
        .bind(body.familyId)
        .first<{ registered: number; online: number; latestHb: number }>();

      const registered = Number(agg?.registered ?? 0);
      const onlineCount = Number(agg?.online ?? 0);
      await upsertFleetSnapshot(env, {
        familyId: body.familyId,
        registeredDevices: registered,
        onlineDevices: onlineCount,
        offlineDevices: Math.max(0, registered - onlineCount),
        guardians: 0,
        alertsLast24h: 0,
        criticalAlertsLast24h: 0,
        pendingCommands: 0,
        latestHeartbeatMs: Number(agg?.latestHb ?? hb),
        source: "edge-device-sync",
        updatedAtMs: now,
      });

      return json({ ok: true, online: Boolean(online), updatedAtMs: now });
    }

    if (request.method === "GET" && url.pathname === "/edge/health/history") {
      const rows = await env.DB.prepare(
        `SELECT id, generated_at_ms as generatedAtMs, ok, r2_status as r2Status,
                d1_status as d1Status, kv_status as kvStatus, firebase_status as firebaseStatus,
                latency_ms as latencyMs
         FROM health_events ORDER BY generated_at_ms DESC LIMIT 30`,
      ).all();
      return json({ ok: true, events: rows.results ?? [] });
    }

    if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
      const key = decodeURIComponent(url.pathname.replace("/upload/", ""));
      if (!key || key.includes("..")) return json({ error: "invalid path" }, 400);
      const contentType = url.searchParams.get("contentType") || "application/octet-stream";
      const body = request.body;
      if (!body) return json({ error: "missing body" }, 400);
      await env.MEDIA_BUCKET.put(key, body, { httpMetadata: { contentType } });
      return json({
        path: key,
        url: `${url.origin}/media/${encodeURIComponent(key)}`,
      });
    }

    // Public APK downloads for the marketing site. Files are uploaded to R2 under
    // the `downloads/` prefix (e.g. downloads/parent.apk, downloads/child.apk).
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname.startsWith("/downloads/")
    ) {
      const name = decodeURIComponent(url.pathname.replace("/downloads/", ""));
      if (!name || name.includes("..") || !name.endsWith(".apk")) {
        return new Response("invalid path", { status: 400 });
      }
      const obj = await env.MEDIA_BUCKET.get(`downloads/${name}`);
      if (!obj) return new Response("not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("content-type", "application/vnd.android.package-archive");
      headers.set("content-disposition", `attachment; filename="${name}"`);
      headers.set("content-length", String(obj.size));
      headers.set("etag", obj.httpEtag);
      headers.set("cache-control", "public, max-age=300, must-revalidate");
      headers.set("access-control-allow-origin", "*");
      return new Response(request.method === "HEAD" ? null : obj.body, {
        status: 200,
        headers,
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      const key = decodeURIComponent(url.pathname.replace("/media/", ""));
      if (!key || key.includes("..")) return new Response("invalid path", { status: 400 });
      const obj = await env.MEDIA_BUCKET.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("access-control-allow-origin", "*");
      return new Response(obj.body, { headers });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/media/")) {
      const secret = env.MEDIA_PURGE_SECRET?.trim();
      const auth = request.headers.get("authorization") ?? "";
      if (!secret || auth !== `Bearer ${secret}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const key = decodeURIComponent(url.pathname.replace("/media/", ""));
      if (!key || key.includes("..")) return json({ error: "invalid path" }, 400);
      await env.MEDIA_BUCKET.delete(key);
      return json({ ok: true, deleted: key });
    }

    // Bulk-deletes every R2 object under a device's media prefix (used by
    // functions/src/deviceDelete.ts when a parent removes a paired device).
    // Restricted to the families/{fid}/devices/{did}/ shape so this endpoint can
    // never be used to wipe an entire family or the whole bucket.
    if (request.method === "DELETE" && url.pathname.startsWith("/prefix/")) {
      const secret = env.MEDIA_PURGE_SECRET?.trim();
      const auth = request.headers.get("authorization") ?? "";
      if (!secret || auth !== `Bearer ${secret}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const prefix = decodeURIComponent(url.pathname.replace("/prefix/", ""));
      if (!prefix || !/^families\/[^/]+\/devices\/[^/]+\/$/.test(prefix)) {
        return json({ error: "invalid prefix" }, 400);
      }
      let deleted = 0;
      let cursor: string | undefined;
      do {
        const listed = await env.MEDIA_BUCKET.list({ prefix, cursor, limit: 1000 });
        if (listed.objects.length) {
          await env.MEDIA_BUCKET.delete(listed.objects.map((o) => o.key));
          deleted += listed.objects.length;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return json({ ok: true, prefix, deleted });
    }

    // Removes a device's D1 heartbeat row + refreshes the family's cached fleet
    // snapshot after deletePairedDevice() deletes it from Firestore.
    if (request.method === "POST" && url.pathname === "/edge/purge/device") {
      const secret = env.MEDIA_PURGE_SECRET?.trim();
      const auth = request.headers.get("authorization") ?? "";
      if (!secret || auth !== `Bearer ${secret}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as {
        familyId?: string;
        deviceId?: string;
      };
      const familyId = body.familyId?.trim();
      const deviceId = body.deviceId?.trim();
      if (!familyId || !deviceId) return json({ error: "familyId and deviceId required" }, 400);

      await env.DB.prepare(
        `DELETE FROM device_heartbeats WHERE family_id = ? AND device_id = ?`
      )
        .bind(familyId, deviceId)
        .run();

      const agg = await env.DB.prepare(
        `SELECT COUNT(*) as registered,
                SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as online,
                MAX(last_heartbeat_ms) as latestHb
         FROM device_heartbeats WHERE family_id = ?`
      )
        .bind(familyId)
        .first<{ registered: number; online: number; latestHb: number }>();

      const registered = Number(agg?.registered ?? 0);
      const onlineCount = Number(agg?.online ?? 0);
      const now = Date.now();
      await upsertFleetSnapshot(env, {
        familyId,
        registeredDevices: registered,
        onlineDevices: onlineCount,
        offlineDevices: Math.max(0, registered - onlineCount),
        guardians: 0,
        alertsLast24h: 0,
        criticalAlertsLast24h: 0,
        pendingCommands: 0,
        latestHeartbeatMs: Number(agg?.latestHb ?? 0),
        source: "edge-device-purge",
        updatedAtMs: now,
      });

      return json({ ok: true, familyId, deviceId, updatedAtMs: now });
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
