export interface Env {
  MEDIA_BUCKET: R2Bucket;
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
