// Pure geometry/analytics helpers for the Live Map control center: distance
// math, "stayed in one place" stop detection, and route summary stats. All
// client-side and dependency-free (no @turf/turf) since the inputs are at
// most a few thousand points per playback window.

export type TrailPoint = {
  lat: number
  lng: number
  atMs: number
}

export type Stop = {
  lat: number
  lng: number
  startMs: number
  endMs: number
  durationMs: number
  sampleCount: number
}

const EARTH_RADIUS_M = 6_371_000

/** Great-circle distance between two points in meters. */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export type StopDetectionOptions = {
  /** Points within this radius of a cluster's running centroid count as "still there". Default 70m — wider than typical smartphone GPS jitter (10-30m) but tight enough to separate a home stop from a walk to the corner store. */
  radiusM?: number
  /** Minimum dwell time for a cluster to count as a stop. Default 5 minutes. */
  minDurationMs?: number
}

/**
 * Clusters consecutive trail points (must already be sorted ascending by
 * `atMs`) into "stops" — places the device stayed within `radiusM` of a
 * running centroid for at least `minDurationMs`. Single-pass, O(n).
 */
export function detectStops(points: TrailPoint[], opts: StopDetectionOptions = {}): Stop[] {
  const radiusM = opts.radiusM ?? 70
  const minDurationMs = opts.minDurationMs ?? 5 * 60_000
  const stops: Stop[] = []
  if (points.length === 0) return stops

  let cluster: TrailPoint[] = [points[0]!]
  let centroidLat = points[0]!.lat
  let centroidLng = points[0]!.lng

  const finalizeCluster = () => {
    if (cluster.length === 0) return
    const startMs = cluster[0]!.atMs
    const endMs = cluster[cluster.length - 1]!.atMs
    const durationMs = endMs - startMs
    if (durationMs >= minDurationMs) {
      stops.push({
        lat: centroidLat,
        lng: centroidLng,
        startMs,
        endMs,
        durationMs,
        sampleCount: cluster.length,
      })
    }
  }

  for (let i = 1; i < points.length; i++) {
    const point = points[i]!
    const dist = haversineMeters({ lat: centroidLat, lng: centroidLng }, point)
    if (dist <= radiusM) {
      cluster.push(point)
      // Running average keeps the centroid stable against GPS jitter without
      // needing to store/recompute over the whole cluster each step.
      const n = cluster.length
      centroidLat = centroidLat + (point.lat - centroidLat) / n
      centroidLng = centroidLng + (point.lng - centroidLng) / n
    } else {
      finalizeCluster()
      cluster = [point]
      centroidLat = point.lat
      centroidLng = point.lng
    }
  }
  finalizeCluster()

  return stops
}

export type RouteStats = {
  distanceMeters: number
  durationMs: number
  pointCount: number
  stopCount: number
  avgSpeedKmh: number
}

/** Straight-line (point-to-point) distance/duration summary for a playback window — approximate, not road-snapped. */
export function computeRouteStats(points: TrailPoint[], stops: Stop[]): RouteStats {
  let distanceMeters = 0
  for (let i = 1; i < points.length; i++) {
    distanceMeters += haversineMeters(points[i - 1]!, points[i]!)
  }
  const durationMs = points.length >= 2 ? points[points.length - 1]!.atMs - points[0]!.atMs : 0
  const hours = durationMs / 3_600_000
  const avgSpeedKmh = hours > 0 ? distanceMeters / 1000 / hours : 0
  return {
    distanceMeters,
    durationMs,
    pointCount: points.length,
    stopCount: stops.length,
    avgSpeedKmh,
  }
}

/** Formats meters as "450 m" or "3.2 km". */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}

/** Formats a duration in ms as "2h 14m", "14m", or "38s". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 1) return `${Math.round(ms / 1000)}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

/** Initial compass bearing (degrees, 0-360) from point `a` to point `b` — used to orient the
 *  live/playback marker's heading arrow when the device didn't report a GPS bearing fix. */
export function computeBearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const toDeg = (rad: number) => (rad * 180) / Math.PI
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/**
 * Re-attaches timestamps to a Roads-API-snapped path (see `lib/roadsApi.ts`). Snapped points
 * with a known `originalIndex` take the exact timestamp of that input trail point; Google's own
 * in-between interpolated points (added for `interpolate=true`, no `originalIndex`) get a
 * timestamp linearly interpolated by cumulative along-path distance between the nearest
 * preceding/following "anchor" points — so a playback marker moving along the snapped road
 * geometry stays in sync with the real recorded times instead of drifting or jumping.
 */
export function attachTimestampsToSnappedPath(
  input: TrailPoint[],
  snapped: Array<{ lat: number; lng: number; originalIndex: number | null }>,
): TrailPoint[] {
  if (snapped.length === 0) return []
  const cumDist: number[] = [0]
  for (let i = 1; i < snapped.length; i++) {
    cumDist.push(cumDist[i - 1]! + haversineMeters(snapped[i - 1]!, snapped[i]!))
  }
  const anchors: Array<{ i: number; atMs: number }> = []
  snapped.forEach((sp, i) => {
    const orig = sp.originalIndex != null ? input[sp.originalIndex] : undefined
    if (orig) anchors.push({ i, atMs: orig.atMs })
  })
  if (anchors.length === 0) {
    const fallbackAtMs = input[0]?.atMs ?? 0
    return snapped.map((sp) => ({ lat: sp.lat, lng: sp.lng, atMs: fallbackAtMs }))
  }

  return snapped.map((sp, i) => {
    let prev = anchors[0]!
    let next = anchors[anchors.length - 1]!
    for (const anchor of anchors) {
      if (anchor.i <= i) prev = anchor
      if (anchor.i >= i) {
        next = anchor
        break
      }
    }
    let atMs: number
    if (prev.i === next.i) {
      atMs = prev.atMs
    } else {
      const span = cumDist[next.i]! - cumDist[prev.i]!
      const frac = span > 0 ? (cumDist[i]! - cumDist[prev.i]!) / span : 0
      atMs = prev.atMs + (next.atMs - prev.atMs) * frac
    }
    return { lat: sp.lat, lng: sp.lng, atMs }
  })
}

/**
 * Interpolates a position along a time-sorted point list at time `atMs`,
 * for a smooth playback marker between two recorded samples instead of it
 * visibly "teleporting" from fix to fix.
 */
export function interpolatePosition(
  points: TrailPoint[],
  atMs: number,
): { lat: number; lng: number } | null {
  if (points.length === 0) return null
  if (atMs <= points[0]!.atMs) return { lat: points[0]!.lat, lng: points[0]!.lng }
  const last = points[points.length - 1]!
  if (atMs >= last.atMs) return { lat: last.lat, lng: last.lng }

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!
    const next = points[i]!
    if (atMs <= next.atMs) {
      const span = next.atMs - prev.atMs
      const frac = span > 0 ? (atMs - prev.atMs) / span : 0
      return {
        lat: prev.lat + (next.lat - prev.lat) * frac,
        lng: prev.lng + (next.lng - prev.lng) * frac,
      }
    }
  }
  return { lat: last.lat, lng: last.lng }
}
