// Loads the Google Maps JavaScript API once (idempotent). Used both for the
// google.maps.Geocoder (reverse-geocoding — the web-service Geocoding REST
// endpoint doesn't return CORS headers for HTTP-referrer-restricted keys, but
// the JS SDK's Geocoder is explicitly designed to work with them from a
// browser: https://developers.google.com/maps/documentation/javascript/geocoding)
// and for the full interactive map (Live Map control center): Map, Marker,
// Polyline, InfoWindow, Circle, LatLngBounds via the real `@types/google.maps`
// ambient types — the actual `window.google` value only exists once this
// script has loaded, hence the loader + `typeof google` cast below.
const GOOGLE_MAPS_BROWSER_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim()

declare global {
  interface Window {
    google?: typeof google
    gm_authFailure?: () => void
  }
}

export type GoogleMapsLoadFailure =
  | 'missing_key'
  | 'script_network'
  | 'referrer_or_billing'
  | 'bootstrap_timeout'
  | 'bootstrap_error'

let lastLoadFailure: GoogleMapsLoadFailure | null = null

export function getGoogleMapsLoadFailure(): GoogleMapsLoadFailure | null {
  return lastLoadFailure
}

/** User-facing hint for the most recent load failure (null when load succeeded or not attempted). */
export function googleMapsLoadErrorMessage(failure: GoogleMapsLoadFailure | null = lastLoadFailure): string | null {
  switch (failure) {
    case 'missing_key':
      return 'Map preview unavailable — set VITE_GOOGLE_MAPS_API_KEY in parent-web/.env and rebuild.'
    case 'script_network':
      return 'Google Maps script could not be downloaded. Check your network connection and try again.'
    case 'referrer_or_billing':
      return (
        'Google Maps blocked this site — add your URL to the API key HTTP referrer allowlist in Google Cloud Console ' +
        '(APIs & Services → Credentials), confirm billing is enabled, and enable Maps JavaScript API + Geocoding API.'
      )
    case 'bootstrap_timeout':
      return 'Google Maps timed out while initializing. Refresh the page; if it persists, check API key restrictions and billing.'
    case 'bootstrap_error':
      return 'Google Maps failed to initialize. Confirm Maps JavaScript API and Geocoding API are enabled for your key.'
    default:
      return null
  }
}

export function hasGoogleMapsKey(): boolean {
  return !!GOOGLE_MAPS_BROWSER_KEY
}

let loadPromise: Promise<boolean> | null = null
let authFailureFlag = false

function installAuthFailureHook(): void {
  if (authFailureFlag) return
  window.gm_authFailure = () => {
    authFailureFlag = true
    lastLoadFailure = 'referrer_or_billing'
  }
}

/** True when legacy constructors (Map, Marker, Geocoder, …) are usable. */
export function mapsConstructorsReady(): boolean {
  return typeof window.google?.maps?.Map === 'function'
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('maps bootstrap timeout')), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** After loading=async, constructors are only available once importLibrary finishes. */
async function bootstrapMapsLibraries(): Promise<boolean> {
  if (authFailureFlag) return false
  if (!window.google?.maps?.importLibrary) return mapsConstructorsReady()
  if (mapsConstructorsReady()) return true
  try {
    await withTimeout(window.google.maps.importLibrary('maps'), 20_000)
    return mapsConstructorsReady()
  } catch {
    lastLoadFailure = lastLoadFailure ?? 'bootstrap_error'
    return false
  }
}

/** Resolves true once `window.google.maps.Map` is ready, or false if no key / load failed. */
export function loadGoogleMaps(): Promise<boolean> {
  if (!GOOGLE_MAPS_BROWSER_KEY) {
    lastLoadFailure = 'missing_key'
    return Promise.resolve(false)
  }
  if (mapsConstructorsReady()) {
    lastLoadFailure = null
    return Promise.resolve(true)
  }
  if (loadPromise) return loadPromise

  installAuthFailureHook()
  lastLoadFailure = null

  loadPromise = (async () => {
    const existing = document.getElementById('sarechild-google-maps-script')
    if (!existing) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.id = 'sarechild-google-maps-script'
        script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_BROWSER_KEY}&v=weekly&loading=async`
        script.async = true
        script.defer = true
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('maps script network error'))
        document.head.appendChild(script)
      })
    } else if (!window.google?.maps) {
      await new Promise<void>((resolve, reject) => {
        existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener('error', () => reject(new Error('maps script network error')), { once: true })
      })
    }
    if (authFailureFlag) return false
    const ready = await bootstrapMapsLibraries()
    if (!ready && !lastLoadFailure) {
      lastLoadFailure = authFailureFlag ? 'referrer_or_billing' : 'bootstrap_error'
    }
    if (ready) lastLoadFailure = null
    return ready
  })().catch((err: unknown) => {
    if (!lastLoadFailure) {
      lastLoadFailure =
        err instanceof Error && err.message.includes('timeout') ? 'bootstrap_timeout' : 'script_network'
    }
    return false
  })

  return loadPromise
}

const geocodeCache = new Map<string, string | null>()
const geocodeInFlight = new Map<string, Promise<string | null>>()

/** Reverse-geocodes a lat/lng into a short human address, cached per rounded coordinate. */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null
  const inFlight = geocodeInFlight.get(key)
  if (inFlight) return inFlight

  const promise = (async () => {
    const ready = await loadGoogleMaps()
    if (!ready || !mapsConstructorsReady()) {
      geocodeCache.set(key, null)
      return null
    }
    try {
      const geocoder = new window.google!.maps.Geocoder()
      const response = await geocoder.geocode({ location: { lat, lng } })
      const address = response.results?.[0]?.formatted_address ?? null
      geocodeCache.set(key, address)
      return address
    } catch {
      geocodeCache.set(key, null)
      return null
    } finally {
      geocodeInFlight.delete(key)
    }
  })()
  geocodeInFlight.set(key, promise)
  return promise
}
