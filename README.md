# SareChild

Consent-first Android child-safety product (Phase 1 + Phase 2 parent-value features).

Parents approve and pair a child device. The child app stays visible (“Protected by SareChild”) and reports location, SOS, keyword hits, battery, usage, and optional call/SMS **summaries** to the parent via Firebase. Advanced checks are **overt**: Accept UI, banners, and foreground-service notifications.

## Modules

| Module | Application ID | Role |
|--------|----------------|------|
| `parent/` | `com.sarechild.parent` | Parent/caregiver dashboard (devices, alerts, safety, usage, digests, guardians, geofences, pair) |
| `parent-web/` | Firebase Hosting / Vite | Same data as Android parent |
| `child/` | `com.sarechild.child` | Pairing, consent, monitoring FGS, SOS, safety checks, usage, call/SMS summaries |
| `shared/` | library | Models, keyword matcher, constants |
| `functions/` | Cloud Functions | FCM fan-out (parent + guardians), went-dark, alert purge, **media purge**, **weekly digest** |

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

### Explicitly not included
- Silent / background call recording
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

Deploy/update the proxy Worker:

```bash
cd r2-proxy
npx wrangler deploy
```

Seed `keywordLists/default` from [`keywordLists.default.json`](keywordLists.default.json).

## TCD (Technical Control Dashboard)

- Parent web now includes a `TCD Ops` tab with one-click:
  - live health checks (Firestore, child heartbeat freshness, alerts stream, Cloudflare R2 proxy),
  - auto-repair actions (seed defaults, reconcile stale online flags).
- Standalone TCD app page: `/SareChild/tcd.html` (separate operator-focused monitor surface).
- Backend health endpoint: Cloudflare Worker `/platform-health` (Blaze-free replacement for Firebase `platformHealth`).
- Optional Firebase scheduled jobs (`autoRepairData`, went-dark, digests) still require Blaze if you want server-side cron; TCD auto-repair works from the web console without Blaze.

### GitHub Pages hosting for TCD

This repo includes:
- `.github/workflows/deploy-parent-web-pages.yml` for Pages deployment
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
