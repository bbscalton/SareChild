import process from "node:process";

const checks = [];

function pushCheck(name, ok, message) {
  checks.push({ name, ok, message });
}

async function checkUrl(name, url) {
  if (!url) {
    pushCheck(name, false, "Missing URL");
    return;
  }
  try {
    const res = await fetch(url, { method: "GET" });
    pushCheck(name, res.ok, res.ok ? "OK" : `HTTP ${res.status}`);
  } catch (error) {
    pushCheck(name, false, error instanceof Error ? error.message : "Request failed");
  }
}

await checkUrl("Parent Web", process.env.TCD_PARENT_WEB_URL);
await checkUrl("Cloudflare R2 Proxy", process.env.TCD_R2_HEALTH_URL);
await checkUrl(
  "Platform Health (Cloudflare)",
  process.env.TCD_PLATFORM_HEALTH_URL || process.env.TCD_FUNCTIONS_HEALTH_URL,
);

const failures = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), checks }, null, 2));

if (failures.length > 0) {
  console.error(`TCD health check failed (${failures.length} check(s)).`);
  process.exit(1);
}

