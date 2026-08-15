# SareChild PC storage (XAMPP)

Local file archive on the Windows PC that already runs Apache (`C:\xampp2`). It is **not** a replacement for Cloudflare R2. Child devices still upload live media to R2 + Firestore.

## Local URLs (this PC only)

- Health: http://127.0.0.1/sarechild-storage/health.json
- HTML: http://127.0.0.1/sarechild-storage/
- Folder: `C:\xampp2\htdocs\sarechild-storage\store`

GitHub Pages TCD is **HTTPS**, so the browser **cannot** fetch these HTTP URLs (mixed content). localhost from Cloud Functions is Google Cloud, not this PC.

## Make TCD see this disk

Public `:80` on the ISP IP is typically blocked by NAT. Use the existing Cloudflare named tunnel (cloudflared is already a Windows service) **or** a dedicated tunnel:

1. Cloudflare Zero Trust → Networks → Tunnels → `net` (or create `sarechild-xampp`).
2. Public hostname, HTTPS, service `http://127.0.0.1:80`, path `/sarechild-storage*`.
3. Set Functions env (gitignored `functions/.env`, then `firebase deploy --only functions`):

```
XAMPP_STORAGE_URL=https://YOUR-HOSTNAME/sarechild-storage
XAMPP_STORAGE_SECRET=<same value as pc-storage/.secret>
```

4. Open TCD Storage → Refresh dump. The **This PC (XAMPP)** card shows drive used/total when Functions can reach the tunnel.

## Clear the local store

In TCD Storage, type `CLEAR-PC-STORE` and click **Clear PC archive**. That calls Cloud Functions, which POST to this PHP API. It deletes files under `store/` only — not R2.

Or from this PC:

```
curl http://127.0.0.1/sarechild-storage/api.php?action=list -H "X-SareChild-Storage-Key: SECRET"
```
