# SareChild

Consent-first Android child-safety product (Phase 1 + Phase 2 parent-value features).

Parents approve and pair a child device. The child app stays visible (“Protected by SareChild”) and reports location, SOS, keyword hits, battery, usage, and optional call/SMS **summaries** to the parent via Firebase. Advanced checks are **overt**: Accept UI, banners, and foreground-service notifications.

## Modules

| Module | Application ID | Role |
|--------|----------------|------|
| `marketing/` | GitHub Pages / Vite | Public landing site: pitch, how-it-works, APK downloads, trial CTA |
| `parent/` | `com.sarechild.parent` | Parent/caregiver dashboard (devices, alerts, safety, usage, digests, guardians, geofences, pair) |
| `parent-web/` | Firebase Hosting / Vite | Same data as Android parent |
| `child/` | `com.sarechild.child` | Pairing, consent, monitoring FGS, SOS, safety checks, usage, call/SMS summaries |
| `shared/` | library | Models, keyword matcher, constants |
| `functions/` | Cloud Functions | FCM fan-out (parent + guardians), went-dark, alert purge, **media purge**, **weekly digest**, **trial cleanup** |

## Features

### Core
- Parent email/password auth + family creation (owner guardian record)
- Pairing codes (30-minute expiry)
- Explicit child consent (core + optional advanced)
- Visible monitoring label + FGS notification
- Location heartbeat + map links
- Geofences with optional **day/time schedules**
- SOS → critical alert (snippet includes parent-configured SOS contacts)
- Notification keyword alerts
- Low battery + went-dark
- Tamper / permission-revoked signals
- `isMonitoringTool=child_monitoring`

### Visible advanced monitoring
- Screen share / camera (front or back) / mic checks via commands
- Find-my-child **ring** (full-screen loud alarm)
- Message-screen Accessibility monitor (expanded messaging packages)
- Media viewer in parent UI (images + audio)

### Phase 2 parent value
- App install / uninstall alerts (consent)
- Battery + charging history on device doc
- Screen time (`UsageStats`) + visible app limit overlay
- Call log + SMS **summaries** (consent + Play restricted permissions; not silent recording)
- Multi-guardian invites (owner / caregiver)
- Weekly in-app safety digests + FCM
- Storage media auto-delete after **7 days**

### Nice-to-have enhancements
- **Longer screen share** — parent picks 5–60 minutes per request (not a fixed ~2 min cap)
- **Scheduled screen shares** — recurring prompts at set day/time; child still Accept/Declines each session
- **On-device risk classifier** — leetspeak normalization + pattern heuristics (grooming, self-harm, etc.); alerts include optional `riskScore` (0–100)
- **Visible remote device lock** — full-screen overlay on child device; unlock only via parent command (not stealth)
- **Scheduled app blocking** — block specific apps (e.g., TikTok/WhatsApp/Facebook) during school/bedtime windows with visible enforcement screen
- **Offline evidence continuity** — child records location trail points during outages and uploads them when service returns; optional short visible offline audio clips are captured and uploaded on reconnect
- **Offline SMS fallback** — when no internet is available, child can send throttled emergency location SMS pings to configured SOS contact numbers (with explicit consent and SEND_SMS permission)
- **Offline auto-call fallback** — parent can set a phone number and max attempts per offline session; child can place throttled emergency call attempts when internet is unavailable (with explicit consent and CALL_PHONE permission)
- **Family live chat** — child + parent/guardians can group chat with text, images, and voice notes; chat includes simple online indicators and stays within each family
- **Unidentified WhatsApp contact alerts** — parent-managed safe contact list; WhatsApp contacts not on the safe list trigger alerts with risk scoring from visible message previews/on-screen text

### Call recording (native Android — parent-web sidebar: Communication → Call recording)
SareChild is **not a Cordova app**. Cordova plugins such as `cordova-plugin-callrecorder` (VoIP) and `cordova-plugin-callrecorder-cellular` **do not apply**. Call recording uses native Kotlin:

| Type | What we capture | Limits |
|------|-----------------|--------|
| **Cellular** | `MediaRecorder` + `TelephonyManager` phone-state callbacks | Android 10+ often blocks full uplink+downlink; we try `VOICE_COMMUNICATION` / `MIC` and still log call events when audio fails |
| **VoIP partial** | Mic-side recording while WhatsApp/Telegram/Zoom/etc. call notification is active | Not full two-way VoIP — remote party audio is not reliably capturable on stock Android |
| **Missed** | Ring → idle without answer | Event only, no audio |

Child flow: parent sends **Request call recording** → child sees Accept screen with **30s countdown auto-allow** (same pattern as screen share / WhatsApp protection) → grants mic, phone-state, and notification access.

Firestore: `families/{familyId}/callRecordings` (audio URLs via R2 media proxy, same as other media).

### Explicitly not included
- **Silent / hidden** call recording (all recording requires child consent + visible Accept flow)
- Hidden ambient mic or camera
- Full WhatsApp / Telegram encrypted DB dumps
- Hidden app icon / stealth mode
- Keylogging
- Paid email/SMS gateways (digests are in-app + FCM only)

## Play / policy notes

- Ship as **parental control with disclosure**, never “secret tracker.”
- `READ_CALL_LOG` / `READ_SMS` / `PACKAGE_USAGE_STATS` / Accessibility / MediaProjection increase review risk — declare monitoring tool + restricted permissions; **sideload may be required** if Play rejects the combo.
- Child must consent; call/SMS sync shows an ongoing “Call & SMS monitoring on” notification.

## Media retention

Storage path: `families/{familyId}/devices/{deviceId}/...`  
Retention: **7 days** (`purgeExpiredMedia`). Alerts: **30 days** (`purgeExpiredAlerts`).

## Public sites

| Site | URL | Hosting | Source |
|------|-----|---------|--------|
| Marketing / landing | `https://bbscalton.github.io/SareChild/` | GitHub Pages | `marketing/` |
| Parent web app (dashboard/login) | `https://safechild-f34ac.web.app/` | Firebase Hosting | `parent-web/` |

The marketing site is the public front door — it explains the product, links to the parent dashboard, and hosts the two APK download buttons. The parent dashboard used to live on GitHub Pages; it now lives on Firebase Hosting so GitHub Pages can serve the marketing site at the repo root without clobbering it. See `.github/workflows/deploy-marketing-pages.yml` and `.github/workflows/deploy-parent-web-firebase.yml`.

## Free trial, paid access & auto-cleanup

Every signup gets a **30-day free trial with full features**, tracked on `parentProfiles/{uid}`:

```
plan: "trial" | "paid"
status: "active" | "at_risk" | "purged" | "blocked"
trialStartedAt, trialEndsAt     // trialEndsAt = trialStartedAt + 30 days
paidUntilMs                     // set by reseller activation or voucher redeem; stacks on renew
subscriptionSource              // "reseller" | "voucher" | "tcd"
lastLoginAt                     // updated (throttled) on parent-web / Android sign-in and app open
lastParentCheckInAt             // updated (throttled) when a parent views devices/alerts
```

**Paid access (reseller program):** TCD activates partners on the **Resellers** tab and tops up **credit-days** (1 credit = 1 day). Resellers use https://bbscalton.github.io/SareChild/reseller.html to look up a parent email, activate 15/30/90 days, or mint expiring vouchers. Parents redeem vouchers on the expired-access screen (web + Android). Retail defaults: 15d G$2,200 · 30d G$4,000 · 90d G$10,800 (USD/XCD shown for display).

**Purge rule** (run daily by `purgeInactiveTrials`):
1. Accounts with an **active paid window** (`plan == paid` and `paidUntilMs > now`) are never purged.
2. Trial accounts past `trialEndsAt` are purged.
3. Trial accounts that go **7+ days with no parent check-in** are marked `at_risk`; after a grace window they may be purged.
4. `expirePaidSubscriptions` (daily) flips expired paid profiles back to trial with `trialEndsAt = paidUntilMs` so the client shows the redeem screen.

Parent apps gate the UI with `TrialInfo` — expired users can redeem a voucher instead of only seeing a dead-end.

## Prerequisites

- Android Studio (AGP 8.13 / JDK 11+)
- Firebase: Auth (Email/Password + Anonymous), Firestore, Storage, Cloud Messaging
- Node 20+ for Functions
- Optional Maps API key in `gradle.properties`

## Firebase setup

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage
cd functions && npm install && npm run build && firebase deploy --only functions
cd parent-web && npm install && npm run build && cd .. && firebase deploy --only hosting
```

## Cloudflare R2 media overflow (enabled)

- Media proxy Worker: `https://sarechild-media-proxy.neuereatec.workers.dev`
- R2 bucket: `luscsl-uploads`
- Android uploads now try Cloudflare R2 first, then fall back to Firebase Storage if R2 is unreachable.

**Public APK downloads** are served from the same Worker at `GET /downloads/parent.apk` and `GET /downloads/child.apk`, backed by R2 objects at `downloads/parent.apk` / `downloads/child.apk` in the `luscsl-uploads` bucket. Use `scripts/upload-apks.ps1` (never upload release-unsigned). Manual upload/update:

```bash
# Debug builds (historical default for direct sideload):
./gradlew :parent:assembleDebug :child:assembleDebug
npx wrangler r2 object put luscsl-uploads/downloads/parent.apk --file parent/build/outputs/apk/debug/parent-debug.apk --remote
npx wrangler r2 object put luscsl-uploads/downloads/child.apk --file child/build/outputs/apk/debug/child-debug.apk --remote

# Release builds (when a release keystore is configured):
npx wrangler r2 object put luscsl-uploads/downloads/parent.apk --file parent/build/outputs/apk/release/parent-release.apk --remote
npx wrangler r2 object put luscsl-uploads/downloads/child.apk --file child/build/outputs/apk/release/child-release.apk --remote
```

The marketing site's download buttons (`marketing/src/config.ts`) point at those two Worker URLs; flip `APKS_ARE_RELEASE_SIGNED` there once you're uploading release-signed (not debug) builds.

**Media purge secret (required for remove-device R2 cleanup)** — `deletePairedDevice` skips R2/edge cache deletion unless both sides share the same bearer token:

```bash
# 1) Worker (sarechild-media-proxy)
cd r2-proxy
npx wrangler secret put MEDIA_PURGE_SECRET --name sarechild-media-proxy

# 2) Cloud Functions — copy functions/.env.example → functions/.env, paste the same value as R2_MEDIA_PURGE_SECRET, then:
cd ../functions && firebase deploy --only functions
```

Smoke-test (safe — uses a non-existent prefix): `DELETE /prefix/families/test/devices/none/` with `Authorization: Bearer <secret>` should return `{ ok: true, deleted: 0 }`; without auth → 401.

Deploy/update the proxy Worker:

```bash
cd r2-proxy
npx wrangler deploy
```

**Roads API snap-to-roads proxy** — `POST /roads/snap` on the same Worker (`r2-proxy/src/index.ts`) proxies `roads.googleapis.com/v1/snapToRoads` for the parent-web Live Map (`parent-web/src/lib/roadsApi.ts`). This exists because Roads API has no CORS headers, so the browser can never call it directly — the Worker holds the actual (server-key, IP-restricted, no HTTP-referrer) Roads API key so the browser-restricted key in `VITE_GOOGLE_MAPS_API_KEY` never needs Roads API access. Set it once with:

```bash
npx wrangler secret put GOOGLE_ROADS_SERVER_KEY --name sarechild-media-proxy
```

Seed `keywordLists/default` from [`keywordLists.default.json`](keywordLists.default.json).

## Google Cloud / Maps Platform APIs

Project: `safechild-f34ac` · Billing: linked, Always-Free/free-tier friendly usage only. Manage in [Google Cloud Console → APIs & Services](https://console.cloud.google.com/apis/dashboard?project=safechild-f34ac) and [Credentials](https://console.cloud.google.com/apis/credentials?project=safechild-f34ac).

**Enabled APIs** (all restricted, low-volume, well under free monthly caps for this app's traffic):

| API | Used for | Free tier (as of Mar 2025 pricing) |
|-----|----------|-------------------------------------|
| Maps SDK for Android (`maps-android-backend`) | Parent `DeviceMapActivity` map view | Unlimited free |
| Geocoding API (`geocoding-backend`) | Reverse-geocode last known lat/lng → human address on the parent map | 10,000 req/mo free |
| Places API — Nearby Search (`places-backend`) | "near <place>" context label on the parent map | 5,000 req/mo free |
| Roads API (`roads.googleapis.com`) | Snap the raw GPS trail to actual roads for a cleaner, more accurate polyline — called by parent **Android** `DeviceMapActivity` directly, and by parent-**web**'s Live Map via the Cloudflare Worker proxy (`/roads/snap`, since Roads API has no CORS support) | 5,000 req/mo free |
| Static Maps API (`static-maps-backend`) | Small location thumbnail on parent-web device cards | 10,000 req/mo free |
| Maps JavaScript API / Embed (`maps-backend`, `maps-embed-backend`) | Reserved for future parent-web embedded map | Unlimited free (Embed) |

Not enabled (documented as future candidates only, not wired — avoid unused paid APIs): Vision API / ML Kit (no photo-classification feature yet), Speech-to-Text and Cloud Translation (chat voice notes are stored as raw audio; no transcription/translation pipeline yet), Distance Matrix / Routes (no travel-time or proximity-to-geofence feature yet).


**VPS (coturn / staging):** See [docs/VPS_OPS.md](docs/VPS_OPS.md) for DigitalOcean setup, TURN credential rotation, and staging deploy.
**API keys** (all restricted; never commit key values — they live in `local.properties` / `parent-web/.env`, both gitignored):

| Key | Restriction | apiTargets |
|-----|-------------|------------|
| SareChild Parent Maps (Android) | Android app `com.sarechild.parent` + debug SHA-1 | Maps SDK, Geocoding, Places, Roads, Static Maps |
| SareChild Parent Web Maps (Browser) | HTTP referrer (GitHub Pages + localhost) | Maps JS, Geocoding, Places, Static Maps |
| SareChild Roads Server Key | Unrestricted/IP-restricted server key, stored only as the `GOOGLE_ROADS_SERVER_KEY` Worker secret (never shipped to a browser or app) | Roads only |
| Firebase auto Android/Browser keys | Firebase APIs only | unchanged — do not repurpose |

The child app intentionally has **no** Maps API key — it only reports GPS coordinates; it never renders a map or calls Places/Geocoding.

If you rotate the debug keystore or add a release signing key, add its SHA-1 to the Android key's allowed applications in Cloud Console (or via `gcloud services api-keys update`) or Maps/Geocoding/Places/Roads calls from that build will start failing with `REQUEST_DENIED`.

## Cloudflare edge scale layer (D1 + KV + R2)

SareChild uses Cloudflare as a global load-balanced edge for speed and redundancy:

| Layer | Role |
|-------|------|
| Cloudflare Worker | Global edge API (auto multi-PoP load balancing) |
| Cloudflare D1 (`sarechild-ops`) | Ops DB for fleet snapshots, heartbeats, health history |
| Cloudflare KV | Ultra-fast latest fleet cache per family |
| Cloudflare R2 | Media storage overflow |
| Firebase Firestore | Source of truth for auth, alerts, commands, family data |

Flow:
1. Child heartbeats write to Firebase **and** Cloudflare edge (`/edge/sync/device`).
2. Parent/TCD reads fleet from Cloudflare KV/D1 first (fast), falls back to Firebase, then refreshes edge cache.
3. `/platform-health` monitors Worker + R2 + D1 + KV + Firebase reachability.

Useful endpoints:
- `GET /platform-health`
- `GET /edge/fleet/{familyId}`
- `POST /edge/sync/fleet`
- `POST /edge/sync/device`
- `GET /edge/health/history`

- Parent web now includes a `TCD Ops` tab with one-click:
  - live health checks (Firestore, child heartbeat freshness, alerts stream, Cloudflare R2 proxy),
  - auto-repair actions (seed defaults, reconcile stale online flags).
- Standalone TCD app page: `/SareChild/tcd.html` (separate operator-focused monitor surface).
- Backend health endpoint: Cloudflare Worker `/platform-health` (Blaze-free replacement for Firebase `platformHealth`).
- Optional Firebase scheduled jobs (`autoRepairData`, went-dark, digests) still require Blaze if you want server-side cron; TCD auto-repair works from the web console without Blaze.

### GitHub Pages hosting for TCD

This repo includes:
- `.github/workflows/deploy-marketing-pages.yml` — builds `marketing/` and deploys it to GitHub Pages at the repo root
- `.github/workflows/deploy-parent-web-firebase.yml` — builds `parent-web/` and deploys it to Firebase Hosting (needs a `FIREBASE_SERVICE_ACCOUNT_SAFECHILD_F34AC` secret; until that's added, deploy manually with `firebase deploy --only hosting`)
- `.github/workflows/tcd-health-monitor.yml` for 15-minute synthetic checks
- `scripts/tcd/health-check.mjs` probe script used by Actions

Set these GitHub repository secrets before enabling workflows:
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID`
- `VITE_R2_MEDIA_PROXY_BASE_URL`
- `VITE_PLATFORM_HEALTH_URL` (optional; defaults to R2 proxy `/platform-health`)
- `VITE_GOOGLE_MAPS_API_KEY` (optional; browser-restricted key, enables the Static Maps thumbnail + reverse-geocoded address line on device cards. Requires "Maps Static API", "Maps JavaScript API", and "Geocoding API" enabled for the key — see "Google Cloud / Maps Platform APIs" below)
- `TCD_PARENT_WEB_URL`
- `TCD_R2_HEALTH_URL`
- `TCD_PLATFORM_HEALTH_URL`

`TCD_PLATFORM_HEALTH_URL` should point to `https://sarechild-media-proxy.neuereatec.workers.dev/platform-health`.

## Build & run

```bash
.\gradlew.bat :shared:test :parent:assembleDebug :child:assembleDebug
```

Parent web: `cd parent-web && npm run dev`

### Happy path

1. Parent signs up → Pair → create code  
2. Child: code → consent (optional advanced) → permissions → Start protection  
3. Parent Safety: ring / camera / screen / sync call-SMS  
4. Parent Usage / Digests / Guardians / SOS contacts as needed  

## Security notes

- Firestore: family guardians (owner + caregivers) read family data; child anonymous `authUid` on device writes telemetry.
- Only short SMS snippets and masked numbers — not full archives.
- Caregiver invite codes live in top-level `guardianInvites`.
