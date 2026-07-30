var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-family-id",
      "cache-control": "no-store"
    }
  });
}
__name(json, "json");
function wentDarkMs(env) {
  const raw = Number(env.WENT_DARK_AFTER_MS ?? 3e5);
  return Number.isFinite(raw) && raw > 0 ? raw : 3e5;
}
__name(wentDarkMs, "wentDarkMs");
async function probeFirebase(env) {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  const apiKey = env.FIREBASE_API_KEY?.trim();
  const authDomain = env.FIREBASE_AUTH_DOMAIN?.trim();
  if (!projectId && !apiKey && !authDomain) {
    return { status: "warn", message: "Firebase probe vars not set on Worker.", latencyMs: null };
  }
  const started = Date.now();
  try {
    if (apiKey) {
      const res2 = await fetch(
        `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`,
        { method: "GET" }
      );
      const latencyMs2 = Date.now() - started;
      if (res2.status === 200 || res2.status === 400 || res2.status === 403) {
        return {
          status: "ok",
          message: `Firebase Auth API reachable from Cloudflare (HTTP ${res2.status}).`,
          latencyMs: latencyMs2
        };
      }
      return { status: "fail", message: `Firebase Auth API returned HTTP ${res2.status}.`, latencyMs: latencyMs2 };
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
      latencyMs: Date.now() - started
    };
  }
}
__name(probeFirebase, "probeFirebase");
async function probeD1(env) {
  const started = Date.now();
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return { status: "ok", message: "D1 ops database is reachable.", latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: "fail",
      message: error instanceof Error ? error.message : "D1 probe failed.",
      latencyMs: Date.now() - started
    };
  }
}
__name(probeD1, "probeD1");
async function probeKv(env) {
  const started = Date.now();
  const key = `__health_${Date.now()}`;
  try {
    await env.EDGE_CACHE.put(key, "1", { expirationTtl: 60 });
    const value = await env.EDGE_CACHE.get(key);
    return {
      status: value === "1" ? "ok" : "fail",
      message: value === "1" ? "KV edge cache is reachable." : "KV write/read mismatch.",
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return {
      status: "fail",
      message: error instanceof Error ? error.message : "KV probe failed.",
      latencyMs: Date.now() - started
    };
  }
}
__name(probeKv, "probeKv");
async function upsertFleetSnapshot(env, snap) {
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
      updated_at_ms=excluded.updated_at_ms`
  ).bind(
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
    snap.updatedAtMs
  ).run();
  await env.EDGE_CACHE.put(`fleet:${snap.familyId}`, JSON.stringify(snap), {
    expirationTtl: 60 * 30
  });
}
__name(upsertFleetSnapshot, "upsertFleetSnapshot");
async function readFleetSnapshot(env, familyId) {
  const cached = await env.EDGE_CACHE.get(`fleet:${familyId}`, "json");
  if (cached && typeof cached === "object") {
    return cached;
  }
  const row = await env.DB.prepare(
    `SELECT family_id as familyId, registered_devices as registeredDevices,
      online_devices as onlineDevices, offline_devices as offlineDevices,
      guardians, alerts_last_24h as alertsLast24h,
      critical_alerts_last_24h as criticalAlertsLast24h,
      pending_commands as pendingCommands, latest_heartbeat_ms as latestHeartbeatMs,
      source, updated_at_ms as updatedAtMs
     FROM fleet_snapshots WHERE family_id = ?`
  ).bind(familyId).first();
  return row ?? null;
}
__name(readFleetSnapshot, "readFleetSnapshot");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "sarechild-media-proxy",
        timestamp: Date.now(),
        bucketBound: Boolean(env.MEDIA_BUCKET),
        edge: { d1: Boolean(env.DB), kv: Boolean(env.EDGE_CACHE) }
      });
    }
    if (request.method === "GET" && url.pathname === "/platform-health") {
      const started = Date.now();
      let r2Status = "fail";
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          Date.now(),
          ok ? 1 : 0,
          r2Status,
          d1.status,
          kv.status,
          firebase.status,
          Date.now() - started,
          JSON.stringify({ r2Message, firebase, d1, kv })
        ).run();
      } catch {
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
            media: "cloudflare-r2"
          },
          checks: {
            cloudflareWorker: { status: "ok", message: "Worker is serving requests on Cloudflare edge." },
            r2: { status: r2Status, message: r2Message },
            d1,
            kv,
            firebase
          }
        },
        ok ? 200 : 503
      );
    }
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
            latencyMs: Date.now() - started
          },
          404
        );
      }
      return json({
        ok: true,
        source: await env.EDGE_CACHE.get(`fleet:${familyId}`) ? "kv" : "d1",
        latencyMs: Date.now() - started,
        snapshot: snap
      });
    }
    if (request.method === "POST" && url.pathname === "/edge/sync/fleet") {
      const body = await request.json();
      if (!body.familyId) return json({ error: "familyId required" }, 400);
      const now = Date.now();
      const snap = {
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
        updatedAtMs: now
      };
      await upsertFleetSnapshot(env, snap);
      return json({ ok: true, cached: true, updatedAtMs: now });
    }
    if (request.method === "POST" && url.pathname === "/edge/sync/device") {
      const body = await request.json();
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
          updated_at_ms=excluded.updated_at_ms`
      ).bind(
        body.familyId,
        body.deviceId,
        body.childName || "Child",
        hb,
        body.batteryPercent ?? -1,
        body.monitoringActive ? 1 : 0,
        online,
        now
      ).run();
      const agg = await env.DB.prepare(
        `SELECT COUNT(*) as registered,
                SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as online,
                MAX(last_heartbeat_ms) as latestHb
         FROM device_heartbeats WHERE family_id = ?`
      ).bind(body.familyId).first();
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
        updatedAtMs: now
      });
      return json({ ok: true, online: Boolean(online), updatedAtMs: now });
    }
    if (request.method === "GET" && url.pathname === "/edge/health/history") {
      const rows = await env.DB.prepare(
        `SELECT id, generated_at_ms as generatedAtMs, ok, r2_status as r2Status,
                d1_status as d1Status, kv_status as kvStatus, firebase_status as firebaseStatus,
                latency_ms as latencyMs
         FROM health_events ORDER BY generated_at_ms DESC LIMIT 30`
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
        url: `${url.origin}/media/${encodeURIComponent(key)}`
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
    return json({ error: "not found" }, 404);
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
