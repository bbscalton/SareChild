export interface Env {
  MEDIA_BUCKET: R2Bucket;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_API_KEY?: string;
  FIREBASE_AUTH_DOMAIN?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,PUT,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

async function probeFirebase(env: Env): Promise<{
  status: "ok" | "warn" | "fail";
  message: string;
  latencyMs: number | null;
}> {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  const apiKey = env.FIREBASE_API_KEY?.trim();
  const authDomain = env.FIREBASE_AUTH_DOMAIN?.trim();

  if (!projectId && !apiKey && !authDomain) {
    return {
      status: "warn",
      message: "Firebase probe vars not set on Worker (optional).",
      latencyMs: null,
    };
  }

  const started = Date.now();
  try {
    // Prefer Identity Toolkit project config when API key is available (no Blaze needed).
    if (apiKey) {
      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`,
        { method: "GET" },
      );
      const latencyMs = Date.now() - started;
      // 200/400/403 still prove Google Auth API reachability from this Worker.
      if (res.status === 200 || res.status === 400 || res.status === 403) {
        return {
          status: "ok",
          message: `Firebase Auth API reachable from Cloudflare (HTTP ${res.status}).`,
          latencyMs,
        };
      }
      return {
        status: "fail",
        message: `Firebase Auth API returned HTTP ${res.status}.`,
        latencyMs,
      };
    }

    const host = authDomain || `${projectId}.firebaseapp.com`;
    const res = await fetch(`https://${host}/__/firebase/init.json`, { method: "GET" });
    const latencyMs = Date.now() - started;
    if (res.ok || res.status === 404) {
      return {
        status: "ok",
        message: `Firebase hosting/auth domain reachable (${host}).`,
        latencyMs,
      };
    }
    return {
      status: "fail",
      message: `Firebase domain probe returned HTTP ${res.status}.`,
      latencyMs,
    };
  } catch (error) {
    return {
      status: "fail",
      message: error instanceof Error ? error.message : "Firebase probe failed.",
      latencyMs: Date.now() - started,
    };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({ ok: true });

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "r2-proxy",
        timestamp: Date.now(),
        bucketBound: Boolean(env.MEDIA_BUCKET),
      });
    }

    // Blaze-free replacement for Firebase platformHealth Cloud Function.
    if (request.method === "GET" && url.pathname === "/platform-health") {
      const started = Date.now();
      let r2Status: "ok" | "fail" = "fail";
      let r2Message = "R2 bucket binding missing.";
      try {
        // Lightweight R2 binding check (list with max 1).
        await env.MEDIA_BUCKET.list({ limit: 1 });
        r2Status = "ok";
        r2Message = "R2 bucket binding is healthy.";
      } catch (error) {
        r2Message = error instanceof Error ? error.message : "R2 probe failed.";
      }

      const firebase = await probeFirebase(env);
      const ok = r2Status === "ok" && firebase.status !== "fail";
      return json(
        {
          ok,
          service: "sarechild-platform-health",
          generatedAtMs: Date.now(),
          latencyMs: Date.now() - started,
          provider: "cloudflare",
          replaces: "firebase-functions/platformHealth",
          checks: {
            cloudflareWorker: { status: "ok", message: "Worker is serving requests." },
            r2: { status: r2Status, message: r2Message },
            firebase: firebase,
          },
        },
        ok ? 200 : 503,
      );
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
  },
} satisfies ExportedHandler<Env>;
