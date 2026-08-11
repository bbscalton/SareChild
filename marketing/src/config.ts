// Central place for every outbound link on the marketing site. Keeping these here
// (rather than scattered through JSX) makes it a one-line change when the R2 download
// paths or the parent-web hosting URL change.

export const PARENT_WEB_URL = 'https://safechild-f34ac.web.app/'
export const R2_MEDIA_PROXY_BASE_URL = 'https://sarechild-media-proxy.neuereatec.workers.dev'
export const PARENT_APK_URL = `${R2_MEDIA_PROXY_BASE_URL}/downloads/parent.apk?v=9`
export const CHILD_APK_URL = `${R2_MEDIA_PROXY_BASE_URL}/downloads/child.apk?v=9`
export const GITHUB_REPO_URL = 'https://github.com/bbscalton/SareChild'

// Flip to true once release-signed (not debug) APKs are uploaded to R2, so the
// download section can stop showing the "preview / trial build" disclosure.
export const APKS_ARE_RELEASE_SIGNED = false
