# SareChild VPS operations (107.170.15.179)

DigitalOcean droplet used for **coturn** (WebRTC TURN), **parent-web staging**, optional **build runner**, **ffmpeg media worker**, **backup templates**, and **health monitoring**.

> **Security:** Rotate the DigitalOcean root password after first login, disable password SSH, and use SSH keys only. Never commit `/opt/sarechild/.env`, TURN passwords, or service-account JSON to git.

## First-time bootstrap

From your workstation (with root SSH access):

```bash
scp scripts/vps/bootstrap.sh root@107.170.15.179:/tmp/
ssh root@107.170.15.179 bash /tmp/bootstrap.sh
```

**Windows (PuTTY):** save the root password in gitignored `.vps-root-password` at the repo root, then:

```powershell
.\scripts\vps\run-bootstrap.ps1
```

Optional: store root password locally for automation only (gitignored):

```text
# .vps-root-password  (repo root, already in .gitignore if you add the line below)
```

The script creates `/opt/sarechild/.env` with generated `TURN_USERNAME` / `TURN_PASSWORD`, configures **coturn**, **ufw**, **nginx** staging on **8080**, **ffmpeg**, **OpenJDK 17**, **Node**, **Docker** (optional Uptime Kuma on `127.0.0.1:3001`), and cron health checks.

### Read TURN credentials (on the server only)

```bash
sudo grep -E '^TURN_' /opt/sarechild/.env
```

Use these values in:

| Consumer | Where |
|----------|--------|
| parent-web | `parent-web/.env` → `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` (see `.env.example`) |
| child APK | repo root `local.properties` → `TURN_USERNAME`, `TURN_CREDENTIAL` (gitignored) |

**TURN URL:** `turn:107.170.15.179:3478` (optional TLS: `turns:107.170.15.179:5349` if you add certs to coturn later).

## Firewall ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 22 | TCP | SSH |
| 3478 | UDP/TCP | TURN/STUN |
| 5349 | UDP/TCP | TURN TLS (coturn listens; TLS cert optional) |
| 49152–65535 | UDP | TURN relay |
| 8080 | TCP | nginx staging static site |

## Verify TURN

On the VPS (package `coturn` provides `turnutils_uclient`):

```bash
source /opt/sarechild/.env
turnutils_uclient -v -u "$TURN_USERNAME" -w "$TURN_PASSWORD" 107.170.15.179
```

Expect allocation success and relay candidates.

## Rotate TURN credentials

1. Generate a new password: `openssl rand -base64 24`
2. Update `/etc/turnserver.conf` `user=` line (or re-run bootstrap logic) and `/opt/sarechild/.env`
3. `systemctl restart coturn`
4. Update `local.properties`, parent-web `.env`, rebuild/redeploy apps

## Deploy parent-web staging

**Windows:** `.\scripts\vps\deploy-staging.ps1` (checks `VITE_FIREBASE_API_KEY`, builds, uploads via PuTTY).

```bash
cd parent-web && npm ci && npm run build
rsync -avz --delete dist/ root@107.170.15.179:/opt/sarechild/staging/
```

Open `http://107.170.15.179:8080/`. Set TURN env vars before `npm run build` so live view works on staging.

## APK download mirror

nginx proxies `http://107.170.15.179:8080/downloads/` → Cloudflare Worker R2 proxy (`sarechild-media-proxy.neuereatec.workers.dev/downloads/`).

## GitHub Actions self-hosted runner

1. GitHub → **Settings → Actions → Runners → New self-hosted runner** (Linux).
2. Install on the VPS as a non-root user; label e.g. `sarechild-vps`.
3. Install Android SDK + accept licenses when you add APK workflows.

See `/opt/sarechild/build/README.md` on the server after bootstrap.

## Backups (manual)

1. Install [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) on the VPS.
2. Create a GCS bucket and service account with **Cloud Datastore Import Export Admin**.
3. `export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json`
4. `export FIRESTORE_EXPORT_BUCKET=gs://your-bucket`
5. Run `/opt/sarechild/backup/firestore-export.sh`

Reseller ledger export: template at `/opt/sarechild/backup/reseller-ledger-export.mjs` (implement with `firebase-admin`).

## Monitoring

- Cron: `/opt/sarechild/monitoring/healthcheck.sh` every 5 minutes → `/var/log/sarechild-health.log`
- Optional: Uptime Kuma Docker on `127.0.0.1:3001` (SSH tunnel to configure)

## local.properties (child TURN)

```properties
# gitignored — copy from server /opt/sarechild/.env
TURN_USERNAME=sarechild
TURN_CREDENTIAL=<from server>
```