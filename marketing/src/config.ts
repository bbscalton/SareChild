// Central place for every outbound link on the marketing site. Keeping these here
// (rather than scattered through JSX) makes it a one-line change when the R2 download
// paths or the parent-web hosting URL change.

export const PARENT_WEB_URL = 'https://safechild-f34ac.web.app/'
export const R2_MEDIA_PROXY_BASE_URL = 'https://sarechild-media-proxy.neuereatec.workers.dev'
/** Bump when uploading new APKs to R2 so browsers/CDN pick up the new file. */
export const APK_CACHE_BUST = 13
/** Display versions — keep in sync with parent/child `versionName` in build.gradle.kts. */
export const PARENT_APK_VERSION = '1.2.1'
export const CHILD_APK_VERSION = '1.0.15'
export const PARENT_APK_URL = `${R2_MEDIA_PROXY_BASE_URL}/downloads/parent.apk?v=${APK_CACHE_BUST}`
export const CHILD_APK_URL = `${R2_MEDIA_PROXY_BASE_URL}/downloads/child.apk?v=${APK_CACHE_BUST}`
export const GITHUB_REPO_URL = 'https://github.com/bbscalton/SareChild'
export const TERMS_URL = 'https://safechild-f34ac.web.app/terms'
export const PRIVACY_URL = 'https://safechild-f34ac.web.app/privacy'
export const RESELLER_PORTAL_URL = './reseller.html'

// Flip to true once release-signed (not debug) APKs are uploaded to R2, so the
// download section can stop showing the "preview / trial build" disclosure.
export const APKS_ARE_RELEASE_SIGNED = false

/** Honest trial vs paid rows — mirrors parent-web PLAN_COMPARISON_ROWS. */
export const PLAN_COMPARISON_ROWS = [
  { area: 'Child devices', trial: '1', paid: 'Up to 3' },
  { area: 'Live view check-ins', trial: '10/day week 1, then 6/day', paid: '25/day' },
  { area: 'Location history', trial: '24 hours', paid: '30 days' },
  { area: 'Map playback', trial: 'Today only', paid: 'Full retention window' },
  { area: 'Screen/camera snapshots', trial: 'Every 5s, keep 24h', paid: 'Every 5s, keep 7 days' },
  { area: 'Geofences', trial: '2 (home + school)', paid: 'Unlimited' },
  { area: 'WhatsApp / typing alerts', trial: 'On — 7-day history', paid: 'Full retention' },
  { area: 'Exports / digests', trial: 'Light trial watermark', paid: 'No watermark' },
  { area: 'SOS, last location, geofence alerts', trial: 'Always on', paid: 'Always on' },
] as const
