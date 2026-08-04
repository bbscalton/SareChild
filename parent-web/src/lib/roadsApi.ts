// Client-side integration with the Cloudflare Worker's Roads API proxy (`POST /roads/snap` —
// see r2-proxy/src/index.ts `snapToRoads()`). The actual Google Maps Roads API key never
// reaches the browser: Roads API has no CORS headers, so a browser-restricted key couldn't call
// it directly from the client even if we wanted to (same reason `googleMaps.ts` uses the JS SDK
// Geocoder instead of the raw Geocoding REST endpoint). Results are cached in-memory per
// path signature so playback scrubbing / live re-renders don't re-call the Worker or burn
// through the Roads API's free quota (5,000 calls/mo).
import type { TrailPoint } from './geo'

export type RoadSnapPoint = { lat: number; lng: number; originalIndex: number | null }

export type RoadSnapResult = {
  /** The (possibly downsampled) points actually sent to Roads API, with original timestamps intact. */
  input: TrailPoint[]
  snapped: RoadSnapPoint[]
}

function workerBaseUrl(): string {
  return (
    (import.meta.env.VITE_R2_MEDIA_PROXY_BASE_URL as string | undefined)?.trim() ||
    'https://sarechild-media-proxy.neuereatec.workers.dev'
  ).replace(/\/$/, '')
}

// Roads API's hard per-request cap. Mirrors the Worker's own defensive downsample so the
// `originalIndex` it returns maps 1:1 back onto `input` below (and therefore onto real
// timestamps) instead of onto some other resampling the Worker did independently.
const ROADS_MAX_POINTS = 100

function downsampleForRoads(points: TrailPoint[], max = ROADS_MAX_POINTS): TrailPoint[] {
  if (points.length <= max) return points
  const step = (points.length - 1) / (max - 1)
  const out: TrailPoint[] = []
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!)
  return out
}

function signature(points: TrailPoint[]): string {
  const first = points[0]!
  const last = points[points.length - 1]!
  return `${points.length}|${first.atMs}|${last.atMs}`
}

const cache = new Map<string, Promise<RoadSnapResult | null>>()

/**
 * Snaps a time-sorted trail to real streets via the Worker's Roads API proxy. Resolves to
 * `null` on any failure (Worker unreachable, key not configured, offline, <2 points) so callers
 * can gracefully fall back to the raw GPS polyline instead of breaking the map.
 */
export function snapTrailToRoads(points: TrailPoint[]): Promise<RoadSnapResult | null> {
  if (points.length < 2) return Promise.resolve(null)
  const key = signature(points)
  const cached = cache.get(key)
  if (cached) return cached

  const input = downsampleForRoads(points)
  const promise = (async (): Promise<RoadSnapResult | null> => {
    try {
      const res = await fetch(`${workerBaseUrl()}/roads/snap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ points: input.map((p) => ({ lat: p.lat, lng: p.lng })) }),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { ok?: boolean; snapped?: RoadSnapPoint[] }
      if (!body.ok || !Array.isArray(body.snapped) || body.snapped.length < 2) return null
      return { input, snapped: body.snapped }
    } catch {
      return null
    }
  })()
  cache.set(key, promise)
  return promise
}
