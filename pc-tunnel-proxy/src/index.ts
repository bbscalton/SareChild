// Ephemeral quick-tunnel origin for Apache on this PC. When this URL dies, Worker returns HTTP 530
// ("PC tunnel offline"). Prefer a named tunnel + stable hostname when DNS is ready.
const PHP_ORIGIN = "https://leu-impacts-reserve-somerset.trycloudflare.com";

function destUrl(reqUrl: string): string {
  const incoming = new URL(reqUrl);
  // Keep /sarechild-storage/* — Apache serves the app under that path on :80.
  const dest = new URL(PHP_ORIGIN);
  dest.pathname = incoming.pathname;
  dest.search = incoming.search;
  return dest.toString();
}

export default {
  async fetch(req: Request): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: "manual",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
    }
    return fetch(destUrl(req.url), init);
  },
};
