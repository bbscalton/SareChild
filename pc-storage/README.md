# SareChild PC storage (XAMPP)

Local file archive on the Windows PC that already runs Apache (`C:\xampp2`). It is **not** a replacement for Cloudflare R2. Child devices still upload live media to R2 + Firestore.

## Local URLs (this PC only)

- Health: http://127.0.0.1/sarechild-storage/health.json
- HTML: http://127.0.0.1/sarechild-storage/
- Folder: `C:\xampp2\htdocs\sarechild-storage\store`

GitHub Pages TCD is **HTTPS**, so the browser **cannot** fetch these HTTP URLs (mixed content). localhost from Cloud Functions is Google Cloud, not this PC.

## Make TCD see this disk

Public `:80` on the ISP IP is typically blocked by NAT. The free Cloudflare Worker `sarechild-pc-storage.neuereatec.workers.dev` publishes Apache/PHP on this machine (`pc-tunnel-proxy/` → quick/named tunnel → `http://127.0.0.1:80`).

- Health: https://sarechild-pc-storage.neuereatec.workers.dev/sarechild-storage/health.json

**HTTP 530 / “PC tunnel offline”** means the Worker origin tunnel URL is dead (ephemeral trycloudflare hostnames expire) or cloudflared is not running. Local Apache can still be fine at http://127.0.0.1/sarechild-storage/health.json. Live child media on R2 is unaffected.

Fix: start a tunnel to this PC (`scripts/run-xampp-storage-tunnel.ps1` or a quick tunnel), update `pc-tunnel-proxy/src/index.ts` `PHP_ORIGIN`, then `npx wrangler deploy` from `pc-tunnel-proxy/`.

Set gitignored `functions/.env` (`XAMPP_STORAGE_URL=https://sarechild-pc-storage.neuereatec.workers.dev/sarechild-storage`) then `firebase deploy --only functions:adminGetStorageDump,functions:adminGetInfraStatus,functions:adminManagePcStorage --project safechild-f34ac`.

Open TCD Storage → Refresh dump. The **This PC (XAMPP)** card shows drive used/total when Functions can reach the tunnel.

## Clear the local store

In TCD Storage, type `CLEAR-PC-STORE` and click **Clear PC archive**. That calls Cloud Functions, which POST to this PHP API. It deletes files under `store/` only — not R2.

Or from this PC:

```
curl http://127.0.0.1/sarechild-storage/api.php?action=list -H "X-SareChild-Storage-Key: SECRET"
```
