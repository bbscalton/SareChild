import { useEffect, useMemo, useRef, useState } from 'react'
import * as repo from '../lib/parentRepo'
import { hasGoogleMapsKey, loadGoogleMaps, reverseGeocode } from '../lib/googleMaps'
import { snapTrailToRoads } from '../lib/roadsApi'
import {
  attachTimestampsToSnappedPath,
  computeBearing,
  computeRouteStats,
  detectStops,
  formatDistance,
  formatDuration,
  haversineMeters,
  interpolatePosition,
  type Stop,
  type TrailPoint,
} from '../lib/geo'
import { alertCategoryLabel, alertIcon, relativeTime, severityTone } from '../lib/alertPresentation'
import { WENT_DARK_AFTER_MS } from '../firebase'
import type {
  DeviceStatus,
  FamilyAlert,
  GeofenceZone,
  LocationTrailSample,
  MapPlace,
  PlaceKind,
} from '../types'

type Mode = 'live' | 'playback'
type RangeOption = 'today' | '24h' | '7d' | 'custom'
type SeverityGroup = 'critical' | 'medium' | 'low'
type MapTypeOption = 'roadmap' | 'satellite' | 'hybrid' | 'terrain'

const MAP_TYPE_STORAGE_KEY = 'sarechild.livemap.mapType'
const MAP_TYPE_META: Record<MapTypeOption, { label: string; glyph: string }> = {
  roadmap: { label: 'Road', glyph: '🗺️' },
  satellite: { label: 'Satellite', glyph: '🛰️' },
  hybrid: { label: 'Hybrid', glyph: '🌍' },
  terrain: { label: 'Terrain', glyph: '⛰️' },
}

function loadStoredMapType(): MapTypeOption {
  if (typeof window === 'undefined') return 'hybrid'
  const stored = window.localStorage.getItem(MAP_TYPE_STORAGE_KEY)
  if (stored === 'roadmap' || stored === 'satellite' || stored === 'hybrid' || stored === 'terrain') return stored
  return 'hybrid'
}

type Selection =
  | { kind: 'stop'; stop: Stop }
  | { kind: 'alert'; alert: FamilyAlert }
  | { kind: 'place'; place: MapPlace }
  | null

type PlaceDraft = {
  lat: number
  lng: number
  name: string
  placeKind: PlaceKind
  radiusM: number
}

const PLACE_KIND_META: Record<PlaceKind, { glyph: string; color: string; label: string }> = {
  home: { glyph: '🏠', color: '#0f6b4c', label: 'Home' },
  school: { glyph: '🏫', color: '#2c63c9', label: 'School' },
  work: { glyph: '💼', color: '#7a4fc9', label: 'Work' },
  custom: { glyph: '📍', color: '#c9a24a', label: 'Custom' },
}

const SEVERITY_COLOR: Record<SeverityGroup, string> = {
  critical: '#b3261e',
  medium: '#9a6700',
  low: '#0f6b4c',
}

function severityGroup(severity: string): SeverityGroup {
  const tone = severityTone(severity)
  if (tone === 'critical' || tone === 'high') return 'critical'
  if (tone === 'low') return 'low'
  return 'medium'
}

/** Builds a small circular "pin" marker icon as an inline SVG data URI — keeps the map free of extra image assets while giving each overlay type (place/stop/alert/live position) a distinct, readable glyph. */
function pinIcon(color: string, glyph: string, big = false): google.maps.Icon {
  const size = big ? 46 : 38
  const r = size / 2 - 3
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${color}" stroke="#ffffff" stroke-width="3"/>
    <text x="${size / 2}" y="${size / 2 + size * 0.16}" font-size="${size * 0.5}" text-anchor="middle">${glyph}</text>
  </svg>`
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(size / 2, size / 2),
  }
}

/**
 * The child's current-position marker — a filled dot, or (when a heading is known, either from
 * the device's GPS bearing or computed from recent movement) a rotated arrow, so a parent can
 * tell at a glance which way the child is facing/moving instead of just a static pin.
 */
function headingMarkerIcon(color: string, headingDeg: number | null, big = false): google.maps.Icon {
  const size = big ? 44 : 36
  const r = size / 2 - 4
  const arrow =
    headingDeg == null
      ? `<circle cx="${size / 2}" cy="${size / 2}" r="5" fill="#ffffff"/>`
      : `<g transform="rotate(${headingDeg} ${size / 2} ${size / 2})">
           <path d="M ${size / 2} ${size * 0.2} L ${size * 0.68} ${size * 0.64} L ${size / 2} ${size * 0.5} L ${size * 0.32} ${size * 0.64} Z" fill="#ffffff"/>
         </g>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${color}" stroke="#ffffff" stroke-width="3"/>
    ${arrow}
  </svg>`
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(size / 2, size / 2),
  }
}

/** "Live now" / "3s ago" / "2m ago" — second-resolution freshness for the on-map live status
 *  pill (relativeTime() from alertPresentation only has minute resolution, too coarse here). */
function formatFreshness(atMs: number, nowMs: number): string {
  if (!atMs) return 'unknown'
  const diffSec = Math.max(0, Math.round((nowMs - atMs) / 1000))
  if (diffSec < 5) return 'live now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  return relativeTime(atMs)
}

/** A muted, low-saturation map theme so teal/gold overlays stay legible instead of fighting Google's default bright basemap colors. */
const CALM_MAP_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#f3f7f5' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5b6f66' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#cfe3e8' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#eef3f0' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#e4ede7' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#dcebe1' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#fbfdfc' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#d7e3dc' }] },
]

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function rangeToMs(range: RangeOption, customFrom: string, customTo: string): { fromMs: number; toMs: number } {
  const now = Date.now()
  if (range === '24h') return { fromMs: now - 24 * 3_600_000, toMs: now }
  if (range === '7d') return { fromMs: now - 7 * 24 * 3_600_000, toMs: now }
  if (range === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return { fromMs: d.getTime(), toMs: now }
  }
  const fromMs = customFrom ? new Date(customFrom).getTime() : now - 24 * 3_600_000
  const toMs = customTo ? new Date(customTo).getTime() : now
  return { fromMs: Math.min(fromMs, toMs), toMs: Math.max(fromMs, toMs) }
}

function isDeviceOnline(device: DeviceStatus, nowMs: number): boolean {
  return device.lastHeartbeatMs > 0 && nowMs - device.lastHeartbeatMs < WENT_DARK_AFTER_MS
}

type LiveMapPageProps = {
  familyId: string
  devices: DeviceStatus[]
  alerts: FamilyAlert[]
  geofences: GeofenceZone[]
  locationTrail: LocationTrailSample[]
  nowTick: number
}

export function LiveMapPage({ familyId, devices, alerts, geofences, locationTrail, nowTick }: LiveMapPageProps) {
  const [selectedDeviceId, setSelectedDeviceId] = useState(devices[0]?.id ?? '')
  useEffect(() => {
    if (devices.length === 0) return
    if (!devices.some((d) => d.id === selectedDeviceId)) setSelectedDeviceId(devices[0]!.id)
  }, [devices, selectedDeviceId])
  const selectedDevice = devices.find((d) => d.id === selectedDeviceId) ?? null

  const [mode, setMode] = useState<Mode>('live')
  const [range, setRange] = useState<RangeOption>('today')
  const [customFrom, setCustomFrom] = useState(() => toDatetimeLocal(Date.now() - 24 * 3_600_000))
  const [customTo, setCustomTo] = useState(() => toDatetimeLocal(Date.now()))
  const [rangeTrail, setRangeTrail] = useState<LocationTrailSample[]>([])
  const [rangeLoading, setRangeLoading] = useState(false)
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [rangeLoadedFor, setRangeLoadedFor] = useState<string | null>(null)

  const [places, setPlaces] = useState<MapPlace[]>([])
  const [addingPlace, setAddingPlace] = useState(false)
  const [placeDraft, setPlaceDraft] = useState<PlaceDraft | null>(null)
  const [placeBusy, setPlaceBusy] = useState(false)

  const [severityOn, setSeverityOn] = useState<Record<SeverityGroup, boolean>>({
    critical: true,
    medium: true,
    low: true,
  })

  const [selection, setSelection] = useState<Selection>(null)

  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [speedMult, setSpeedMult] = useState(1)

  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!familyId) return
    return repo.observeMapPlaces(familyId, setPlaces, (e) => setError(e.message))
  }, [familyId])

  // Dedicated per-device live trail (in addition to the family-wide `locationTrail` prop, which
  // caps at 300 samples *across every device* — too thin for this device's own trail once a
  // family has more than one or two paired children). Fixes the "live view doesn't clearly show
  // movement" report for multi-device families.
  const [deviceLiveTrail, setDeviceLiveTrail] = useState<LocationTrailSample[]>([])
  useEffect(() => {
    if (!familyId || !selectedDeviceId) {
      setDeviceLiveTrail([])
      return
    }
    return repo.observeLocationTrailForDevice(familyId, selectedDeviceId, setDeviceLiveTrail, (e) =>
      setError(e.message),
    )
  }, [familyId, selectedDeviceId])

  const loadRange = async (opts?: { range?: RangeOption; from?: string; to?: string }) => {
    if (!familyId) return
    const r = opts?.range ?? range
    const from = opts?.from ?? customFrom
    const to = opts?.to ?? customTo
    const { fromMs, toMs } = rangeToMs(r, from, to)
    setRangeLoading(true)
    setRangeError(null)
    try {
      const rows = await repo.fetchLocationTrailRange(familyId, fromMs, toMs)
      setRangeTrail(rows)
      setPlayhead(fromMs)
      setPlaying(false)
      setRangeLoadedFor(`${r}|${from}|${to}`)
    } catch (e) {
      setRangeError(e instanceof Error ? e.message : 'Failed to load location history')
    } finally {
      setRangeLoading(false)
    }
  }

  // Auto-load once the very first time a parent switches into Playback mode
  // (default "Today" window) — after that, loading is an explicit action tied
  // to the "Load history" button so scrubbing dates doesn't spam Firestore.
  useEffect(() => {
    if (mode === 'playback' && rangeLoadedFor === null && !rangeLoading) {
      void loadRange()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const livePoints = useMemo<TrailPoint[]>(() => {
    // Merge the family-wide trail (deduped by doc id) with the dedicated per-device listener —
    // whichever surfaced a given sample first, the union is always at least as complete as
    // either alone.
    const byId = new Map<string, LocationTrailSample>()
    locationTrail.forEach((s) => {
      if (s.deviceId === selectedDeviceId) byId.set(s.id, s)
    })
    deviceLiveTrail.forEach((s) => byId.set(s.id, s))
    const pts = Array.from(byId.values())
      .filter((s) => s.location)
      .map((s) => ({ lat: s.location!.lat, lng: s.location!.lng, atMs: s.recordedAtMs }))
      .sort((a, b) => a.atMs - b.atMs)
    const last = selectedDevice?.lastLocation
    if (last) {
      const lastAt = last.updatedAtMs ?? selectedDevice?.lastHeartbeatMs ?? 0
      const prevAt = pts.length ? pts[pts.length - 1]!.atMs : 0
      if (lastAt && lastAt - prevAt > 5_000) {
        pts.push({ lat: last.lat, lng: last.lng, atMs: lastAt })
      }
    }
    return pts
  }, [locationTrail, deviceLiveTrail, selectedDeviceId, selectedDevice])

  const playbackPoints = useMemo<TrailPoint[]>(() => {
    return rangeTrail
      .filter((s) => s.deviceId === selectedDeviceId && s.location)
      .map((s) => ({ lat: s.location!.lat, lng: s.location!.lng, atMs: s.recordedAtMs }))
      .sort((a, b) => a.atMs - b.atMs)
  }, [rangeTrail, selectedDeviceId])

  const devicePoints = mode === 'live' ? livePoints : playbackPoints
  const stops = useMemo(() => detectStops(devicePoints), [devicePoints])
  const routeStats = useMemo(() => computeRouteStats(devicePoints, stops), [devicePoints, stops])

  // Road-accurate path: snaps the raw GPS trail to real streets via the Roads API (through the
  // Cloudflare Worker proxy — see lib/roadsApi.ts) so the polyline/marker follow actual road
  // geometry instead of cutting through blocks. Cleared only on device/mode/range switches (not
  // on every incremental point) so the map doesn't flash back to the raw path while re-snapping
  // for a newly-arrived live point; falls back to the raw `devicePoints` on any failure.
  const [snappedPath, setSnappedPath] = useState<TrailPoint[] | null>(null)
  useEffect(() => {
    setSnappedPath(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId, mode, range])
  useEffect(() => {
    if (devicePoints.length < 2) return
    let cancelled = false
    void snapTrailToRoads(devicePoints).then((result) => {
      if (cancelled || !result) return
      setSnappedPath(attachTimestampsToSnappedPath(result.input, result.snapped))
    })
    return () => {
      cancelled = true
    }
  }, [devicePoints])
  const renderPath = snappedPath && snappedPath.length >= 2 ? snappedPath : devicePoints
  const isRoadSnapped = renderPath === snappedPath

  const playbackBounds = useMemo(() => {
    if (playbackPoints.length === 0) return null
    return { minMs: playbackPoints[0]!.atMs, maxMs: playbackPoints[playbackPoints.length - 1]!.atMs }
  }, [playbackPoints])

  useEffect(() => {
    if (mode === 'playback' && playbackBounds) setPlayhead(playbackBounds.minMs)
  }, [mode, selectedDeviceId, playbackBounds?.minMs, playbackBounds?.maxMs])

  useEffect(() => {
    if (!playing || mode !== 'playback' || !playbackBounds) return
    const { minMs, maxMs } = playbackBounds
    const span = Math.max(maxMs - minMs, 1)
    const baseSpeed = span / 60_000 // full window plays back in ~60 real seconds at 1x
    let raf = 0
    let last = performance.now()
    const step = (t: number) => {
      const dt = t - last
      last = t
      setPlayhead((prev) => {
        const next = prev + dt * baseSpeed * speedMult
        if (next >= maxMs) {
          setPlaying(false)
          return maxMs
        }
        return next
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, mode, playbackBounds, speedMult])

  const liveOngoingStop = useMemo(() => {
    if (mode !== 'live' || stops.length === 0 || livePoints.length === 0) return null
    const last = stops[stops.length - 1]!
    const lastPoint = livePoints[livePoints.length - 1]!
    return Math.abs(last.endMs - lastPoint.atMs) < 1_000 ? last : null
  }, [mode, stops, livePoints])

  const filteredAlerts = useMemo(() => {
    return alerts.filter((a) => a.deviceId === selectedDeviceId && a.location && severityOn[severityGroup(a.severity)])
  }, [alerts, selectedDeviceId, severityOn])

  // ------------------------------ Map instance ------------------------------
  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const mapObjRef = useRef<google.maps.Map | null>(null)
  const staticOverlaysRef = useRef<Array<google.maps.Marker | google.maps.Circle>>([])
  const dynamicOverlaysRef = useRef<Array<google.maps.Marker | google.maps.Polyline>>([])
  const currentMarkerRef = useRef<google.maps.Marker | null>(null)
  const accuracyCircleRef = useRef<google.maps.Circle | null>(null)
  const markerAnimRef = useRef<{
    raf: number
    from: { lat: number; lng: number }
    to: { lat: number; lng: number }
    startedAtMs: number
  } | null>(null)
  const markerRenderedPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const markerHeadingRef = useRef<number | null>(null)
  const lastPanAtMsRef = useRef(0)
  const lastBoundsRef = useRef<google.maps.LatLngBounds | null>(null)
  const fitKeyRef = useRef<string>('')
  const [mapsReady, setMapsReady] = useState(false)
  const mapsAvailable = hasGoogleMapsKey()
  const [mapType, setMapType] = useState<MapTypeOption>(loadStoredMapType)
  // Camera auto-follows the child's marker on live updates (and while scrubbing playback)
  // until the parent manually drags/zooms the map — a "Follow" button re-enables it and
  // snaps the camera back, rather than fighting the parent's own panning every update.
  const [followMode, setFollowMode] = useState(true)
  const [liveClockMs, setLiveClockMs] = useState(() => Date.now())
  useEffect(() => {
    if (mode !== 'live') return
    const id = window.setInterval(() => setLiveClockMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [mode])

  useEffect(() => {
    let cancelled = false
    void loadGoogleMaps().then((ok) => {
      if (!cancelled) setMapsReady(ok)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!mapsReady || !mapDivRef.current || mapObjRef.current) return
    mapObjRef.current = new google.maps.Map(mapDivRef.current, {
      center: { lat: 20, lng: 0 },
      zoom: 3,
      mapTypeId: mapType,
      disableDefaultUI: false,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: true,
      clickableIcons: false,
      gestureHandling: 'greedy',
      styles: CALM_MAP_STYLE,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapsReady])

  // A manual drag/scroll-zoom means the parent wants to look elsewhere — stop auto-following
  // until they explicitly ask to resume (the "Follow" button).
  useEffect(() => {
    const map = mapObjRef.current
    if (!map || !mapsReady) return
    const listener = map.addListener('dragstart', () => setFollowMode(false))
    return () => listener.remove()
  }, [mapsReady])

  // Keep the live map type in sync with the switcher (and persist the parent's choice).
  useEffect(() => {
    const map = mapObjRef.current
    if (!map || !mapsReady) return
    map.setMapTypeId(mapType)
    try {
      window.localStorage.setItem(MAP_TYPE_STORAGE_KEY, mapType)
    } catch {
      // localStorage may be unavailable (private browsing) — not critical.
    }
  }, [mapType, mapsReady])

  // "Add place" click-to-drop: only listens while the parent has explicitly
  // clicked "+ Add place", so normal map panning/clicking elsewhere is unaffected.
  useEffect(() => {
    const map = mapObjRef.current
    if (!map || !addingPlace) return
    const listener = map.addListener('click', (e: google.maps.MapMouseEvent) => {
      const lat = e.latLng?.lat()
      const lng = e.latLng?.lng()
      if (lat == null || lng == null) return
      setPlaceDraft({ lat, lng, name: '', placeKind: 'custom', radiusM: 100 })
      setAddingPlace(false)
      setSelection(null)
    })
    return () => listener.remove()
  }, [addingPlace, mapsReady])

  // Static overlays: places, geofence circles, stop markers, alert markers, the
  // pending "new place" draft pin. Rebuilt whenever the underlying data
  // changes — NOT on every playback tick (that's the cheaper effect below).
  useEffect(() => {
    const map = mapObjRef.current
    if (!map || !mapsReady) return
    staticOverlaysRef.current.forEach((o) => o.setMap(null))
    staticOverlaysRef.current = []
    const bounds = new google.maps.LatLngBounds()
    let any = false
    const extend = (lat: number, lng: number) => {
      bounds.extend({ lat, lng })
      any = true
    }

    places.forEach((place) => {
      const meta = PLACE_KIND_META[place.kind]
      const marker = new google.maps.Marker({
        position: { lat: place.lat, lng: place.lng },
        map,
        icon: pinIcon(meta.color, meta.glyph),
        title: place.name,
        zIndex: 40,
      })
      marker.addListener('click', () => setSelection({ kind: 'place', place }))
      staticOverlaysRef.current.push(marker)
      extend(place.lat, place.lng)
      if (place.radiusM > 0) {
        const circle = new google.maps.Circle({
          center: { lat: place.lat, lng: place.lng },
          radius: place.radiusM,
          map,
          strokeColor: meta.color,
          strokeOpacity: 0.5,
          strokeWeight: 1.5,
          fillColor: meta.color,
          fillOpacity: 0.08,
          clickable: false,
        })
        staticOverlaysRef.current.push(circle)
      }
    })

    geofences.forEach((zone) => {
      const circle = new google.maps.Circle({
        center: { lat: zone.lat, lng: zone.lng },
        radius: zone.radiusM,
        map,
        strokeColor: zone.active ? '#c9a24a' : '#9aa39d',
        strokeOpacity: 0.7,
        strokeWeight: 2,
        fillColor: '#c9a24a',
        fillOpacity: 0.05,
        clickable: false,
      })
      staticOverlaysRef.current.push(circle)
      extend(zone.lat, zone.lng)
    })

    stops.forEach((stop, idx) => {
      const marker = new google.maps.Marker({
        position: { lat: stop.lat, lng: stop.lng },
        map,
        icon: pinIcon('#0a4f38', '⏱'),
        label: { text: String(idx + 1), color: '#ffffff', fontSize: '11px', fontWeight: '700' },
        zIndex: 60,
      })
      marker.addListener('click', () => setSelection({ kind: 'stop', stop }))
      staticOverlaysRef.current.push(marker)
      extend(stop.lat, stop.lng)
    })

    filteredAlerts.forEach((a) => {
      if (!a.location) return
      const marker = new google.maps.Marker({
        position: { lat: a.location.lat, lng: a.location.lng },
        map,
        icon: pinIcon(SEVERITY_COLOR[severityGroup(a.severity)], alertIcon(a.type)),
        zIndex: 80,
      })
      marker.addListener('click', () => setSelection({ kind: 'alert', alert: a }))
      staticOverlaysRef.current.push(marker)
      extend(a.location.lat, a.location.lng)
    })

    if (placeDraft) {
      const meta = PLACE_KIND_META[placeDraft.placeKind]
      const marker = new google.maps.Marker({
        position: { lat: placeDraft.lat, lng: placeDraft.lng },
        map,
        icon: pinIcon(meta.color, meta.glyph, true),
        draggable: true,
        zIndex: 130,
      })
      marker.addListener('dragend', () => {
        const p = marker.getPosition()
        if (p) setPlaceDraft((d) => (d ? { ...d, lat: p.lat(), lng: p.lng() } : d))
      })
      staticOverlaysRef.current.push(marker)
      extend(placeDraft.lat, placeDraft.lng)
    }

    renderPath.forEach((p) => extend(p.lat, p.lng))

    if (any) {
      lastBoundsRef.current = bounds
      const key = `${selectedDeviceId}|${mode}|${range}|${renderPath.length > 0}`
      if (fitKeyRef.current !== key) {
        fitKeyRef.current = key
        map.fitBounds(bounds, 72)
      }
    }
    // renderPath only used for bounds-extension here; playhead-driven redraws are handled separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, geofences, stops, filteredAlerts, placeDraft, mapsReady, selectedDeviceId, mode, range])

  // Trail polylines: the full route (road-snapped when available) + a brighter "traveled so
  // far" overlay during playback. Kept separate from the marker lifecycle below + cheap so
  // playback scrubbing (which changes `playhead` many times a second) doesn't rebuild the whole
  // overlay set every frame.
  useEffect(() => {
    const map = mapObjRef.current
    if (!map || !mapsReady) return
    dynamicOverlaysRef.current.forEach((o) => o.setMap(null))
    dynamicOverlaysRef.current = []

    if (renderPath.length >= 2) {
      const full = renderPath.map((p) => ({ lat: p.lat, lng: p.lng }))
      const base = new google.maps.Polyline({
        path: full,
        map,
        strokeColor: '#0f6b4c',
        strokeOpacity: mode === 'playback' ? 0.28 : 0.85,
        strokeWeight: 4,
        zIndex: 10,
      })
      dynamicOverlaysRef.current.push(base)
      if (mode === 'playback') {
        const traveled = renderPath.filter((p) => p.atMs <= playhead).map((p) => ({ lat: p.lat, lng: p.lng }))
        if (traveled.length >= 2) {
          const hi = new google.maps.Polyline({
            path: traveled,
            map,
            strokeColor: '#c9a24a',
            strokeOpacity: 0.95,
            strokeWeight: 5,
            zIndex: 11,
          })
          dynamicOverlaysRef.current.push(hi)
        }
      }
    }
  }, [renderPath, mode, playhead, mapsReady])

  // Current-position marker: created once and reused (never destroyed/recreated on every
  // update) so it can be smoothly animated instead of visibly teleporting.
  useEffect(() => {
    const map = mapObjRef.current
    if (!map || !mapsReady || currentMarkerRef.current) return
    currentMarkerRef.current = new google.maps.Marker({
      map,
      zIndex: 200,
      icon: headingMarkerIcon('#0f6b4c', null, true),
    })
    accuracyCircleRef.current = new google.maps.Circle({
      map,
      strokeColor: '#0f6b4c',
      strokeOpacity: 0.3,
      strokeWeight: 1,
      fillColor: '#0f6b4c',
      fillOpacity: 0.1,
      clickable: false,
      radius: 1,
    })
    accuracyCircleRef.current.setVisible(false)
    return () => {
      currentMarkerRef.current?.setMap(null)
      currentMarkerRef.current = null
      accuracyCircleRef.current?.setMap(null)
      accuracyCircleRef.current = null
      if (markerAnimRef.current) cancelAnimationFrame(markerAnimRef.current.raf)
      markerAnimRef.current = null
      markerRenderedPosRef.current = null
      markerHeadingRef.current = null
    }
  }, [mapsReady])

  /** Moves the persistent marker/accuracy-circle to `target`, tweening smoothly in live mode
   *  (where updates arrive in discrete, minutes-apart jumps) and jumping instantly in playback
   *  (where `playhead` itself already advances continuously via requestAnimationFrame). Updates
   *  the heading arrow from the actual displacement so it reflects the rendered (road-snapped)
   *  path direction, and auto-follows the camera when `followMode` is on. */
  const moveMarkerTo = (target: { lat: number; lng: number }, accuracyM: number | null | undefined, animate: boolean) => {
    const marker = currentMarkerRef.current
    if (!marker) return
    const from = markerRenderedPosRef.current ?? target
    const movedM = haversineMeters(from, target)
    if (movedM > 3) {
      markerHeadingRef.current = computeBearing(from, target)
    }
    const color = mode === 'live' ? '#0f6b4c' : '#12241c'
    marker.setIcon(headingMarkerIcon(color, markerHeadingRef.current, true))

    const circle = accuracyCircleRef.current
    if (circle) {
      if (accuracyM && accuracyM > 0 && accuracyM <= 500) {
        circle.setRadius(accuracyM)
        circle.setCenter(target)
        circle.setVisible(true)
      } else {
        circle.setVisible(false)
      }
    }

    if (markerAnimRef.current) cancelAnimationFrame(markerAnimRef.current.raf)
    if (!animate || movedM < 1) {
      marker.setPosition(target)
      circle?.setCenter(target)
      markerRenderedPosRef.current = target
      markerAnimRef.current = null
    } else {
      const anim = { raf: 0, from, to: target, startedAtMs: performance.now() }
      const durationMs = 1200
      const step = () => {
        const t = Math.min(1, (performance.now() - anim.startedAtMs) / durationMs)
        const eased = 1 - (1 - t) * (1 - t) // ease-out
        const lat = anim.from.lat + (anim.to.lat - anim.from.lat) * eased
        const lng = anim.from.lng + (anim.to.lng - anim.from.lng) * eased
        marker.setPosition({ lat, lng })
        circle?.setCenter({ lat, lng })
        markerRenderedPosRef.current = { lat, lng }
        if (t < 1) {
          anim.raf = requestAnimationFrame(step)
        } else {
          markerAnimRef.current = null
        }
      }
      anim.raf = requestAnimationFrame(step)
      markerAnimRef.current = anim
    }

    if (followMode) {
      const map = mapObjRef.current
      const now = performance.now()
      // Throttle pans during playback (playhead ticks ~60x/sec) so the camera glides instead of
      // fighting Google's own pan animation every frame; live updates are infrequent already.
      if (map && (mode === 'live' || now - lastPanAtMsRef.current > 400)) {
        lastPanAtMsRef.current = now
        map.panTo(target)
      }
    }
  }

  // Live mode: move to the latest (possibly road-snapped) point, animated.
  useEffect(() => {
    if (!mapsReady || mode !== 'live') return
    const last = renderPath.length ? renderPath[renderPath.length - 1]! : null
    const target = last ?? selectedDevice?.lastLocation ?? null
    if (!target) return
    moveMarkerTo(target, selectedDevice?.lastLocation?.accuracyM, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapsReady, mode, renderPath, selectedDevice?.lastLocation, followMode])

  // Playback mode: jump to the interpolated position along the (road-snapped) path at `playhead`.
  useEffect(() => {
    if (!mapsReady || mode !== 'playback') return
    const pos = interpolatePosition(renderPath, playhead)
    if (!pos) return
    moveMarkerTo(pos, null, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapsReady, mode, renderPath, playhead, followMode])

  // Reset the tween/heading state on device or mode switches so a stale heading/animation from
  // the previous selection never bleeds into the next one.
  useEffect(() => {
    markerRenderedPosRef.current = null
    markerHeadingRef.current = null
    if (markerAnimRef.current) cancelAnimationFrame(markerAnimRef.current.raf)
    markerAnimRef.current = null
  }, [selectedDeviceId, mode])

  useEffect(
    () => () => {
      staticOverlaysRef.current.forEach((o) => o.setMap(null))
      dynamicOverlaysRef.current.forEach((o) => o.setMap(null))
    },
    [],
  )

  const recenter = () => {
    setFollowMode(true)
    if (lastBoundsRef.current && mapObjRef.current) mapObjRef.current.fitBounds(lastBoundsRef.current, 72)
  }

  const liveFreshnessAtMs = selectedDevice?.lastLocation?.updatedAtMs || selectedDevice?.lastHeartbeatMs || 0
  const liveIsStale = mode === 'live' && (!liveFreshnessAtMs || liveClockMs - liveFreshnessAtMs > WENT_DARK_AFTER_MS)

  const saveNewPlace = async () => {
    if (!placeDraft || !familyId || !placeDraft.name.trim()) return
    setPlaceBusy(true)
    setError(null)
    try {
      await repo.addMapPlace(familyId, {
        name: placeDraft.name.trim(),
        kind: placeDraft.placeKind,
        lat: placeDraft.lat,
        lng: placeDraft.lng,
        radiusM: placeDraft.radiusM,
      })
      setPlaceDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save place')
    } finally {
      setPlaceBusy(false)
    }
  }

  if (devices.length === 0) {
    return (
      <div className="empty">
        <h3>No devices yet</h3>
        <p className="muted">Pair a child device to unlock the Live Map control center.</p>
      </div>
    )
  }

  return (
    <div className="livemap-shell">
      <aside className="livemap-sidebar">
        <div className="livemap-block">
          <p className="nav-group-label">Child</p>
          {devices.length > 1 ? (
            <select value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.childName}
                </option>
              ))}
            </select>
          ) : (
            <p className="livemap-child-name">{selectedDevice?.childName ?? '—'}</p>
          )}
          {selectedDevice && (
            <div className="livemap-live-status">
              <span className={`pill ${isDeviceOnline(selectedDevice, nowTick) ? 'online' : 'offline'}`}>
                {isDeviceOnline(selectedDevice, nowTick) ? 'Online' : 'Offline'}
              </span>
              <span className="muted small">
                🔋 {selectedDevice.batteryPercent >= 0 ? `${selectedDevice.batteryPercent}%` : '—'}
                {selectedDevice.charging ? ' ⚡' : ''}
              </span>
              <span className="muted small">Updated {relativeTime(selectedDevice.lastHeartbeatMs)}</span>
              {liveOngoingStop && (
                <span className="pill sev-low livemap-here-badge">
                  📍 Here for {formatDuration(nowTick - liveOngoingStop.startMs)}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="livemap-block">
          <p className="nav-group-label">View</p>
          <div className="filter-row">
            <button type="button" className={mode === 'live' ? 'chip active' : 'chip'} onClick={() => setMode('live')}>
              🔴 Live
            </button>
            <button
              type="button"
              className={mode === 'playback' ? 'chip active' : 'chip'}
              onClick={() => setMode('playback')}
            >
              ⏵ Playback
            </button>
          </div>

          {mode === 'playback' && (
            <div className="livemap-playback-config">
              <div className="filter-row">
                {(
                  [
                    ['today', 'Today'],
                    ['24h', 'Last 24h'],
                    ['7d', 'Last 7 days'],
                    ['custom', 'Custom'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={range === id ? 'chip active' : 'chip'}
                    onClick={() => setRange(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {range === 'custom' && (
                <div className="stack" style={{ gap: '0.5rem' }}>
                  <label>
                    From
                    <input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                  </label>
                  <label>
                    To
                    <input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                  </label>
                </div>
              )}
              <button
                type="button"
                className="btn primary compact"
                disabled={rangeLoading}
                onClick={() => void loadRange()}
              >
                {rangeLoading ? 'Loading…' : 'Load history'}
              </button>
              {rangeError && <p className="error small">{rangeError}</p>}
              {!rangeLoading && rangeLoadedFor && (
                <p className="muted small">{playbackPoints.length} recorded points in this window.</p>
              )}
            </div>
          )}
        </div>

        <div className="livemap-block livemap-scroll">
          <div className="card-head">
            <p className="nav-group-label" style={{ margin: 0 }}>
              Places
            </p>
            {!addingPlace ? (
              <button
                type="button"
                className="btn ghost compact"
                disabled={!mapsReady}
                onClick={() => {
                  setAddingPlace(true)
                  setPlaceDraft(null)
                }}
              >
                + Add place
              </button>
            ) : (
              <button type="button" className="btn ghost compact" onClick={() => setAddingPlace(false)}>
                Cancel
              </button>
            )}
          </div>
          {addingPlace && <p className="muted small">Click anywhere on the map to drop a pin.</p>}
          {places.length === 0 && !addingPlace && (
            <p className="muted small">No places yet. Mark Home, School, or anywhere else that matters.</p>
          )}
          <div className="livemap-list">
            {places.map((place) => (
              <button
                key={place.id}
                type="button"
                className="mini-alert-row livemap-place-row"
                onClick={() => setSelection({ kind: 'place', place })}
              >
                <span aria-hidden>{PLACE_KIND_META[place.kind].glyph}</span>
                <span className="livemap-row-label">{place.name}</span>
                <span className="muted small">{PLACE_KIND_META[place.kind].label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="livemap-block livemap-scroll">
          <p className="nav-group-label">Alerts on map</p>
          <div className="filter-row">
            {(['critical', 'medium', 'low'] as const).map((g) => (
              <button
                key={g}
                type="button"
                className={severityOn[g] ? 'chip active' : 'chip'}
                onClick={() => setSeverityOn((s) => ({ ...s, [g]: !s[g] }))}
              >
                {g === 'critical' ? 'Critical' : g === 'medium' ? 'Medium' : 'Low'}
              </button>
            ))}
          </div>
          {filteredAlerts.length === 0 ? (
            <p className="muted small">No mapped alerts for this child right now.</p>
          ) : (
            <div className="livemap-list">
              {filteredAlerts
                .slice()
                .sort((a, b) => b.createdAtMs - a.createdAtMs)
                .map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="mini-alert-row"
                    onClick={() => setSelection({ kind: 'alert', alert: a })}
                  >
                    <span aria-hidden>{alertIcon(a.type)}</span>
                    <span className="livemap-row-label">{a.title}</span>
                    <span className="muted small">{relativeTime(a.createdAtMs)}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </aside>

      <div className="livemap-canvas-wrap">
        {mapsAvailable ? (
          <div ref={mapDivRef} className="livemap-canvas" />
        ) : (
          <div className="livemap-canvas livemap-canvas-fallback">
            <span aria-hidden style={{ fontSize: '2rem' }}>
              🗺️
            </span>
            <p className="muted">Map preview unavailable (no Maps API key configured).</p>
          </div>
        )}
        <div className="livemap-maptype-switcher" role="group" aria-label="Map view type">
          {(Object.keys(MAP_TYPE_META) as MapTypeOption[]).map((type) => (
            <button
              key={type}
              type="button"
              className={mapType === type ? 'chip active' : 'chip'}
              disabled={!mapsReady}
              onClick={() => setMapType(type)}
              title={MAP_TYPE_META[type].label}
            >
              <span aria-hidden>{MAP_TYPE_META[type].glyph}</span> {MAP_TYPE_META[type].label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`btn compact livemap-follow-toggle ${followMode ? 'active' : 'ghost'}`}
          onClick={() => {
            setFollowMode((f) => {
              const next = !f
              if (next && markerRenderedPosRef.current) {
                mapObjRef.current?.panTo(markerRenderedPosRef.current)
              }
              return next
            })
          }}
          disabled={!mapsReady}
          title={followMode ? "Following the child's live position" : 'Camera panning is paused — click to follow again'}
        >
          {followMode ? '📍 Following' : '📍 Follow'}
        </button>
        <button type="button" className="btn ghost compact livemap-recenter" onClick={recenter} disabled={!mapsReady}>
          🎯 Recenter
        </button>
        {mode === 'live' && selectedDevice && (
          <div className={`livemap-status-pill ${liveIsStale ? 'is-stale' : 'is-live'}`}>
            <span className="livemap-status-dot" aria-hidden />
            <span>
              {liveIsStale ? 'Last known' : 'Live'} · updated {formatFreshness(liveFreshnessAtMs, liveClockMs)}
              {isRoadSnapped ? ' · road-snapped' : ''}
            </span>
          </div>
        )}
        {error && <div className="banner error-banner livemap-canvas-banner">{error}</div>}
      </div>

      <aside className="livemap-detail">
        <div className="livemap-block">
          <p className="nav-group-label">Route stats</p>
          <div className="livemap-stats-grid">
            <div>
              <p className="livemap-stat-value">{formatDistance(routeStats.distanceMeters)}</p>
              <p className="muted small">Distance ({mode})</p>
            </div>
            <div>
              <p className="livemap-stat-value">{stops.length}</p>
              <p className="muted small">Stops detected</p>
            </div>
            <div>
              <p className="livemap-stat-value">{routeStats.pointCount}</p>
              <p className="muted small">GPS samples</p>
            </div>
            <div>
              <p className="livemap-stat-value">{formatDuration(routeStats.durationMs)}</p>
              <p className="muted small">Window span</p>
            </div>
          </div>
        </div>

        {mode === 'playback' && (
          <div className="livemap-block">
            <p className="nav-group-label">Playback</p>
            {playbackBounds ? (
              <div className="stack" style={{ gap: '0.6rem' }}>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn primary compact"
                    onClick={() => setPlaying((p) => !p)}
                    disabled={playbackPoints.length < 2}
                  >
                    {playing ? '⏸ Pause' : '▶ Play'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost compact"
                    onClick={() => {
                      setPlaying(false)
                      setPlayhead(playbackBounds.minMs)
                    }}
                  >
                    ⏮ Reset
                  </button>
                  <select value={speedMult} onChange={(e) => setSpeedMult(Number(e.target.value))}>
                    {[0.5, 1, 2, 4, 8].map((s) => (
                      <option key={s} value={s}>
                        {s}×
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  type="range"
                  min={playbackBounds.minMs}
                  max={playbackBounds.maxMs}
                  value={playhead}
                  onChange={(e) => {
                    setPlaying(false)
                    setPlayhead(Number(e.target.value))
                  }}
                />
                <p className="muted small">{new Date(playhead).toLocaleString()}</p>
              </div>
            ) : (
              <p className="muted small">Load a history window to scrub playback.</p>
            )}
          </div>
        )}

        <div className="livemap-block livemap-scroll">
          <p className="nav-group-label">Selected</p>
          <SelectionDetail
            selection={selection}
            placeDraft={placeDraft}
            placeBusy={placeBusy}
            onCancelDraft={() => setPlaceDraft(null)}
            onDraftChange={(patch) => setPlaceDraft((d) => (d ? { ...d, ...patch } : d))}
            onSaveDraft={() => void saveNewPlace()}
            onClose={() => setSelection(null)}
            onMarkAlertRead={(alertId) => familyId && void repo.markAlertRead(familyId, alertId)}
            onDeletePlace={(placeId) => {
              if (!familyId) return
              void repo.deleteMapPlace(familyId, placeId)
              setSelection(null)
            }}
            onUpdatePlace={(placeId, patch) => {
              if (!familyId) return
              void repo.updateMapPlace(familyId, placeId, patch)
            }}
          />
        </div>
      </aside>
    </div>
  )
}

function SelectionDetail({
  selection,
  placeDraft,
  placeBusy,
  onCancelDraft,
  onDraftChange,
  onSaveDraft,
  onClose,
  onMarkAlertRead,
  onDeletePlace,
  onUpdatePlace,
}: {
  selection: Selection
  placeDraft: PlaceDraft | null
  placeBusy: boolean
  onCancelDraft: () => void
  onDraftChange: (patch: Partial<PlaceDraft>) => void
  onSaveDraft: () => void
  onClose: () => void
  onMarkAlertRead: (alertId: string) => void
  onDeletePlace: (placeId: string) => void
  onUpdatePlace: (placeId: string, patch: Partial<Omit<MapPlace, 'id' | 'createdAtMs'>>) => void
}) {
  const [address, setAddress] = useState<string | null>(null)
  const targetLat =
    placeDraft?.lat ??
    (selection?.kind === 'stop'
      ? selection.stop.lat
      : selection?.kind === 'alert'
        ? selection.alert.location?.lat
        : selection?.kind === 'place'
          ? selection.place.lat
          : null)
  const targetLng =
    placeDraft?.lng ??
    (selection?.kind === 'stop'
      ? selection.stop.lng
      : selection?.kind === 'alert'
        ? selection.alert.location?.lng
        : selection?.kind === 'place'
          ? selection.place.lng
          : null)

  useEffect(() => {
    setAddress(null)
    if (targetLat == null || targetLng == null) return
    let cancelled = false
    void reverseGeocode(targetLat, targetLng).then((r) => {
      if (!cancelled) setAddress(r)
    })
    return () => {
      cancelled = true
    }
  }, [targetLat, targetLng])

  if (placeDraft) {
    return (
      <div className="card form-card">
        <h4>New place</h4>
        <label>
          Name
          <input
            value={placeDraft.name}
            placeholder="e.g. Grandma's house"
            onChange={(e) => onDraftChange({ name: e.target.value })}
          />
        </label>
        <label>
          Type
          <select value={placeDraft.placeKind} onChange={(e) => onDraftChange({ placeKind: e.target.value as PlaceKind })}>
            <option value="home">Home</option>
            <option value="school">School</option>
            <option value="work">Work</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          Radius (meters)
          <input
            type="number"
            min={0}
            value={placeDraft.radiusM}
            onChange={(e) => onDraftChange({ radiusM: Number(e.target.value) || 0 })}
          />
        </label>
        <p className="muted small">
          {placeDraft.lat.toFixed(5)}, {placeDraft.lng.toFixed(5)}
          {address ? ` · ${address}` : ''}
        </p>
        <div className="btn-row">
          <button type="button" className="btn primary compact" disabled={placeBusy || !placeDraft.name.trim()} onClick={onSaveDraft}>
            Save place
          </button>
          <button type="button" className="btn ghost compact" onClick={onCancelDraft}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (!selection) {
    return <p className="muted small">Click a stop, place, or alert marker on the map to see details here.</p>
  }

  if (selection.kind === 'stop') {
    const { stop } = selection
    return (
      <div className="card">
        <h4>⏱ Stopped here</h4>
        <p className="livemap-stat-value">{formatDuration(stop.durationMs)}</p>
        <p className="muted small">
          {new Date(stop.startMs).toLocaleTimeString()} – {new Date(stop.endMs).toLocaleTimeString()}
        </p>
        <p className="muted small">{stop.sampleCount} GPS samples in this cluster</p>
        {address && <p className="address-line">📍 {address}</p>}
        <p className="muted small">
          {stop.lat.toFixed(5)}, {stop.lng.toFixed(5)}
        </p>
        <a
          className="btn ghost compact"
          href={`https://www.google.com/maps?q=${stop.lat},${stop.lng}`}
          target="_blank"
          rel="noreferrer"
        >
          Open in Google Maps
        </a>
      </div>
    )
  }

  if (selection.kind === 'alert') {
    const { alert } = selection
    return (
      <div className={`card alert-card tone-${severityTone(alert.severity)}`}>
        <div className="alert-icon" aria-hidden>
          {alertIcon(alert.type)}
        </div>
        <div className="alert-body">
          <h4>{alert.title}</h4>
          <p className="muted small">
            {alertCategoryLabel(alert.type)} · {relativeTime(alert.createdAtMs)}
          </p>
          {alert.snippet && <p>{alert.snippet}</p>}
          {address && <p className="address-line">📍 {address}</p>}
          <div className="btn-row">
            {alert.location && (
              <a
                className="btn ghost compact"
                href={`https://www.google.com/maps?q=${alert.location.lat},${alert.location.lng}`}
                target="_blank"
                rel="noreferrer"
              >
                Open in Google Maps
              </a>
            )}
            {!alert.read && (
              <button type="button" className="btn ghost compact" onClick={() => onMarkAlertRead(alert.id)}>
                Mark read
              </button>
            )}
            <button type="button" className="btn ghost compact" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    )
  }

  const { place } = selection
  return (
    <div className="card form-card">
      <h4>
        {PLACE_KIND_META[place.kind].glyph} {place.name}
      </h4>
      <label>
        Name
        <input value={place.name} onChange={(e) => onUpdatePlace(place.id, { name: e.target.value })} />
      </label>
      <label>
        Type
        <select value={place.kind} onChange={(e) => onUpdatePlace(place.id, { kind: e.target.value as PlaceKind })}>
          <option value="home">Home</option>
          <option value="school">School</option>
          <option value="work">Work</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label>
        Radius (meters)
        <input
          type="number"
          min={0}
          value={place.radiusM}
          onChange={(e) => onUpdatePlace(place.id, { radiusM: Number(e.target.value) || 0 })}
        />
      </label>
      {address && <p className="address-line">📍 {address}</p>}
      <p className="muted small">
        {place.lat.toFixed(5)}, {place.lng.toFixed(5)}
      </p>
      <div className="btn-row">
        <button type="button" className="btn ghost compact" onClick={() => onDeletePlace(place.id)}>
          Delete place
        </button>
        <button type="button" className="btn ghost compact" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
