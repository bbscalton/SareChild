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
  }
}

export function hasGoogleMapsKey(): boolean {
  return !!GOOGLE_MAPS_BROWSER_KEY
}

let loadPromise: Promise<boolean> | null = null

/** Resolves true once `window.google.maps` is ready, or false if no key is configured / load failed. */
export function loadGoogleMaps(): Promise<boolean> {
  if (!GOOGLE_MAPS_BROWSER_KEY) return Promise.resolve(false)
  if (window.google?.maps) return Promise.resolve(true)
  if (loadPromise) return loadPromise

  loadPromise = new Promise<boolean>((resolve) => {
    const existing = document.getElementById('sarechild-google-maps-script')
    if (existing) {
      existing.addEventListener('load', () => resolve(true))
      existing.addEventListener('error', () => resolve(false))
      return
    }
    const script = document.createElement('script')
    script.id = 'sarechild-google-maps-script'
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_BROWSER_KEY}&v=weekly&loading=async&libraries=geometry`
    script.async = true
    script.defer = true
    script.onload = () => resolve(true)
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
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
    if (!ready || !window.google?.maps) {
      geocodeCache.set(key, null)
      return null
    }
    try {
      const geocoder = new window.google.maps.Geocoder()
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
