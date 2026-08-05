import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../AuthContext'
import { isProjectAdmin } from '../lib/admin'
import * as repo from '../lib/parentRepo'
import { WENT_DARK_AFTER_MS } from '../firebase'
import { LiveViewingSection } from '../components/LiveViewingSection'
import type {
  AppBlockSchedule,
  AppLimit,
  DeviceStatus,
  FamilyAlert,
  FamilyChatMessage,
  FamilySafetySettings,
  GeofenceZone,
  GuardianInfo,
  LocationTrailSample,
  LiveRecording,
  LiveViewQuota,
  SafeContact,
  SafetyCommand,
  ScreenShareSchedule,
  SosContact,
  TcdReport,
  TcdOverview,
  AdminParentAccountRow,
  TypingSafetyEvent,
  TypingSafetySettings,
  UsageDaily,
  WeeklyDigest,
  WhatsAppEvent,
  CallRecording,
  DevicePhoto,
  ActivityEvent,
  ActivityEventType,
} from '../types'
import { mediaKind } from '../types'
import type { SafetyCommandType } from '../lib/parentRepo'
import { alertCategoryLabel, alertIcon, relativeTime, severityTone } from '../lib/alertPresentation'
import { reverseGeocode } from '../lib/googleMaps'
import { LiveMapPage } from './LiveMapPage'
import { WhatsAppEventsTable } from '../components/WhatsAppEventsTable'
import { AppsSection } from '../components/AppsSection'
import type { WhatsAppDisplayType } from '../lib/whatsappEventDisplay'

type Section =
  | 'home'
  | 'alerts'
  | 'chat'
  | 'livemap'
  | 'map'
  | 'pair'
  | 'safety'
  | 'whatsapp'
  | 'callrecording'
  | 'photos'
  | 'eventrecorder'
  | 'lockscreen'
  | 'liveview'
  | 'typing'
  | 'usage'
  | 'apps'
  | 'geofences'
  | 'digests'
  | 'guardians'
  | 'tcd'
type AlertFilter = 'all' | 'critical' | 'info'
type WhatsAppTableTypeFilter = WhatsAppDisplayType | 'ALL'
type TypingFilter = 'all' | 'flagged' | 'unreviewed'
type CallRecordingFilter = 'all' | 'cellular' | 'voip' | 'missed'
type ActivityEventFilter = 'all' | ActivityEventType

type NavItem = {
  id: Section
  label: string
  icon: string
  badge?: number
  /** Small secondary line under the label, e.g. "Keyboard & message shield". */
  sub?: string
}

type NavGroup = {
  label: string
  items: NavItem[]
}

const WHATSAPP_DEVICE_STORAGE_PREFIX = 'sarechild:whatsappDeviceId:'

function loadStoredWhatsAppDeviceId(familyId: string): string {
  try {
    return window.localStorage.getItem(`${WHATSAPP_DEVICE_STORAGE_PREFIX}${familyId}`) || ''
  } catch {
    return ''
  }
}

function saveStoredWhatsAppDeviceId(familyId: string, deviceId: string) {
  try {
    window.localStorage.setItem(`${WHATSAPP_DEVICE_STORAGE_PREFIX}${familyId}`, deviceId)
  } catch {
    // localStorage may be unavailable — not critical.
  }
}

export function DashboardPage() {
  const { user, familyId, trialInfo, signOut, refreshFamilyId } = useAuth()
  const [section, setSection] = useState<Section>('home')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [alertFilter, setAlertFilter] = useState<AlertFilter>('all')
  const [devices, setDevices] = useState<DeviceStatus[]>([])
  const [alerts, setAlerts] = useState<FamilyAlert[]>([])
  const [geofences, setGeofences] = useState<GeofenceZone[]>([])
  const [commands, setCommands] = useState<SafetyCommand[]>([])
  const [usageDaily, setUsageDaily] = useState<UsageDaily[]>([])
  const [locationTrail, setLocationTrail] = useState<LocationTrailSample[]>([])
  const [appLimits, setAppLimits] = useState<AppLimit[]>([])
  const [appBlockSchedules, setAppBlockSchedules] = useState<AppBlockSchedule[]>([])
  const [digests, setDigests] = useState<WeeklyDigest[]>([])
  const [guardians, setGuardians] = useState<GuardianInfo[]>([])
  const [safeContacts, setSafeContacts] = useState<SafeContact[]>([])
  const [whatsAppBadgeEvents, setWhatsAppBadgeEvents] = useState<WhatsAppEvent[]>([])
  const [whatsAppEvents, setWhatsAppEvents] = useState<WhatsAppEvent[]>([])
  const [whatsAppDeviceId, setWhatsAppDeviceId] = useState('')
  const [whatsAppIndexFallback, setWhatsAppIndexFallback] = useState(false)
  const [whatsAppTypeFilter, setWhatsAppTypeFilter] = useState<WhatsAppTableTypeFilter>('ALL')
  const [callRecordings, setCallRecordings] = useState<CallRecording[]>([])
  const [devicePhotos, setDevicePhotos] = useState<DevicePhoto[]>([])
  const [photoDeviceId, setPhotoDeviceId] = useState('')
  const [photoDateFilter, setPhotoDateFilter] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState<DevicePhoto | null>(null)
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([])
  const [eventRecorderDeviceId, setEventRecorderDeviceId] = useState('')
  const [lockScreenDeviceId, setLockScreenDeviceId] = useState('')
  const [eventTypeFilter, setEventTypeFilter] = useState<ActivityEventFilter>('all')
  const [eventAppFilter, setEventAppFilter] = useState('')
  const [eventDateFilter, setEventDateFilter] = useState('')
  const [eventSearch, setEventSearch] = useState('')
  const [liveRecordings, setLiveRecordings] = useState<LiveRecording[]>([])
  const [liveViewQuota, setLiveViewQuota] = useState<LiveViewQuota | null>(null)
  const [callRecordingFilter, setCallRecordingFilter] = useState<CallRecordingFilter>('all')
  const [typingEvents, setTypingEvents] = useState<TypingSafetyEvent[]>([])
  const [typingFilter, setTypingFilter] = useState<TypingFilter>('all')
  const [typingSettings, setTypingSettings] = useState<TypingSafetySettings>({
    prohibitedWords: [],
    alwaysMonitorPackages: [],
    whitelistPackages: [],
    mode360: false,
    autoBlockEnabled: false,
    autoBlockSeverity: 'HIGH',
  })
  const [safetySettings, setSafetySettings] = useState<FamilySafetySettings>({
    escalationEnabled: true,
    escalationRiskThreshold: 60,
    autoLockOnCritical: false,
    checkInIntervalMinutes: 120,
    snoozedCategories: [],
    snoozeUntilMs: 0,
    alertRetentionDays: 30,
    mediaRetentionDays: 7,
  })
  const [sosContacts, setSosContacts] = useState<SosContact[]>([])
  const [error, setError] = useState<string | null>(null)

  // Ticks every 15s so "went dark" transitions show up live even when no new
  // Firestore snapshot arrives (heartbeats stop, so there's nothing to push).
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  // "Checking up on kids" = opening the dashboard or viewing devices/alerts — the
  // trial-cleanup rule cares about this signal, not just login. Throttled to once/hour
  // inside recordParentCheckIn, so this is safe to call on every relevant render.
  useEffect(() => {
    if (!user || (section !== 'home' && section !== 'alerts')) return
    void repo.recordParentCheckIn(user.uid)
  }, [user, section])

  const [childName, setChildName] = useState('')
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [zoneName, setZoneName] = useState('Home')
  const [zoneRadius, setZoneRadius] = useState('200')
  const [zoneDays, setZoneDays] = useState('')
  const [zoneStart, setZoneStart] = useState('')
  const [zoneEnd, setZoneEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const [removeDeviceId, setRemoveDeviceId] = useState<string | null>(null)
  const [removeConfirmText, setRemoveConfirmText] = useState('')
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const [limitDeviceId, setLimitDeviceId] = useState('')
  const [limitPackage, setLimitPackage] = useState('')
  const [limitLabel, setLimitLabel] = useState('')
  const [limitMinutes, setLimitMinutes] = useState('60')
  const [blockPackage, setBlockPackage] = useState('')
  const [blockLabel, setBlockLabel] = useState('')
  const [blockDays, setBlockDays] = useState('2,3,4,5,6')
  const [blockStart, setBlockStart] = useState('480')
  const [blockEnd, setBlockEnd] = useState('900')
  const [offlineCallNumber, setOfflineCallNumber] = useState('')
  const [offlineCallAttempts, setOfflineCallAttempts] = useState('2')
  const [newProhibitedWord, setNewProhibitedWord] = useState('')
  const [newAlwaysMonitorApp, setNewAlwaysMonitorApp] = useState('')
  const [newTypingWhitelistApp, setNewTypingWhitelistApp] = useState('')

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [screenShareDuration, setScreenShareDuration] = useState(10)
  const [screenShareSchedules, setScreenShareSchedules] = useState<ScreenShareSchedule[]>([])
  const [scheduleLabel, setScheduleLabel] = useState('Homework check')
  const [scheduleTime, setScheduleTime] = useState('20:00')
  const [scheduleDays, setScheduleDays] = useState('1,2,3,4,5')
  const [scheduleDeviceId, setScheduleDeviceId] = useState('')
  const [joinCode, setJoinCode] = useState('')

  const [sosName, setSosName] = useState('')
  const [sosPhone, setSosPhone] = useState('')
  const [safeLabel, setSafeLabel] = useState('')
  const [safeIdentifier, setSafeIdentifier] = useState('')
  const [tcdReport, setTcdReport] = useState<TcdReport | null>(null)
  const [tcdOverview, setTcdOverview] = useState<TcdOverview | null>(null)
  const [adminAccounts, setAdminAccounts] = useState<AdminParentAccountRow[] | null>(null)
  const [adminAccountsError, setAdminAccountsError] = useState<string | null>(null)
  const [repairLog, setRepairLog] = useState<string[]>([])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const deepLink = params.get('section')
    if (deepLink === 'eventrecorder') setSection('eventrecorder')
    if (deepLink === 'lockscreen') setSection('lockscreen')
  }, [])

  useEffect(() => {
    if (!familyId) return
    const unsubs = [
      repo.observeDevices(familyId, setDevices, (e) => setError(e.message)),
      repo.observeAlerts(familyId, setAlerts, (e) => setError(e.message)),
      repo.observeGeofences(familyId, setGeofences, (e) => setError(e.message)),
      repo.observeCommands(familyId, setCommands, (e) => setError(e.message)),
      repo.observeUsageDaily(familyId, setUsageDaily, (e) => setError(e.message)),
      repo.observeLocationTrail(familyId, setLocationTrail, (e) => setError(e.message)),
      repo.observeAppLimits(familyId, setAppLimits, (e) => setError(e.message)),
      repo.observeAppBlockSchedules(familyId, setAppBlockSchedules, (e) => setError(e.message)),
      repo.observeDigests(familyId, setDigests, (e) => setError(e.message)),
      repo.observeGuardians(familyId, setGuardians, (e) => setError(e.message)),
      repo.observeSosContacts(familyId, setSosContacts, (e) => setError(e.message)),
      repo.observeSafeContacts(familyId, setSafeContacts, (e) => setError(e.message)),
      repo.observeWhatsAppEvents(familyId, setWhatsAppBadgeEvents, (e) => setError(e.message)),
      repo.observeCallRecordings(familyId, setCallRecordings, (e) => setError(e.message)),
      repo.observeLiveRecordings(familyId, setLiveRecordings, (e) => setError(e.message)),
      repo.observeTypingSafetyEvents(familyId, setTypingEvents, (e) => setError(e.message)),
      repo.observeTypingSafetySettings(familyId, setTypingSettings, (e) => setError(e.message)),
      repo.observeSafetySettings(familyId, setSafetySettings, (e) => setError(e.message)),
      repo.observeScreenShareSchedules(familyId, setScreenShareSchedules, (e) => setError(e.message)),
    ]
    return () => unsubs.forEach((u) => u())
  }, [familyId])

  useEffect(() => {
    if (!user?.uid) return
    return repo.observeLiveViewQuota(user.uid, setLiveViewQuota, (e) => setError(e.message))
  }, [user?.uid])

  useEffect(() => {
    if (!familyId || !photoDeviceId) {
      setDevicePhotos([])
      return
    }
    return repo.observeDevicePhotos(familyId, photoDeviceId, setDevicePhotos, (e) => setError(e.message))
  }, [familyId, photoDeviceId])

  useEffect(() => {
    if (!familyId || !eventRecorderDeviceId) {
      setActivityEvents([])
      return
    }
    return repo.observeActivityEvents(
      familyId,
      eventRecorderDeviceId,
      setActivityEvents,
      (e) => setError(e.message),
    )
  }, [familyId, eventRecorderDeviceId])

  useEffect(() => {
    if (!familyId || !whatsAppDeviceId) {
      setWhatsAppEvents([])
      setWhatsAppIndexFallback(false)
      return
    }
    setWhatsAppIndexFallback(false)
    return repo.observeWhatsAppEventsForDevice(
      familyId,
      whatsAppDeviceId,
      setWhatsAppEvents,
      (e) => setError(e.message),
      setWhatsAppIndexFallback,
    )
  }, [familyId, whatsAppDeviceId])

  useEffect(() => {
    if (!familyId) return
    const stored = loadStoredWhatsAppDeviceId(familyId)
    if (stored && devices.some((d) => d.id === stored)) {
      setWhatsAppDeviceId(stored)
      return
    }
    if (devices.length > 0 && (!whatsAppDeviceId || !devices.some((d) => d.id === whatsAppDeviceId))) {
      setWhatsAppDeviceId(devices[0]!.id)
    }
  }, [familyId, devices, whatsAppDeviceId])

  useEffect(() => {
    if (familyId && whatsAppDeviceId) saveStoredWhatsAppDeviceId(familyId, whatsAppDeviceId)
  }, [familyId, whatsAppDeviceId])

  useEffect(() => {
    if (!limitDeviceId && devices.length > 0) setLimitDeviceId(devices[0]!.id)
    if (!scheduleDeviceId && devices.length > 0) setScheduleDeviceId(devices[0]!.id)
    if (!photoDeviceId && devices.length > 0) setPhotoDeviceId(devices[0]!.id)
    if (!eventRecorderDeviceId && devices.length > 0) setEventRecorderDeviceId(devices[0]!.id)
    if (!lockScreenDeviceId && devices.length > 0) setLockScreenDeviceId(devices[0]!.id)
    if (devices.length > 0 && !offlineCallNumber) {
      setOfflineCallNumber(devices[0]!.offlineCallNumber || '')
      setOfflineCallAttempts(String(devices[0]!.offlineCallMaxAttempts || 2))
    }
  }, [devices, limitDeviceId, scheduleDeviceId, photoDeviceId])

  const unread = useMemo(() => alerts.filter((a) => !a.read).length, [alerts])
  const latestUnreadAlert = useMemo(
    () => alerts.filter((a) => !a.read).sort((a, b) => b.createdAtMs - a.createdAtMs)[0],
    [alerts],
  )
  const filteredAlerts = useMemo(() => {
    const sorted = [...alerts].sort((a, b) => b.createdAtMs - a.createdAtMs)
    if (alertFilter === 'all') return sorted
    if (alertFilter === 'critical') {
      return sorted.filter((a) => severityTone(a.severity) === 'critical' || severityTone(a.severity) === 'high')
    }
    return sorted.filter((a) => severityTone(a.severity) === 'low' || severityTone(a.severity) === 'medium')
  }, [alerts, alertFilter])

  // Live fleet snapshot derived from the same Firestore listeners already
  // driving the Devices/Alerts tabs, so TCD reflects changes instantly
  // without waiting on the periodic edge/health refresh.
  const liveFleet = useMemo(() => {
    const cutoff24h = nowTick - 24 * 60 * 60 * 1000
    const onlineDevices = devices.filter((d) => isDeviceOnline(d, nowTick)).length
    const alertsLast24h = alerts.filter((a) => a.createdAtMs >= cutoff24h).length
    const criticalAlertsLast24h = alerts.filter(
      (a) => a.createdAtMs >= cutoff24h && a.severity.toUpperCase() === 'CRITICAL',
    ).length
    const pendingCommands = commands.filter((c) => c.status === 'PENDING').length
    return {
      registeredDevices: devices.length,
      onlineDevices,
      offlineDevices: Math.max(0, devices.length - onlineDevices),
      guardians: guardians.length,
      alertsLast24h,
      criticalAlertsLast24h,
      pendingCommands,
      generatedAtMs: nowTick,
    }
  }, [devices, alerts, commands, guardians, nowTick])

  const whatsAppUnknownCount = useMemo(
    () => whatsAppBadgeEvents.filter((e) => !e.contactSafe).length,
    [whatsAppBadgeEvents],
  )

  const selectedWhatsAppDevice = useMemo(
    () => devices.find((d) => d.id === whatsAppDeviceId) ?? null,
    [devices, whatsAppDeviceId],
  )

  const whatsAppDeviceUnknownCount = useMemo(
    () => whatsAppEvents.filter((e) => !e.contactSafe).length,
    [whatsAppEvents],
  )

  const whatsAppLastEventByDevice = useMemo(() => {
    const map = new Map<string, number>()
    for (const ev of whatsAppBadgeEvents) {
      const prev = map.get(ev.deviceId) ?? 0
      if (ev.createdAtMs > prev) map.set(ev.deviceId, ev.createdAtMs)
    }
    return map
  }, [whatsAppBadgeEvents])

  const whatsAppSetupStatus = useMemo(() => {
    const d = selectedWhatsAppDevice
    if (!d) return null
    const wp = d.whatsappProtection
    const consent = wp?.consent ?? d.whatsappMonitorConsent
    const notif = wp?.notificationAccess ?? d.notificationAccess
    const enabled = wp?.enabled
    if (enabled) return null
    if (!consent) {
      return {
        title: 'WhatsApp protection not enabled yet',
        body: `Tap "Request WhatsApp protection" below — ${d.childName} will see a visible Accept screen with steps to enable notification access and accessibility.`,
      }
    }
    if (!notif) {
      return {
        title: 'Notification access needed',
        body: `WhatsApp protection is consented on ${d.childName}'s phone but notification access is off. On the child phone: SareChild → Review permissions → Open notification access settings → enable SareChild.`,
      }
    }
    const media = wp?.mediaPermission ?? d.whatsappMediaPermission
    if (!media) {
      return {
        title: 'WhatsApp media permission missing',
        body: 'Messages and calls can still be captured from notifications. For photos, videos, and voice notes, grant WhatsApp media access on the child device (Review permissions → step 8).',
      }
    }
    return {
      title: 'Waiting for child heartbeat',
      body: `WhatsApp protection was just enabled on ${d.childName}'s phone — status updates on the next device heartbeat (within a few minutes). Send a test WhatsApp message to verify events appear.`,
    }
  }, [selectedWhatsAppDevice])

  const callRecordingStats = useMemo(() => {
    const total = callRecordings.length
    const withAudio = callRecordings.filter((r) => r.audioCaptured).length
    const totalDurationSec = callRecordings.reduce((sum, r) => sum + r.durationSec, 0)
    const lastMs = callRecordings.reduce((max, r) => Math.max(max, r.createdAtMs), 0)
    return { total, withAudio, totalDurationSec, lastMs }
  }, [callRecordings])

  const filteredPhotos = useMemo(() => {
    if (!photoDateFilter.trim()) return devicePhotos
    const dayStart = new Date(photoDateFilter).setHours(0, 0, 0, 0)
    const dayEnd = dayStart + 24 * 60 * 60 * 1000
    return devicePhotos.filter((p) => p.takenAtMs >= dayStart && p.takenAtMs < dayEnd)
  }, [devicePhotos, photoDateFilter])

  const photoStats = useMemo(() => {
    const selectedDevice = devices.find((d) => d.id === photoDeviceId)
    const status = selectedDevice?.photoGalleryStatus
    return {
      count: status?.photoCount ?? filteredPhotos.length,
      lastSyncMs: status?.lastSyncAtMs ?? 0,
      accessLevel: status?.accessLevel ?? 'NONE',
    }
  }, [devices, photoDeviceId, filteredPhotos.length])

  const eventRecorderStats = useMemo(() => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayMs = todayStart.getTime()
    const todayEvents = activityEvents.filter((e) => e.createdAtMs >= todayMs)
    let activeMs = 0
    let idleMs = 0
    const appMinutes: Record<string, number> = {}
    let mediaSessions = 0
    for (const e of todayEvents) {
      if (e.type === 'APP_FOREGROUND' || e.type === 'APP_BACKGROUND') {
        const dur = e.durationMs ?? 0
        if (dur > 0) {
          activeMs += dur
          const label = e.appLabel || e.packageName || 'Unknown'
          appMinutes[label] = (appMinutes[label] ?? 0) + dur
        }
      }
      if (e.type === 'IDLE_END' && e.durationMs) idleMs += e.durationMs
      if (
        e.type === 'MEDIA_PLAY' ||
        e.type === 'NOTIFICATION_MEDIA' ||
        (e.type === 'APP_FOREGROUND' && (e.packageName?.includes('youtube') || e.title))
      ) {
        if (e.type === 'MEDIA_PLAY' || e.type === 'NOTIFICATION_MEDIA') mediaSessions++
      }
    }
    const topApps = Object.entries(appMinutes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, ms]) => ({ label, minutes: Math.round(ms / 60_000) }))
    const selected = devices.find((d) => d.id === eventRecorderDeviceId)
    const status = selected?.eventRecorderStatus
    return {
      activeMinutes: Math.round(activeMs / 60_000),
      idleMinutes: Math.round(idleMs / 60_000),
      topApps,
      mediaSessions,
      lastSyncMs: status?.lastSyncAtMs ?? 0,
      eventCount24h: status?.eventCount24h ?? todayEvents.length,
    }
  }, [activityEvents, devices, eventRecorderDeviceId])

  const filteredActivityEvents = useMemo(() => {
    let rows = activityEvents
    if (eventTypeFilter !== 'all') rows = rows.filter((e) => e.type === eventTypeFilter)
    if (eventAppFilter.trim()) {
      const q = eventAppFilter.trim().toLowerCase()
      rows = rows.filter(
        (e) =>
          (e.appLabel ?? '').toLowerCase().includes(q) ||
          (e.packageName ?? '').toLowerCase().includes(q),
      )
    }
    if (eventDateFilter.trim()) {
      const dayStart = new Date(eventDateFilter).setHours(0, 0, 0, 0)
      const dayEnd = dayStart + 24 * 60 * 60 * 1000
      rows = rows.filter((e) => e.createdAtMs >= dayStart && e.createdAtMs < dayEnd)
    }
    if (eventSearch.trim()) {
      const q = eventSearch.trim().toLowerCase()
      rows = rows.filter(
        (e) =>
          (e.title ?? '').toLowerCase().includes(q) ||
          (e.details ?? '').toLowerCase().includes(q) ||
          (e.url ?? '').toLowerCase().includes(q) ||
          e.type.toLowerCase().includes(q),
      )
    }
    return rows
  }, [activityEvents, eventTypeFilter, eventAppFilter, eventDateFilter, eventSearch])

  const filteredCallRecordings = useMemo(() => {
    if (callRecordingFilter === 'all') return callRecordings
    if (callRecordingFilter === 'cellular') {
      return callRecordings.filter((r) => r.callType === 'CELLULAR')
    }
    if (callRecordingFilter === 'voip') {
      return callRecordings.filter((r) => r.callType === 'VOIP_PARTIAL')
    }
    return callRecordings.filter((r) => r.callType === 'MISSED')
  }, [callRecordings, callRecordingFilter])

  const typingFlaggedCount = useMemo(
    () => typingEvents.filter((e) => e.matchedWords.length > 0).length,
    [typingEvents],
  )
  const typingUnreviewedFlaggedCount = useMemo(
    () => typingEvents.filter((e) => e.matchedWords.length > 0 && !e.reviewed).length,
    [typingEvents],
  )
  const filteredTypingEvents = useMemo(() => {
    if (typingFilter === 'flagged') return typingEvents.filter((e) => e.matchedWords.length > 0)
    if (typingFilter === 'unreviewed') {
      return typingEvents.filter((e) => e.matchedWords.length > 0 && !e.reviewed)
    }
    return typingEvents
  }, [typingEvents, typingFilter])

  // Extra protection idea: a simple per-app "risk score" (% of captured snippets that matched a
  // prohibited word) so a parent can see at a glance which apps deserve the closest attention —
  // computed client-side from the same timeline already being observed above, so it's free.
  const typingAppRiskScores = useMemo(() => {
    const counts = new Map<string, { label: string; flagged: number; total: number }>()
    typingEvents.forEach((e) => {
      const key = e.packageName || e.appLabel
      const entry = counts.get(key) || { label: e.appLabel || key, flagged: 0, total: 0 }
      entry.total += 1
      if (e.matchedWords.length > 0) entry.flagged += 1
      counts.set(key, entry)
    })
    return Array.from(counts.entries())
      .map(([packageName, v]) => ({
        packageName,
        label: v.label,
        flagged: v.flagged,
        total: v.total,
        score: v.total ? Math.round((v.flagged / v.total) * 100) : 0,
      }))
      .filter((r) => r.flagged > 0)
      .sort((a, b) => b.score - a.score || b.flagged - a.flagged)
      .slice(0, 6)
  }, [typingEvents])

  const galleryItems = useMemo(() => {
    const fromAlerts = alerts
      .filter((a) => !!a.mediaUrl)
      .map((a) => ({
        url: a.mediaUrl as string,
        caption: `${a.title} · ${new Date(a.createdAtMs).toLocaleString()}`,
      }))
    const fromFrames = devices
      .filter((d) => !!d.latestFrameUrl)
      .map((d) => ({
        url: d.latestFrameUrl as string,
        caption: `Latest screen frame — ${d.childName}`,
      }))
    return [...fromFrames, ...fromAlerts]
  }, [alerts, devices])

  const openSection = (id: Section) => {
    setSection(id)
    setSidebarOpen(false)
  }

  const createCode = async () => {
    setBusy(true)
    setError(null)
    try {
      const code = await repo.createPairingCode(childName || 'Child')
      setPairingCode(code)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create code')
    } finally {
      setBusy(false)
    }
  }

  const requiredRemoveConfirmText = (childNameForDevice: string) =>
    childNameForDevice.trim() ? childNameForDevice.trim() : 'DELETE'

  const openRemoveDevice = (deviceId: string) => {
    setRemoveDeviceId(deviceId)
    setRemoveConfirmText('')
    setRemoveError(null)
  }

  const cancelRemoveDevice = () => {
    setRemoveDeviceId(null)
    setRemoveConfirmText('')
    setRemoveError(null)
  }

  const confirmRemoveDevice = async (device: DeviceStatus) => {
    if (!familyId) return
    const required = requiredRemoveConfirmText(device.childName)
    if (removeConfirmText.trim().toUpperCase() !== required.toUpperCase()) {
      setRemoveError(`Type "${required}" exactly to confirm.`)
      return
    }
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      await repo.deletePairedDevice(familyId, device.id)
      setStatusMsg(`Removed ${device.childName || 'device'} and all of its data.`)
      setRemoveDeviceId(null)
      setRemoveConfirmText('')
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Failed to remove device')
    } finally {
      setRemoveBusy(false)
    }
  }

  const addGeofence = async () => {
    if (!familyId) return
    const loc = devices[0]?.lastLocation
    if (!loc) {
      setError('Waiting for child location before adding a geofence.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const days = zoneDays
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
      await repo.addGeofence(familyId, {
        name: zoneName.trim() || 'Zone',
        lat: loc.lat,
        lng: loc.lng,
        radiusM: Number(zoneRadius) || 200,
        active: true,
        daysOfWeek: days,
        startMinute: zoneStart.trim() === '' ? null : Number(zoneStart),
        endMinute: zoneEnd.trim() === '' ? null : Number(zoneEnd),
      })
      setZoneDays('')
      setZoneStart('')
      setZoneEnd('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add geofence')
    } finally {
      setBusy(false)
    }
  }

  const requestCheck = async (
    deviceId: string,
    type: SafetyCommandType,
    durationMinutes?: number,
  ) => {
    if (!familyId) return
    setBusy(true)
    setError(null)
    setStatusMsg(null)
    try {
      await repo.createSafetyCommand(familyId, deviceId, type, durationMinutes)
      const instant =
        type === 'LOCK_SCREEN'
          ? 'Lock command sent — the child phone should lock to its system lock screen within seconds.'
          : type === 'REQUEST_DEVICE_ADMIN'
            ? 'Request sent — the child must enable Device Administrator on their phone (Android system prompt).'
            : 'Request sent — the child must Accept on their phone (visible prompt + notification).'
      setStatusMsg(instant)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send request')
    } finally {
      setBusy(false)
    }
  }

  const requestLockScreen = async (deviceId: string) => {
    if (
      !window.confirm(
        "This will immediately lock the child's phone to its normal lock screen (PIN, pattern, or fingerprint). Continue?",
      )
    ) {
      return
    }
    await requestCheck(deviceId, 'LOCK_SCREEN')
  }

  const cycleScreenShareDuration = () => {
    setScreenShareDuration((d) => (d === 5 ? 10 : d === 10 ? 15 : d === 15 ? 30 : d === 30 ? 60 : 5))
  }

  const submitAppLimit = async () => {
    if (!familyId) return
    if (!limitDeviceId || !limitPackage.trim()) {
      setError('Pick a device and enter a package name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await repo.addAppLimit(familyId, {
        deviceId: limitDeviceId,
        packageName: limitPackage.trim(),
        label: limitLabel.trim(),
        dailyLimitMinutes: Number(limitMinutes) || 60,
      })
      setLimitPackage('')
      setLimitLabel('')
      setLimitMinutes('60')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add app limit')
    } finally {
      setBusy(false)
    }
  }

  const submitAppBlock = async () => {
    if (!familyId) return
    if (!limitDeviceId || !blockPackage.trim()) {
      setError('Pick a device and enter a package name for schedule block.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const days = blockDays
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
      await repo.addAppBlockSchedule(familyId, {
        deviceId: limitDeviceId,
        packageName: blockPackage.trim(),
        label: blockLabel.trim(),
        daysOfWeek: days,
        startMinute: Number(blockStart) || 480,
        endMinute: Number(blockEnd) || 900,
        active: true,
        message: 'Application has been blocked.',
        createdAtMs: Date.now(),
      })
      setBlockPackage('')
      setBlockLabel('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add block schedule')
    } finally {
      setBusy(false)
    }
  }

  const addBlockPresets = async () => {
    if (!familyId || !limitDeviceId) {
      setError('Pick a device first.')
      return
    }
    const apps = [
      { packageName: 'com.zhiliaoapp.musically', label: 'TikTok' },
      { packageName: 'com.whatsapp', label: 'WhatsApp' },
      { packageName: 'com.facebook.katana', label: 'Facebook' },
    ]
    setBusy(true)
    setError(null)
    try {
      for (const app of apps) {
        await repo.addAppBlockSchedule(familyId, {
          ...app,
          deviceId: limitDeviceId,
          daysOfWeek: [2, 3, 4, 5, 6],
          startMinute: 8 * 60,
          endMinute: 15 * 60,
          active: true,
          message: 'Application has been blocked.',
          createdAtMs: Date.now(),
        })
        await repo.addAppBlockSchedule(familyId, {
          packageName: app.packageName,
          label: `${app.label} (Bedtime)`,
          deviceId: limitDeviceId,
          daysOfWeek: [],
          startMinute: 21 * 60,
          endMinute: 6 * 60 + 30,
          active: true,
          message: 'Application has been blocked.',
          createdAtMs: Date.now(),
        })
      }
      setStatusMsg('Preset app-block schedules added.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add presets')
    } finally {
      setBusy(false)
    }
  }

  const saveOfflineCallConfig = async () => {
    if (!familyId || !limitDeviceId) return
    setBusy(true)
    setError(null)
    try {
      const attempts = Number(offlineCallAttempts) || 0
      await repo.setOfflineCallConfig(
        familyId,
        limitDeviceId,
        offlineCallNumber.trim().length > 0 && attempts > 0,
        offlineCallNumber,
        attempts,
      )
      setStatusMsg('Offline auto-call fallback config saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save offline auto-call config')
    } finally {
      setBusy(false)
    }
  }

  const submitInvite = async () => {
    if (!inviteEmail.trim()) {
      setError('Enter the caregiver email to invite.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const code = await repo.createGuardianInvite(inviteEmail.trim())
      setInviteCode(code)
      setInviteEmail('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create invite')
    } finally {
      setBusy(false)
    }
  }

  const submitJoin = async () => {
    if (!joinCode.trim()) {
      setError('Enter an invite code to join a family.')
      return
    }
    setBusy(true)
    setError(null)
    setStatusMsg(null)
    try {
      await repo.acceptGuardianInvite(joinCode.trim())
      await refreshFamilyId()
      setJoinCode('')
      setStatusMsg('Joined family as a caregiver.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to accept invite')
    } finally {
      setBusy(false)
    }
  }

  const submitSosContact = async () => {
    if (!familyId) return
    if (!sosName.trim()) {
      setError('Enter a contact name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await repo.addSosContact(familyId, { name: sosName.trim(), phoneNote: sosPhone.trim() })
      setSosName('')
      setSosPhone('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add SOS contact')
    } finally {
      setBusy(false)
    }
  }

  const submitSafeContact = async () => {
    if (!familyId) return
    if (!safeIdentifier.trim()) {
      setError('Enter WhatsApp identifier (name/handle/phone).')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await repo.addSafeContact(familyId, {
        channel: 'WHATSAPP',
        label: safeLabel.trim(),
        identifier: safeIdentifier.trim(),
      })
      setSafeLabel('')
      setSafeIdentifier('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add safe contact')
    } finally {
      setBusy(false)
    }
  }

  const submitProhibitedWord = async () => {
    if (!familyId || !newProhibitedWord.trim()) return
    setBusy(true)
    setError(null)
    try {
      await repo.addProhibitedWord(familyId, newProhibitedWord)
      setNewProhibitedWord('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add word')
    } finally {
      setBusy(false)
    }
  }

  const submitAlwaysMonitorApp = async () => {
    if (!familyId || !newAlwaysMonitorApp.trim()) return
    setBusy(true)
    setError(null)
    try {
      await repo.addAlwaysMonitorApp(familyId, newAlwaysMonitorApp)
      setNewAlwaysMonitorApp('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add app')
    } finally {
      setBusy(false)
    }
  }

  const submitTypingWhitelistApp = async () => {
    if (!familyId || !newTypingWhitelistApp.trim()) return
    setBusy(true)
    setError(null)
    try {
      await repo.addTypingWhitelistApp(familyId, newTypingWhitelistApp)
      setNewTypingWhitelistApp('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add app')
    } finally {
      setBusy(false)
    }
  }

  const toggleTypingMode360 = async (enabled: boolean) => {
    if (!familyId) return
    setError(null)
    try {
      await repo.setTypingMode360(familyId, enabled)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update 360 protection')
    }
  }

  const saveTypingAutoBlock = async (enabled: boolean, severity: string) => {
    if (!familyId) return
    setError(null)
    try {
      await repo.setTypingAutoBlock(familyId, enabled, severity)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update auto-block setting')
    }
  }

  const blockAppForTypingEvent = async (ev: TypingSafetyEvent) => {
    if (!familyId) return
    setBusy(true)
    setError(null)
    try {
      await repo.blockAppFromTypingEvent(familyId, ev.deviceId, ev.packageName, ev.appLabel)
      setStatusMsg(`${ev.appLabel || ev.packageName} blocked on that device.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to block app')
    } finally {
      setBusy(false)
    }
  }

  const saveSafetySettings = async () => {
    if (!familyId) return
    setBusy(true)
    setError(null)
    try {
      await repo.setSafetySettings(familyId, safetySettings)
      setStatusMsg('Safety automation settings saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save safety settings')
    } finally {
      setBusy(false)
    }
  }

  const runTcdCheck = async () => {
    if (!familyId) return
    setBusy(true)
    setError(null)
    try {
      const [report, overview] = await Promise.all([
        repo.runTcdHealthCheck(familyId),
        repo.loadTcdOverview(familyId),
      ])
      setTcdReport(report)
      setTcdOverview(overview)
      setStatusMsg('TCD health check completed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run TCD check')
    } finally {
      setBusy(false)
    }
  }

  const runTcdRepair = async () => {
    if (!familyId) return
    setBusy(true)
    setError(null)
    try {
      const log = await repo.runTcdAutoRepair(familyId)
      setRepairLog(log)
      const [report, overview] = await Promise.all([
        repo.runTcdHealthCheck(familyId),
        repo.loadTcdOverview(familyId),
      ])
      setTcdReport(report)
      setTcdOverview(overview)
      setStatusMsg('Auto-repair completed and health re-checked.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run auto-repair')
    } finally {
      setBusy(false)
    }
  }

  const loadAdminAccounts = async () => {
    if (!isProjectAdmin(user)) return
    setBusy(true)
    setAdminAccountsError(null)
    try {
      setAdminAccounts(await repo.loadAdminParentAccounts())
    } catch (e) {
      setAdminAccountsError(e instanceof Error ? e.message : 'Failed to load parent accounts')
    } finally {
      setBusy(false)
    }
  }

  const navGroups: NavGroup[] = [
    {
      label: 'Overview',
      items: [
        { id: 'home', label: 'Home', icon: '\u{1F3E0}' },
        { id: 'alerts', label: 'Alerts', icon: '\u{1F514}', badge: unread },
        { id: 'chat', label: 'Chat', icon: '\u{1F4AC}' },
        { id: 'livemap', label: 'Live map', icon: '\u{1F6F0}\uFE0F' },
        { id: 'map', label: 'Map & locations', icon: '\u{1F4CD}' },
      ],
    },
    {
      label: 'Family',
      items: [
        { id: 'pair', label: 'Pair a device', icon: '\u{1F4F1}' },
        { id: 'guardians', label: 'Guardians', icon: '\u{1F46A}' },
      ],
    },
    {
      label: 'WhatsApp protection',
      items: [
        { id: 'whatsapp', label: 'WhatsApp', icon: '\u{1F7E2}', badge: whatsAppUnknownCount },
      ],
    },
    {
      label: 'Communication',
      items: [
        {
          id: 'callrecording',
          label: 'Call recording',
          sub: 'Cellular & VoIP (native Android)',
          icon: '\u{1F4DE}',
          badge: callRecordingStats.total > 0 ? callRecordingStats.total : undefined,
        },
        {
          id: 'photos',
          label: 'Photos',
          sub: 'Device gallery (consent-first)',
          icon: '\u{1F5BC}\uFE0F',
          badge: photoStats.count > 0 ? photoStats.count : undefined,
        },
        {
          id: 'liveview',
          label: 'Live viewing',
          sub: 'Camera, audio & screen (WebRTC)',
          icon: '\u{1F4F9}',
        },
      ],
    },
    {
      label: 'Typing safety',
      items: [
        {
          id: 'typing',
          label: 'Typing safety',
          sub: 'Keyboard & message shield',
          icon: '\u2328\uFE0F',
          badge: typingUnreviewedFlaggedCount,
        },
      ],
    },
    {
      label: 'Safety tools',
      items: [
        { id: 'safety', label: 'Safety checks', icon: '\u{1F6E1}\uFE0F' },
        { id: 'geofences', label: 'Safe zones', icon: '\u{1F4D0}' },
        { id: 'apps', label: 'Apps', icon: '\u{1F4F1}', badge: appBlockSchedules.length || undefined },
        { id: 'usage', label: 'Usage & limits', icon: '\u23F1\uFE0F' },
        {
          id: 'eventrecorder',
          label: 'Event recorder',
          sub: 'Apps, idle & media timeline',
          icon: '\u{1F4CB}',
          badge: eventRecorderStats.eventCount24h > 0 ? eventRecorderStats.eventCount24h : undefined,
        },
        {
          id: 'lockscreen',
          label: 'Lock screen',
          sub: 'Remote system lock (Device Admin)',
          icon: '\u{1F512}',
        },
        { id: 'digests', label: 'Weekly digests', icon: '\u{1F4F0}' },
        { id: 'tcd', label: 'TCD ops', icon: '\u{1FA7A}' },
      ],
    },
  ]

  const sectionTitle: Record<Section, string> = {
    home: 'Home',
    alerts: 'Alerts',
    chat: 'Family chat',
    livemap: 'Live map control center',
    map: 'Map & locations',
    pair: 'Pair a device',
    safety: 'Safety checks',
    whatsapp: 'WhatsApp protection',
    callrecording: 'Call recording',
    photos: 'Photo gallery',
    eventrecorder: 'Event recorder',
    lockscreen: 'Lock screen',
    liveview: 'Live viewing',
    typing: 'Typing safety',
    usage: 'App usage & limits',
    apps: 'Apps',
    geofences: 'Safe zones (geofences)',
    digests: 'Weekly digests',
    guardians: 'Guardians & caregivers',
    tcd: 'Technical control dashboard',
  }

  return (
    <div className="app-shell">
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
      <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden>
            🛡️
          </span>
          <div>
            <p className="brand-name">SareChild</p>
            <p className="brand-sub">Parent dashboard</p>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-group-label">{group.label}</p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={section === item.id ? 'nav-item active' : 'nav-item'}
                  onClick={() => openSection(item.id)}
                >
                  <span className="nav-icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="nav-label">
                    {item.label}
                    {item.sub && <span className="nav-label-sub">{item.sub}</span>}
                  </span>
                  {!!item.badge && <span className="nav-badge">{item.badge}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <p className="muted small sidebar-email">{user?.email}</p>
          <button className="btn ghost compact" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button
            className="hamburger"
            type="button"
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            <span />
            <span />
            <span />
          </button>
          <h1>{sectionTitle[section]}</h1>
          <span className="topbar-spacer" />
        </header>

        {trialInfo && trialInfo.plan === 'trial' && trialInfo.status === 'active' && (
          <div className="banner trial-banner">
            <TrialBannerText trialInfo={trialInfo} />
          </div>
        )}
        {trialInfo && trialInfo.status === 'at_risk' && (
          <div className="banner error-banner">
            We haven't seen a check-in from you in a while — sign in and open the dashboard
            weekly during your trial, or this account may be automatically removed for
            inactivity.
          </div>
        )}
        {error && <div className="banner error-banner">{error}</div>}
        {statusMsg && <div className="banner ok-banner">{statusMsg}</div>}

        <main className={section === 'livemap' ? 'panel panel-flush' : 'panel'}>
          {section === 'home' && (
            <section className="stack">
              {devices.length === 0 ? (
                <Empty
                  title="No child devices yet"
                  body="Open Pair a device, create a code, and enter it on the child phone."
                />
              ) : (
                <>
                  <div className="home-summary">
                    <div>
                      <p className="eyebrow">{devices.length === 1 ? devices[0]!.childName : 'Your family'}</p>
                      <h2>
                        {devices.filter((d) => isDeviceOnline(d, nowTick)).length} of {devices.length} online
                      </h2>
                    </div>
                    {latestUnreadAlert && (
                      <button
                        type="button"
                        className={`home-alert-banner tone-${severityTone(latestUnreadAlert.severity)}`}
                        onClick={() => openSection('alerts')}
                      >
                        <span className="alert-glyph" aria-hidden>
                          {alertIcon(latestUnreadAlert.type)}
                        </span>
                        <span>
                          {latestUnreadAlert.title} · {relativeTime(latestUnreadAlert.createdAtMs)}
                        </span>
                      </button>
                    )}
                  </div>
                  {devices.map((d) => (
                    <DeviceCard
                      key={d.id}
                      device={d}
                      online={isDeviceOnline(d, nowTick)}
                      trail={locationTrail.filter((s) => s.deviceId === d.id).slice(0, 5)}
                      latestAlert={alerts.filter((a) => a.deviceId === d.id).sort((a, b) => b.createdAtMs - a.createdAtMs)[0]}
                      onOpenAlerts={() => openSection('alerts')}
                      onOpenSafety={() => openSection('safety')}
                    />
                  ))}
                </>
              )}
            </section>
          )}

          {section === 'alerts' && (
            <section className="stack">
              <div className="filter-row">
                {(
                  [
                    ['all', `All (${alerts.length})`],
                    ['critical', `Critical (${alerts.filter((a) => severityTone(a.severity) === 'critical' || severityTone(a.severity) === 'high').length})`],
                    ['info', 'Info'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={alertFilter === id ? 'chip active' : 'chip'}
                    onClick={() => setAlertFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {filteredAlerts.length === 0 ? (
                <Empty
                  title={alerts.length === 0 ? 'All quiet — no alerts yet' : 'No alerts in this filter'}
                  body="That's a good thing! Safety alerts from your child's device will show up here."
                />
              ) : (
                filteredAlerts.map((a) => {
                  const device = devices.find((d) => d.id === a.deviceId)
                  const location = a.location ?? device?.lastLocation ?? null
                  return (
                    <article key={a.id} className={`card alert-card tone-${severityTone(a.severity)} ${a.read ? '' : 'unread'}`}>
                      <div className="alert-icon" aria-hidden>
                        {alertIcon(a.type)}
                      </div>
                      <div className="alert-body">
                        <div className="card-head">
                          <h3>{a.title}</h3>
                          {!a.read && <span className="unread-dot" aria-label="Unread" />}
                        </div>
                        <p className="muted small">
                          {alertCategoryLabel(a.type)}
                          {device ? ` · ${device.childName}` : ''} · {relativeTime(a.createdAtMs)}
                        </p>
                        {a.snippet && <p>{a.snippet}</p>}
                        {a.mediaUrl && <AlertMedia url={a.mediaUrl} />}
                        <div className="btn-row">
                          {location && (
                            <a
                              className="btn ghost compact"
                              href={`https://www.google.com/maps?q=${location.lat},${location.lng}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open map
                            </a>
                          )}
                          {!a.read && familyId && (
                            <button
                              className="btn ghost compact"
                              type="button"
                              onClick={() => void repo.markAlertRead(familyId, a.id)}
                            >
                              Mark read
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  )
                })
              )}
            </section>
          )}

          {section === 'chat' && familyId && (
            <ChatSection
              familyId={familyId}
              devices={devices}
              currentUid={user?.uid}
              setError={setError}
            />
          )}

          {section === 'livemap' && familyId && (
            <LiveMapPage
              familyId={familyId}
              devices={devices}
              alerts={alerts}
              geofences={geofences}
              locationTrail={locationTrail}
              nowTick={nowTick}
            />
          )}

          {section === 'map' && (
            <LocationsSection devices={devices} trail={locationTrail} nowTick={nowTick} />
          )}

          {section === 'safety' && (
            <section className="stack">
              <div className="card form-card">
                <h3>Visible safety checks</h3>
                <p className="muted">
                  Each request shows an Accept/Decline screen and an ongoing notification on the child
                  device. This is parental control with disclosure — not a stealth tracker.
                </p>
                <p className="muted small">
                  Not available by design: silent/background call recording, hidden ambient mic/camera,
                  and full WhatsApp/Telegram encrypted database dumps (blocked by Android / Play for
                  third-party apps). Message safety uses notification previews and optional on-screen
                  text with consent.
                </p>
                <h4>Automation & safeguards</h4>
                <label>
                  Escalation risk threshold (0-100)
                  <input
                    value={String(safetySettings.escalationRiskThreshold)}
                    onChange={(e) =>
                      setSafetySettings((s) => ({
                        ...s,
                        escalationRiskThreshold: Number(e.target.value) || 60,
                      }))
                    }
                    inputMode="numeric"
                  />
                </label>
                <label>
                  Check-in interval minutes
                  <input
                    value={String(safetySettings.checkInIntervalMinutes)}
                    onChange={(e) =>
                      setSafetySettings((s) => ({
                        ...s,
                        checkInIntervalMinutes: Number(e.target.value) || 120,
                      }))
                    }
                    inputMode="numeric"
                  />
                </label>
                <label>
                  Alert retention days
                  <input
                    value={String(safetySettings.alertRetentionDays)}
                    onChange={(e) =>
                      setSafetySettings((s) => ({
                        ...s,
                        alertRetentionDays: Number(e.target.value) || 30,
                      }))
                    }
                    inputMode="numeric"
                  />
                </label>
                <label>
                  Media retention days
                  <input
                    value={String(safetySettings.mediaRetentionDays)}
                    onChange={(e) =>
                      setSafetySettings((s) => ({
                        ...s,
                        mediaRetentionDays: Number(e.target.value) || 7,
                      }))
                    }
                    inputMode="numeric"
                  />
                </label>
                <label>
                  Snooze categories (comma-separated)
                  <input
                    value={safetySettings.snoozedCategories.join(',')}
                    onChange={(e) =>
                      setSafetySettings((s) => ({
                        ...s,
                        snoozedCategories: e.target.value
                          .split(',')
                          .map((x) => x.trim())
                          .filter((x) => x.length > 0),
                        snoozeUntilMs: Date.now() + 60 * 60 * 1000,
                      }))
                    }
                  />
                </label>
                <button className="btn ghost" type="button" disabled={busy} onClick={() => void saveSafetySettings()}>
                  Save automation settings
                </button>
              </div>

              {devices.length === 0 ? (
                <Empty title="No devices" body="Pair a child device before requesting safety checks." />
              ) : (
                devices.map((d) => (
                  <article key={d.id} className="card">
                    <div className="card-head">
                      <h3>{d.childName}</h3>
                      <span className={`pill ${isDeviceOnline(d, nowTick) ? 'online' : 'offline'}`}>
                        {isDeviceOnline(d, nowTick) ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    <ul className="meta">
                      <li>Active session: {d.activeSession || 'none'}</li>
                      <li>
                        Consents — screen: {yesNo(d.screenShareConsent)}, camera:{' '}
                        {yesNo(d.cameraCheckConsent)}, mic: {yesNo(d.micCheckConsent)}, messages:{' '}
                        {yesNo(d.messageMonitorConsent)}
                      </li>
                    </ul>
                    <div className="btn-row">
                      <button
                        className="btn ghost compact"
                        type="button"
                        onClick={cycleScreenShareDuration}
                      >
                        Duration: {screenShareDuration} min
                      </button>
                      <button
                        className="btn primary compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCheck(d.id, 'SCREEN_SHARE', screenShareDuration)}
                      >
                        Request screen share ({screenShareDuration}m)
                      </button>
                      <button
                        className="btn primary compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCheck(d.id, 'CAMERA_CHECK')}
                      >
                        Request camera photo
                      </button>
                      <button
                        className="btn primary compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCheck(d.id, 'MIC_CHECK')}
                      >
                        Request voice check
                      </button>
                      <button
                        className="btn primary compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCheck(d.id, 'RING_DEVICE')}
                      >
                        Ring device
                      </button>
                      <button
                        className="btn primary compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCheck(d.id, 'LOCK_DEVICE')}
                      >
                        Lock device
                      </button>
                      <button
                        className="btn primary compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCheck(d.id, 'UNLOCK_DEVICE')}
                      >
                        Unlock device
                      </button>
                      <button
                        className="btn primary compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCheck(d.id, 'SYNC_CALL_SMS')}
                      >
                        Sync call/SMS
                      </button>
                      <button
                        className="btn ghost compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCheck(d.id, 'STOP_SCREEN_SHARE')}
                      >
                        Stop screen share
                      </button>
                    </div>
                  </article>
                ))
              )}

              {screenShareSchedules.length > 0 && (
                <div className="card">
                  <h3>Scheduled screen shares</h3>
                  <ul className="meta">
                    {screenShareSchedules.map((s) => {
                      const name = devices.find((d) => d.id === s.deviceId)?.childName || s.deviceId
                      const h = Math.floor(s.startMinute / 60)
                      const m = s.startMinute % 60
                      return (
                        <li key={s.id}>
                          {s.label} · {name} · {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')} ·{' '}
                          {s.durationMinutes}m{' '}
                          {familyId && (
                            <button
                              className="btn ghost compact"
                              type="button"
                              onClick={() => void repo.deleteScreenShareSchedule(familyId, s.id)}
                            >
                              Remove
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {devices.length > 0 && familyId && (
                <div className="card form-card">
                  <h3>Add scheduled screen share</h3>
                  <label>
                    Device
                    <select
                      value={scheduleDeviceId}
                      onChange={(e) => setScheduleDeviceId(e.target.value)}
                    >
                      {devices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.childName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Label
                    <input value={scheduleLabel} onChange={(e) => setScheduleLabel(e.target.value)} />
                  </label>
                  <label>
                    Start time (HH:MM, 24h)
                    <input value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
                  </label>
                  <label>
                    Days (Sun=1 … Sat=7, comma-separated)
                    <input value={scheduleDays} onChange={(e) => setScheduleDays(e.target.value)} />
                  </label>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const parts = scheduleTime.split(':')
                      if (parts.length !== 2) {
                        setError('Use HH:MM for start time')
                        return
                      }
                      const hour = Number(parts[0])
                      const minute = Number(parts[1])
                      const days = scheduleDays
                        .split(',')
                        .map((x) => Number(x.trim()))
                        .filter((n) => !Number.isNaN(n) && n >= 1 && n <= 7)
                      void repo
                        .addScreenShareSchedule(
                          familyId,
                          scheduleDeviceId,
                          scheduleLabel.trim() || 'Scheduled check',
                          days,
                          hour * 60 + minute,
                          screenShareDuration,
                        )
                        .then(() => setStatusMsg('Schedule saved'))
                        .catch((e) =>
                          setError(e instanceof Error ? e.message : 'Failed to save schedule'),
                        )
                    }}
                  >
                    Save schedule ({screenShareDuration} min)
                  </button>
                </div>
              )}

              {commands.length > 0 && (
                <div className="card">
                  <h3>Recent commands</h3>
                  <ul className="meta">
                    {commands.map((c) => {
                      const name = devices.find((d) => d.id === c.deviceId)?.childName || c.deviceId
                      return (
                        <li key={c.id}>
                          {c.type} · {c.status} · {name} ·{' '}
                          {new Date(c.requestedAtMs).toLocaleString()}
                          {c.resultUrl && (
                            <>
                              {' '}
                              ·{' '}
                              <a href={c.resultUrl} target="_blank" rel="noreferrer">
                                Open result
                              </a>
                            </>
                          )}
                          {c.error && <span className="muted"> — {c.error}</span>}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {galleryItems.length > 0 && (
                <div className="card">
                  <h3>Media gallery</h3>
                  <div className="gallery">
                    {galleryItems.map((item, i) => (
                      <figure key={`${item.url}-${i}`} className="gallery-item">
                        <MediaThumb url={item.url} />
                        <figcaption className="muted small">{item.caption}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {section === 'whatsapp' && (
            <section className="stack">
              {devices.length > 0 && (
                <div className="card">
                  <h3>Select device</h3>
                  <p className="muted small">
                    WhatsApp events are isolated per paired device — choose which child phone to review.
                  </p>
                  <div className="filter-row">
                    {devices.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className={whatsAppDeviceId === d.id ? 'chip active' : 'chip'}
                        onClick={() => setWhatsAppDeviceId(d.id)}
                      >
                        {d.childName}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="card whatsapp-hero">
                <div className="whatsapp-hero-head">
                  <h3>
                    {selectedWhatsAppDevice
                      ? `Messages from: ${selectedWhatsAppDevice.childName}`
                      : 'WhatsApp protection'}
                  </h3>
                  <span className="pill online">Live</span>
                </div>
                <p className="muted">
                  Consent-based monitoring of WhatsApp activity on paired devices. Message bodies are
                  end-to-end encrypted and are never read from WhatsApp&apos;s database — SareChild
                  captures notification previews, on-screen text (with consent), and media files saved
                  to the device&apos;s WhatsApp media folder.
                </p>
                <p className="muted small">
                  Safe-list contacts apply to the whole family (not per device) — activity is still
                  logged but does not trigger alerts. Unknown contacts are monitored and flagged.
                </p>
                {whatsAppIndexFallback && (
                  <p className="muted small whatsapp-index-note">Optimizing filters…</p>
                )}
                <div className="whatsapp-stats">
                  <div className="whatsapp-stat">
                    <span className="whatsapp-stat-num">{whatsAppEvents.length}</span>
                    <span className="whatsapp-stat-label">Events (300 latest)</span>
                  </div>
                  <div className="whatsapp-stat">
                    <span className="whatsapp-stat-num warn">{whatsAppDeviceUnknownCount}</span>
                    <span className="whatsapp-stat-label">From unknown contacts</span>
                  </div>
                  <div className="whatsapp-stat">
                    <span className="whatsapp-stat-num">
                      {whatsAppEvents.filter((e) => e.eventType === 'CALL').length}
                    </span>
                    <span className="whatsapp-stat-label">Calls</span>
                  </div>
                  <div className="whatsapp-stat">
                    <span className="whatsapp-stat-num">
                      {
                        whatsAppEvents.filter((e) =>
                          ['IMAGE', 'VIDEO', 'VOICE_NOTE', 'DOCUMENT'].includes(e.eventType),
                        ).length
                      }
                    </span>
                    <span className="whatsapp-stat-label">Media items</span>
                  </div>
                  <div className="whatsapp-stat">
                    <span className="whatsapp-stat-num">
                      {whatsAppEvents.filter((e) => e.riskFlag).length}
                    </span>
                    <span className="whatsapp-stat-label">Flagged for review</span>
                  </div>
                </div>
              </div>

              {whatsAppSetupStatus && (
                <Empty title={whatsAppSetupStatus.title} body={whatsAppSetupStatus.body} />
              )}

              {selectedWhatsAppDevice && (
                <div className="card">
                  <h3>Device setup — {selectedWhatsAppDevice.childName}</h3>
                  <p className="muted small">
                    This phone must consent and grant notification + accessibility access.
                    Events appear within a minute of the next WhatsApp message.
                  </p>
                  {(() => {
                    const d = selectedWhatsAppDevice
                    const wp = d.whatsappProtection
                    const consent = wp?.consent ?? d.whatsappMonitorConsent
                    const notif = wp?.notificationAccess ?? d.notificationAccess
                    const accessibility = wp?.accessibilityAccess ?? false
                    const media = wp?.mediaPermission ?? d.whatsappMediaPermission
                    const lastEventMs = Math.max(
                      wp?.lastEventAtMs ?? 0,
                      d.lastWhatsAppEventAtMs,
                      whatsAppLastEventByDevice.get(d.id) ?? 0,
                    )
                    const ready = consent && notif
                    return (
                      <div className="whatsapp-device-row">
                        <div className="whatsapp-device-head">
                          <strong>{d.childName}</strong>
                          <span className={`pill ${ready ? 'online' : 'offline'}`}>
                            {ready ? 'Monitoring active' : 'Setup incomplete'}
                          </span>
                        </div>
                        <ul className="meta whatsapp-device-checks">
                          <li>{consent ? '✓' : '✗'} Child consent</li>
                          <li>{notif ? '✓' : '✗'} Notification listener (incoming messages)</li>
                          <li>{accessibility ? '✓' : '✗'} Accessibility (outgoing messages sent by your child)</li>
                          <li>{media ? '✓' : '○'} Media permission (optional)</li>
                          <li>
                            Last event:{' '}
                            {lastEventMs > 0
                              ? new Date(lastEventMs).toLocaleString()
                              : 'None yet — send a test WhatsApp message'}
                          </li>
                        </ul>
                        {consent && notif && !accessibility && (
                          <p className="muted small whatsapp-outgoing-warn">
                            ⚠ Outgoing messages (what your child sends) won&apos;t appear until
                            Accessibility is enabled on their phone — incoming-only otherwise.
                          </p>
                        )}
                        <button
                          className="btn primary compact"
                          type="button"
                          disabled={busy}
                          onClick={() => void requestCheck(d.id, 'REQUEST_WHATSAPP_PROTECTION')}
                        >
                          Request WhatsApp protection
                        </button>
                      </div>
                    )
                  })()}
                </div>
              )}

              {!selectedWhatsAppDevice ? (
                <div className="card">
                  <Empty title="Select a device" body="Choose a paired child phone above to view WhatsApp activity." />
                </div>
              ) : whatsAppEvents.length === 0 ? (
                <div className="card">
                  <Empty
                    title={`No WhatsApp activity from ${selectedWhatsAppDevice.childName} yet`}
                    body="Events appear here once this device has consent, notification access, and (optionally) accessibility enabled. Send a test WhatsApp message on that phone to verify."
                  />
                </div>
              ) : (
                <WhatsAppEventsTable
                  events={whatsAppEvents}
                  deviceName={selectedWhatsAppDevice.childName}
                  typeFilter={whatsAppTypeFilter}
                  onTypeFilterChange={setWhatsAppTypeFilter}
                  deleteEnabled={Boolean(familyId)}
                  onDeleteSelected={async (ids) => {
                    if (!familyId) return
                    await repo.deleteWhatsAppEvents(familyId, ids)
                  }}
                />
              )}

              <div className="card form-card">
                <h3>Safe WhatsApp contacts</h3>
                <p className="muted small">
                  Family-wide safe list — applies to all paired devices. Activity from contacts listed
                  here is still logged (marked safe) and will not generate alerts. Anyone not listed is
                  treated as unknown and fully monitored.
                </p>
                <label>
                  Display label
                  <input value={safeLabel} onChange={(e) => setSafeLabel(e.target.value)} placeholder="Aunt Mary" />
                </label>
                <label>
                  WhatsApp name / handle / phone fragment
                  <input
                    value={safeIdentifier}
                    onChange={(e) => setSafeIdentifier(e.target.value)}
                    placeholder="+15550100 or john_doe"
                  />
                </label>
                <button className="btn primary" type="button" disabled={busy} onClick={() => void submitSafeContact()}>
                  Add safe contact
                </button>
              </div>
              {safeContacts.filter((c) => c.channel === 'WHATSAPP').length > 0 && (
                <div className="card">
                  <h3>Current safe WhatsApp contacts</h3>
                  <ul className="meta">
                    {safeContacts
                      .filter((c) => c.channel === 'WHATSAPP')
                      .map((c) => (
                        <li key={c.id}>
                          {c.label || 'Contact'} — {c.identifier}{' '}
                          {familyId && (
                            <button
                              className="btn ghost compact"
                              type="button"
                              onClick={() => void repo.deleteSafeContact(familyId, c.id)}
                            >
                              Remove
                            </button>
                          )}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {section === 'callrecording' && (
            <section className="stack">
              <div className="card callrecording-hero">
                <div className="callrecording-hero-head">
                  <h3>Call recording</h3>
                  <span className="pill online">Native Android</span>
                </div>
                <p className="muted">
                  Consent-based call monitoring on paired devices. SareChild is a native Kotlin app —{' '}
                  <strong>Cordova plugins (<code>cordova-plugin-callrecorder</code> /{' '}
                  <code>cordova-plugin-callrecorder-cellular</code>) do not apply here.</strong>{' '}
                  We use native <code>MediaRecorder</code>, phone-state callbacks, and notification-assisted
                  VoIP detection instead.
                </p>
                <ul className="muted small callrecording-limits">
                  <li>
                    <strong>Cellular:</strong> best-effort two-way audio when Android allows (often limited on
                    Android 10+). Call events are always logged even when audio capture fails.
                  </li>
                  <li>
                    <strong>VoIP</strong> (WhatsApp, Telegram, Zoom, etc.): mic-side partial recording only while
                    a call notification is active — full two-way VoIP recording is not reliably available on modern
                    Android.
                  </li>
                  <li>
                    <strong>Missed:</strong> ring-without-answer events logged without audio.
                  </li>
                </ul>
                <div className="callrecording-stats">
                  <div className="callrecording-stat">
                    <span className="callrecording-stat-num">{callRecordingStats.total}</span>
                    <span className="callrecording-stat-label">Total recordings</span>
                  </div>
                  <div className="callrecording-stat">
                    <span className="callrecording-stat-num">{callRecordingStats.withAudio}</span>
                    <span className="callrecording-stat-label">With audio</span>
                  </div>
                  <div className="callrecording-stat">
                    <span className="callrecording-stat-num">
                      {Math.floor(callRecordingStats.totalDurationSec / 60)}m
                    </span>
                    <span className="callrecording-stat-label">Total duration</span>
                  </div>
                  <div className="callrecording-stat">
                    <span className="callrecording-stat-num small">
                      {callRecordingStats.lastMs > 0
                        ? new Date(callRecordingStats.lastMs).toLocaleDateString()
                        : '—'}
                    </span>
                    <span className="callrecording-stat-label">Last recording</span>
                  </div>
                </div>
              </div>

              {devices.length > 0 && (
                <div className="card">
                  <h3>Device status</h3>
                  <p className="muted small">
                    Each child phone needs consent, microphone, phone-state (cellular), and notification access
                    (VoIP). Tap Request call recording to send the visible Accept flow with countdown auto-allow.
                  </p>
                  <ul className="callrecording-device-status">
                    {devices.map((d) => {
                      const cr = d.callRecordingStatus
                      const consent = cr?.consent ?? d.callRecordingConsent
                      const enabled = cr?.enabled ?? d.callRecordingEnabled
                      const mic = cr?.micPermission ?? false
                      const phone = cr?.phoneStatePermission ?? false
                      const notif = d.notificationAccess
                      const lastMs = Math.max(cr?.lastRecordingAtMs ?? 0, d.lastCallRecordingAtMs)
                      const ready = consent && enabled && mic
                      return (
                        <li key={d.id} className="callrecording-device-row">
                          <div className="callrecording-device-head">
                            <strong>{d.childName}</strong>
                            <span className={`pill ${ready ? 'online' : 'offline'}`}>
                              {ready ? 'Recording enabled' : 'Setup incomplete'}
                            </span>
                          </div>
                          <ul className="meta callrecording-device-checks">
                            <li>{consent ? '✓' : '✗'} Child consent</li>
                            <li>{enabled ? '✓' : '✗'} Recording enabled</li>
                            <li>{mic ? '✓' : '✗'} Microphone permission</li>
                            <li>{phone ? '✓' : '○'} Phone state (cellular)</li>
                            <li>{notif ? '✓' : '○'} Notification access (VoIP)</li>
                            <li>
                              Last recording:{' '}
                              {lastMs > 0
                                ? new Date(lastMs).toLocaleString()
                                : 'None yet — place a test call'}
                            </li>
                          </ul>
                          <button
                            className="btn primary compact"
                            type="button"
                            disabled={busy}
                            onClick={() => void requestCheck(d.id, 'REQUEST_CALL_RECORDING')}
                          >
                            Request call recording
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="card">
                <h3>Recorded calls</h3>
                <div className="filter-row">
                  {(
                    [
                      ['all', `All (${callRecordings.length})`],
                      ['cellular', 'Cellular'],
                      ['voip', 'VoIP'],
                      ['missed', 'Missed'],
                    ] as [CallRecordingFilter, string][]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={callRecordingFilter === id ? 'chip active' : 'chip'}
                      onClick={() => setCallRecordingFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {filteredCallRecordings.length === 0 ? (
                  <Empty
                    title="No call recordings yet"
                    body="Enable call recording on the child device, grant mic + phone-state permissions, then place a cellular call or WhatsApp voice call. Events appear here within a minute."
                  />
                ) : (
                  <ul className="callrecording-timeline">
                    {filteredCallRecordings.map((rec) => {
                      const name = devices.find((dev) => dev.id === rec.deviceId)?.childName || rec.deviceId
                      const typeLabel =
                        rec.callType === 'CELLULAR'
                          ? 'Cellular'
                          : rec.callType === 'VOIP_PARTIAL'
                            ? 'VoIP (mic partial)'
                            : 'Missed'
                      const contact =
                        rec.numberMasked || rec.contactLabel || rec.packageName || 'Unknown'
                      return (
                        <li key={rec.id} className="callrecording-event">
                          <span className="callrecording-event-icon" aria-hidden="true">
                            {rec.callType === 'CELLULAR'
                              ? '📞'
                              : rec.callType === 'VOIP_PARTIAL'
                                ? '🎧'
                                : '📵'}
                          </span>
                          <div className="callrecording-event-body">
                            <div className="callrecording-event-top">
                              <strong>{contact}</strong>
                              <span className="pill online">{typeLabel}</span>
                              {!rec.audioCaptured && (
                                <span className="pill offline">Event only</span>
                              )}
                              <span className="muted small callrecording-event-time">
                                {new Date(rec.createdAtMs).toLocaleString()}
                              </span>
                            </div>
                            <p className="muted small">
                              {name} · {rec.direction}
                              {rec.durationSec > 0 ? ` · ${rec.durationSec}s` : ''}
                              {rec.audioSourceNote ? ` · ${rec.audioSourceNote}` : ''}
                            </p>
                            {rec.audioUrl && (
                              <figure className="gallery-item callrecording-event-media">
                                <MediaThumb url={rec.audioUrl} />
                              </figure>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </section>
          )}

          {section === 'photos' && (
            <section className="stack">
              <div className="card photos-hero">
                <div className="photos-hero-head">
                  <h3>Photo gallery</h3>
                  <span className="pill online">MediaStore sync</span>
                </div>
                <p className="muted">
                  Thumbnails from your child&apos;s device gallery, synced with their consent. Uses standard Android
                  photo permissions — never &quot;All files access&quot;. On Android 14+, if the child grants{' '}
                  <strong>Selected photos</strong> only, you will see just those unless they choose{' '}
                  <strong>Allow all photos</strong>.
                </p>
                <div className="photos-stats">
                  <div className="photos-stat">
                    <span className="photos-stat-num">{photoStats.count}</span>
                    <span className="photos-stat-label">Synced photos</span>
                  </div>
                  <div className="photos-stat">
                    <span className="photos-stat-num small">
                      {photoStats.lastSyncMs > 0
                        ? new Date(photoStats.lastSyncMs).toLocaleString()
                        : '—'}
                    </span>
                    <span className="photos-stat-label">Last sync</span>
                  </div>
                  <div className="photos-stat">
                    <span className="photos-stat-num small">{photoStats.accessLevel}</span>
                    <span className="photos-stat-label">Access level</span>
                  </div>
                </div>
              </div>

              {devices.length > 0 && (
                <div className="card">
                  <h3>Device selector &amp; status</h3>
                  <div className="filter-row">
                    {devices.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className={photoDeviceId === d.id ? 'chip active' : 'chip'}
                        onClick={() => setPhotoDeviceId(d.id)}
                      >
                        {d.childName}
                      </button>
                    ))}
                  </div>
                  <ul className="photos-device-status">
                    {devices.map((d) => {
                      const pg = d.photoGalleryStatus
                      const consent = pg?.consent ?? d.photoGalleryConsent
                      const permission = pg?.permissionGranted ?? false
                      const access = pg?.accessLevel ?? 'NONE'
                      const lastMs = pg?.lastSyncAtMs ?? 0
                      const count = pg?.photoCount ?? 0
                      const ready = consent && permission
                      return (
                        <li key={d.id} className="photos-device-row">
                          <div className="photos-device-head">
                            <strong>{d.childName}</strong>
                            <span className={`pill ${ready ? 'online' : 'offline'}`}>
                              {ready ? (access === 'PARTIAL' ? 'Partial access' : 'Gallery active') : 'Setup needed'}
                            </span>
                          </div>
                          <ul className="meta photos-device-checks">
                            <li>{consent ? '✓' : '✗'} Child consent</li>
                            <li>{permission ? '✓' : '✗'} Photo permission</li>
                            <li>Access: {access}</li>
                            <li>Photos synced: {count}</li>
                            <li>
                              Last sync:{' '}
                              {lastMs > 0 ? new Date(lastMs).toLocaleString() : 'Never — request access on child phone'}
                            </li>
                          </ul>
                          <div className="row gap">
                            <button
                              className="btn primary compact"
                              type="button"
                              disabled={busy}
                              onClick={() => void requestCheck(d.id, 'REQUEST_PHOTO_ACCESS')}
                            >
                              Request photo access
                            </button>
                            <button
                              className="btn ghost compact"
                              type="button"
                              disabled={busy || !ready}
                              onClick={() => void requestCheck(d.id, 'REQUEST_PHOTO_SYNC')}
                            >
                              Refresh gallery
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="card">
                <h3>Gallery</h3>
                <div className="filter-row photos-filters">
                  <label className="photos-date-filter">
                    <span className="muted small">Filter by date</span>
                    <input
                      type="date"
                      value={photoDateFilter}
                      onChange={(e) => setPhotoDateFilter(e.target.value)}
                    />
                  </label>
                  {photoDateFilter && (
                    <button type="button" className="chip" onClick={() => setPhotoDateFilter('')}>
                      Clear date
                    </button>
                  )}
                </div>

                {filteredPhotos.length === 0 ? (
                  <Empty
                    title="No photos yet"
                    body="Ask your child to Accept photo gallery access on their phone and grant photo library permission. Thumbnails appear here after the first sync (usually within a minute)."
                  />
                ) : (
                  <div className="gallery photos-gallery">
                    {filteredPhotos.map((photo) => {
                      const url = photo.fullUrl || photo.thumbUrl
                      return (
                        <figure key={photo.id} className="gallery-item photos-gallery-item">
                          <button
                            type="button"
                            className="photos-thumb-btn"
                            onClick={() => setSelectedPhoto(photo)}
                            aria-label={`Open ${photo.displayName || 'photo'}`}
                          >
                            {url ? (
                              <img src={url} alt={photo.displayName || 'Synced photo'} loading="lazy" />
                            ) : (
                              <span className="photos-thumb-placeholder">No preview</span>
                            )}
                          </button>
                          <figcaption className="muted small">
                            {photo.displayName || 'Photo'} · {new Date(photo.takenAtMs).toLocaleString()}
                          </figcaption>
                        </figure>
                      )
                    })}
                  </div>
                )}
              </div>

              {selectedPhoto && (
                <div className="photos-lightbox" onClick={() => setSelectedPhoto(null)} role="presentation">
                  <div className="photos-lightbox-inner" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="photos-lightbox-close"
                      aria-label="Close"
                      onClick={() => setSelectedPhoto(null)}
                    >
                      ×
                    </button>
                    {(selectedPhoto.fullUrl || selectedPhoto.thumbUrl) && (
                      <img
                        src={selectedPhoto.fullUrl || selectedPhoto.thumbUrl || ''}
                        alt={selectedPhoto.displayName || 'Photo'}
                      />
                    )}
                    <p className="muted small">
                      {selectedPhoto.displayName} · {selectedPhoto.width}×{selectedPhoto.height} ·{' '}
                      {new Date(selectedPhoto.takenAtMs).toLocaleString()}
                    </p>
                    {(selectedPhoto.fullUrl || selectedPhoto.thumbUrl) && (
                      <a
                        className="btn ghost compact"
                        href={selectedPhoto.fullUrl || selectedPhoto.thumbUrl || '#'}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open full image
                      </a>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {section === 'eventrecorder' && (
            <section className="stack">
              <div className="card eventrecorder-hero">
                <div className="eventrecorder-hero-head">
                  <h3>Event recorder</h3>
                  <span className="pill online">Structured timeline</span>
                </div>
                <p className="muted">
                  Android-only structured activity log from your child&apos;s phone — with their consent.
                  Captures app foreground time, screen on/off, idle periods, YouTube/Spotify titles from
                  media notifications &amp; MediaSession, and best-effort browser page hints when
                  Accessibility is already enabled. This is <strong>not</strong> continuous screen
                  recording or a keylogger.
                </p>
                <div className="eventrecorder-stats">
                  <div className="eventrecorder-stat">
                    <span className="eventrecorder-stat-num">{eventRecorderStats.activeMinutes}m</span>
                    <span className="eventrecorder-stat-label">Active time today</span>
                  </div>
                  <div className="eventrecorder-stat">
                    <span className="eventrecorder-stat-num">{eventRecorderStats.idleMinutes}m</span>
                    <span className="eventrecorder-stat-label">Idle time today</span>
                  </div>
                  <div className="eventrecorder-stat">
                    <span className="eventrecorder-stat-num">{eventRecorderStats.mediaSessions}</span>
                    <span className="eventrecorder-stat-label">Media sessions today</span>
                  </div>
                  <div className="eventrecorder-stat">
                    <span className="eventrecorder-stat-num small">
                      {eventRecorderStats.lastSyncMs > 0
                        ? new Date(eventRecorderStats.lastSyncMs).toLocaleString()
                        : '—'}
                    </span>
                    <span className="eventrecorder-stat-label">Last sync</span>
                  </div>
                </div>
                {eventRecorderStats.topApps.length > 0 && (
                  <p className="muted small">
                    Top apps today:{' '}
                    {eventRecorderStats.topApps.map((a) => `${a.label} (${a.minutes}m)`).join(' · ')}
                  </p>
                )}
              </div>

              <div className="card eventrecorder-help">
                <h3>What this can and cannot do</h3>
                <ul className="meta eventrecorder-help-list">
                  <li>
                    <strong>Can:</strong> log which apps were in the foreground, session durations, screen
                    on/off, idle gaps, YouTube/Spotify titles from notifications &amp; media playback APIs.
                  </li>
                  <li>
                    <strong>Can (optional):</strong> infer browser page titles/URLs when Accessibility is
                    already enabled on the child device — marked as inferred, best-effort only.
                  </li>
                  <li>
                    <strong>Cannot:</strong> record continuous video/screencasts, read encrypted app
                    databases, or enable Accessibility/Usage access without the child granting it in Settings.
                  </li>
                  <li>
                    <strong>Limitations:</strong> Usage history depth varies by OEM (~days on device);
                    browser URLs are heuristic; notification titles may be generic; iOS not supported.
                  </li>
                </ul>
              </div>

              {devices.length > 0 && (
                <div className="card">
                  <h3>Device selector &amp; status</h3>
                  <div className="filter-row">
                    {devices.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className={eventRecorderDeviceId === d.id ? 'chip active' : 'chip'}
                        onClick={() => setEventRecorderDeviceId(d.id)}
                      >
                        {d.childName}
                      </button>
                    ))}
                  </div>
                  <ul className="eventrecorder-device-status">
                    {devices.map((d) => {
                      const er = d.eventRecorderStatus
                      const consent = er?.consent ?? d.eventRecorderConsent
                      const usage = er?.usageAccess ?? false
                      const notif = er?.notificationAccess ?? d.notificationAccess
                      const a11y = er?.accessibilityAccess ?? false
                      const lastMs = er?.lastSyncAtMs ?? 0
                      const ready = consent && usage
                      return (
                        <li key={d.id} className="eventrecorder-device-row">
                          <div className="eventrecorder-device-head">
                            <strong>{d.childName}</strong>
                            <span className={`pill ${ready ? 'online' : 'offline'}`}>
                              {ready ? 'Recording active' : 'Setup needed'}
                            </span>
                          </div>
                          <ul className="meta eventrecorder-device-checks">
                            <li>{consent ? '✓' : '✗'} Child consent</li>
                            <li>{usage ? '✓' : '✗'} Usage access (required)</li>
                            <li>{notif ? '✓' : '○'} Notification access (YouTube/media titles)</li>
                            <li>{a11y ? '✓' : '○'} Accessibility (optional browser hints)</li>
                            <li>Events (24h): {er?.eventCount24h ?? 0}</li>
                            <li>
                              Last sync:{' '}
                              {lastMs > 0 ? new Date(lastMs).toLocaleString() : 'Never — request access on child phone'}
                            </li>
                          </ul>
                          <div className="row gap">
                            <button
                              className="btn primary compact"
                              type="button"
                              disabled={busy}
                              onClick={() => void requestCheck(d.id, 'REQUEST_EVENT_RECORDER_ACCESS')}
                            >
                              Request access
                            </button>
                            <button
                              className="btn ghost compact"
                              type="button"
                              disabled={busy || !ready}
                              onClick={() => void requestCheck(d.id, 'REQUEST_EVENT_RECORDER_SYNC')}
                            >
                              Refresh timeline
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="card">
                <h3>Activity timeline</h3>
                <div className="filter-row eventrecorder-filters">
                  <input
                    type="search"
                    className="eventrecorder-search"
                    placeholder="Search title, URL, details…"
                    value={eventSearch}
                    onChange={(e) => setEventSearch(e.target.value)}
                  />
                  <input
                    type="date"
                    value={eventDateFilter}
                    onChange={(e) => setEventDateFilter(e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Filter by app"
                    value={eventAppFilter}
                    onChange={(e) => setEventAppFilter(e.target.value)}
                  />
                </div>
                <div className="filter-row">
                  {(
                    [
                      'all',
                      'APP_FOREGROUND',
                      'MEDIA_PLAY',
                      'NOTIFICATION_MEDIA',
                      'WEB_VISIT_INFERRED',
                      'IDLE_START',
                      'SCREEN_OFF',
                    ] as const
                  ).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={eventTypeFilter === t ? 'chip active' : 'chip'}
                      onClick={() => setEventTypeFilter(t)}
                    >
                      {t === 'all' ? 'All types' : t.replace(/_/g, ' ').toLowerCase()}
                    </button>
                  ))}
                </div>

                {filteredActivityEvents.length === 0 ? (
                  <Empty
                    title="No activity events yet"
                    body="Ask your child to Accept Event Recorder on their phone and grant Usage access in Android Settings. Optional Notification and Accessibility access improve YouTube titles and browser hints. Events appear here after the first sync."
                  />
                ) : (
                  <div className="table-wrap">
                    <table className="data-table eventrecorder-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Type</th>
                          <th>App</th>
                          <th>Title / details</th>
                          <th>Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredActivityEvents.map((ev) => (
                          <tr key={ev.id}>
                            <td className="nowrap">{new Date(ev.createdAtMs).toLocaleString()}</td>
                            <td>
                              <span className="chip compact">{ev.type.replace(/_/g, ' ')}</span>
                              {ev.inferred && <span className="muted small"> inferred</span>}
                            </td>
                            <td>{ev.appLabel || ev.packageName || '—'}</td>
                            <td>
                              {ev.title && <div>{ev.title}</div>}
                              {ev.url && (
                                <div className="muted small eventrecorder-url">{ev.url}</div>
                              )}
                              {ev.details && <div className="muted small">{ev.details}</div>}
                            </td>
                            <td className="nowrap">
                              {ev.durationMs != null && ev.durationMs > 0
                                ? `${Math.round(ev.durationMs / 60_000)}m`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          )}

          {section === 'lockscreen' && (
            <section className="stack lockscreen-section">
              <div className="card">
                <h3>Remote lock screen</h3>
                <p className="muted">
                  Immediately lock your child&apos;s phone to its <strong>normal system lock screen</strong>{' '}
                  — the PIN, pattern, or fingerprint they already use. This is different from the visible
                  &quot;device locked&quot; safety screen under Safety checks, which stays on until you send
                  Unlock device.
                </p>
              </div>

              <div className="card lockscreen-help">
                <h3>Requirements &amp; honesty</h3>
                <ul className="meta eventrecorder-help-list">
                  <li>
                    <strong>Requires:</strong> Device Administrator enabled on the child phone — Android
                    will show a system confirmation; SareChild cannot enable it silently.
                  </li>
                  <li>
                    <strong>Does:</strong> calls <code>DevicePolicyManager.lockNow()</code> — same as
                    pressing the power button once.
                  </li>
                  <li>
                    <strong>Does not:</strong> change the child&apos;s lock PIN, bypass biometrics, or
                    keep the phone locked after they unlock normally.
                  </li>
                  <li>
                    <strong>If Device Admin is off:</strong> the lock command fails — use &quot;Request
                    Device Admin&quot; so the child can enable it.
                  </li>
                </ul>
              </div>

              {devices.length > 0 && (
                <div className="card">
                  <h3>Device selector &amp; status</h3>
                  <div className="filter-row">
                    {devices.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className={lockScreenDeviceId === d.id ? 'chip active' : 'chip'}
                        onClick={() => setLockScreenDeviceId(d.id)}
                      >
                        {d.childName}
                      </button>
                    ))}
                  </div>
                  <ul className="eventrecorder-device-status">
                    {devices.map((d) => {
                      const ls = d.lockScreenStatus
                      const adminActive = ls?.deviceAdminActive ?? false
                      const lastMs = ls?.lastLockAtMs ?? 0
                      const lastResult = ls?.lastLockResult ?? null
                      const online = isDeviceOnline(d, Date.now())
                      return (
                        <li key={d.id} className="eventrecorder-device-row">
                          <div className="eventrecorder-device-head">
                            <strong>{d.childName}</strong>
                            <span className={`pill ${adminActive ? 'online' : 'offline'}`}>
                              {adminActive ? 'Device Admin on' : 'Setup needed'}
                            </span>
                            {!online && (
                              <span className="pill offline" style={{ marginLeft: 8 }}>
                                Offline
                              </span>
                            )}
                          </div>
                          <ul className="meta eventrecorder-device-checks">
                            <li>{adminActive ? '✓' : '✗'} Device Administrator (required for remote lock)</li>
                            <li>
                              Last locked:{' '}
                              {lastMs > 0 ? new Date(lastMs).toLocaleString() : 'Never'}
                            </li>
                            <li>
                              Last result:{' '}
                              {lastResult === 'success'
                                ? 'Success'
                                : lastResult
                                  ? lastResult
                                  : '—'}
                            </li>
                          </ul>
                          <div className="row gap">
                            <button
                              className="btn primary compact"
                              type="button"
                              disabled={busy || !online}
                              onClick={() => void requestLockScreen(d.id)}
                            >
                              Lock screen now
                            </button>
                            <button
                              className="btn ghost compact"
                              type="button"
                              disabled={busy || !online || adminActive}
                              onClick={() => void requestCheck(d.id, 'REQUEST_DEVICE_ADMIN')}
                            >
                              Request Device Admin
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </section>
          )}

          {section === 'liveview' && familyId && user?.uid && (
            <LiveViewingSection
              familyId={familyId}
              parentUid={user.uid}
              devices={devices}
              quota={liveViewQuota}
              recordings={liveRecordings}
              onError={setError}
              onStatus={setStatusMsg}
            />
          )}

          {section === 'typing' && (
            <section className="stack">
              <div className="card typing-hero">
                <div className="typing-hero-head">
                  <h3>Typing safety — keyboard &amp; message shield</h3>
                  <span className="pill online">Live</span>
                </div>
                <p className="muted">
                  With your child&apos;s consent, SareChild can see words typed in messaging apps —
                  and, if you turn on 360 protection below, other apps too — using the same
                  on-screen-reading permission (Accessibility) screen readers use. It is not a
                  keylogger: there is no per-keystroke capture, no password/PIN fields are ever
                  read, and no app&apos;s encrypted database is touched. Text is captured once a
                  child stops typing for a moment, not while they&apos;re actively typing.
                </p>
                <p className="muted small">
                  This exists so a prohibited-word match still gets caught even when a child uses
                  an app you don&apos;t otherwise monitor closely (Notes, a game chat, a browser).
                  Your child sees a persistent &quot;Protected by SareChild&quot; notice the whole
                  time this is active.
                </p>
                <div className="typing-stats">
                  <div className="typing-stat">
                    <span className="typing-stat-num">{typingEvents.length}</span>
                    <span className="typing-stat-label">Snippets (300 latest)</span>
                  </div>
                  <div className="typing-stat">
                    <span className="typing-stat-num warn">{typingFlaggedCount}</span>
                    <span className="typing-stat-label">Flagged for prohibited words</span>
                  </div>
                  <div className="typing-stat">
                    <span className="typing-stat-num warn">{typingUnreviewedFlaggedCount}</span>
                    <span className="typing-stat-label">Awaiting your review</span>
                  </div>
                  <div className="typing-stat">
                    <span className="typing-stat-num">{typingSettings.mode360 ? 'On' : 'Off'}</span>
                    <span className="typing-stat-label">360 protection (all apps)</span>
                  </div>
                  <div className="typing-stat">
                    <span className="typing-stat-num">{typingSettings.autoBlockEnabled ? 'On' : 'Off'}</span>
                    <span className="typing-stat-label">Auto-block on severe flags</span>
                  </div>
                </div>
              </div>

              {devices.length > 0 && devices.every((d) => !d.messageMonitorConsent) && (
                <Empty
                  title="Typing safety not enabled yet"
                  body="Ask your child to open SareChild, agree to the Typing safety / message shield item during setup, and grant the Accessibility permission. No snippets will appear until consent + permission are both on."
                />
              )}

              {typingAppRiskScores.length > 0 && (
                <div className="card">
                  <h3>Risk score by app</h3>
                  <p className="muted small">
                    Share of captured snippets in each app that matched a prohibited word — a quick
                    way to see which apps deserve the closest look.
                  </p>
                  <ul className="meta">
                    {typingAppRiskScores.map((r) => (
                      <li key={r.packageName}>
                        <strong>{r.label}</strong> ({r.packageName}) · {r.score}% flagged · {r.flagged}/
                        {r.total} snippets
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="card">
                <h3>Timeline</h3>
                <div className="filter-row">
                  {(
                    [
                      ['all', `All (${typingEvents.length})`],
                      ['flagged', `Flagged (${typingFlaggedCount})`],
                      ['unreviewed', `Needs review (${typingUnreviewedFlaggedCount})`],
                    ] as [TypingFilter, string][]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={typingFilter === id ? 'chip active' : 'chip'}
                      onClick={() => setTypingFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {filteredTypingEvents.length === 0 ? (
                  <Empty
                    title="No typing safety snippets yet"
                    body="Snippets appear here as soon as the child device captures a settled text change in a monitored app."
                  />
                ) : (
                  <ul className="typing-timeline">
                    {filteredTypingEvents.map((ev) => {
                      const name = devices.find((d) => d.id === ev.deviceId)?.childName || ev.deviceId
                      const flagged = ev.matchedWords.length > 0
                      return (
                        <li
                          key={ev.id}
                          className={`typing-event ${flagged ? `tone-${severityTone(ev.severity)}` : ''}`}
                        >
                          <span className="typing-event-icon" aria-hidden="true">
                            {flagged ? '\u26A0\uFE0F' : '\u2328\uFE0F'}
                          </span>
                          <div className="typing-event-body">
                            <div className="typing-event-top">
                              <strong>{ev.appLabel}</strong>
                              <span className="pill">{ev.mode === '360' ? '360 mode' : 'Communication'}</span>
                              {flagged && <span className={`pill tone-${severityTone(ev.severity)}`}>{ev.severity}</span>}
                              {flagged && !ev.reviewed && <span className="pill offline">Needs review</span>}
                              <span className="muted small typing-event-time">{relativeTime(ev.createdAtMs)}</span>
                            </div>
                            <p className="muted small">
                              {name} · {ev.packageName}
                            </p>
                            {ev.snippet && <p className="typing-event-preview">&ldquo;{ev.snippet}&rdquo;</p>}
                            {flagged && (
                              <div className="typing-word-badges">
                                {ev.matchedWords.map((w) => (
                                  <span key={w} className="pill offline">
                                    {w}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="btn-row">
                              {flagged && !ev.reviewed && familyId && (
                                <button
                                  className="btn ghost compact"
                                  type="button"
                                  onClick={() => void repo.markTypingEventReviewed(familyId, ev.id)}
                                >
                                  Mark reviewed
                                </button>
                              )}
                              {ev.packageName && (
                                <button
                                  className="btn ghost compact"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void blockAppForTypingEvent(ev)}
                                >
                                  Block this app
                                </button>
                              )}
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              <div className="card form-card">
                <h3>Protection mode</h3>
                <p className="muted small">
                  By default only common messaging/social apps are watched. Turn on 360 protection
                  to watch every foreground app except your whitelist below — useful if your child
                  moves risky chats into an app you wouldn&apos;t normally suspect (a game, a notes
                  app, a browser).
                </p>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={typingSettings.mode360}
                    onChange={(e) => void toggleTypingMode360(e.target.checked)}
                  />
                  360 protection — monitor all apps except system apps and my whitelist
                </label>
              </div>

              <div className="card form-card">
                <h3>Block automatically on severe flags</h3>
                <p className="muted small">
                  Off by default. When on, SareChild blocks the offending app on the child&apos;s
                  device the moment a snippet reaches this severity — you&apos;ll still get the
                  alert either way, and can always block manually from the timeline above instead.
                </p>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={typingSettings.autoBlockEnabled}
                    onChange={(e) => void saveTypingAutoBlock(e.target.checked, typingSettings.autoBlockSeverity)}
                  />
                  Auto-block the app on a severe flag
                </label>
                <label>
                  Minimum severity to auto-block
                  <select
                    value={typingSettings.autoBlockSeverity}
                    onChange={(e) => void saveTypingAutoBlock(typingSettings.autoBlockEnabled, e.target.value)}
                  >
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="CRITICAL">Critical</option>
                  </select>
                </label>
              </div>

              <div className="card form-card">
                <h3>Prohibited words</h3>
                <p className="muted small">
                  These are checked in addition to SareChild&apos;s built-in defaults (violence,
                  self-harm, drugs, sexual content, grooming language). Add anything specific to
                  your family — nicknames, slang, or a name you want flagged.
                </p>
                <label>
                  Add a word or phrase
                  <input
                    value={newProhibitedWord}
                    onChange={(e) => setNewProhibitedWord(e.target.value)}
                    placeholder="e.g. a slang term you want flagged"
                  />
                </label>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy || !familyId}
                  onClick={() => void submitProhibitedWord()}
                >
                  Add word
                </button>
                {typingSettings.prohibitedWords.length > 0 && (
                  <div className="typing-word-badges" style={{ marginTop: '0.75rem' }}>
                    {typingSettings.prohibitedWords.map((w) => (
                      <span key={w} className="pill offline removable">
                        {w}
                        {familyId && (
                          <button type="button" onClick={() => void repo.removeProhibitedWord(familyId, w)}>
                            &times;
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="card form-card">
                <h3>Always-monitor apps</h3>
                <p className="muted small">
                  Beyond the built-in messaging-app list (WhatsApp, Telegram, Messenger, Discord,
                  Snapchat, Instagram, SMS, etc.), add any other app&apos;s package name to always
                  watch it — even with 360 protection off.
                </p>
                <label>
                  Package name
                  <input
                    value={newAlwaysMonitorApp}
                    onChange={(e) => setNewAlwaysMonitorApp(e.target.value)}
                    placeholder="com.example.chatapp"
                  />
                </label>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy || !familyId}
                  onClick={() => void submitAlwaysMonitorApp()}
                >
                  Add app
                </button>
                {typingSettings.alwaysMonitorPackages.length > 0 && (
                  <ul className="meta" style={{ marginTop: '0.75rem' }}>
                    {typingSettings.alwaysMonitorPackages.map((p) => (
                      <li key={p}>
                        {p}{' '}
                        {familyId && (
                          <button
                            className="btn ghost compact"
                            type="button"
                            onClick={() => void repo.removeAlwaysMonitorApp(familyId, p)}
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="card form-card">
                <h3>Whitelist apps (never monitored)</h3>
                <p className="muted small">
                  System keyboards, Settings, and SareChild itself are never monitored regardless of
                  this list. Add anything else you want fully exempt (e.g. a banking app).
                </p>
                <label>
                  Package name
                  <input
                    value={newTypingWhitelistApp}
                    onChange={(e) => setNewTypingWhitelistApp(e.target.value)}
                    placeholder="com.example.bank"
                  />
                </label>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy || !familyId}
                  onClick={() => void submitTypingWhitelistApp()}
                >
                  Add to whitelist
                </button>
                {typingSettings.whitelistPackages.length > 0 && (
                  <ul className="meta" style={{ marginTop: '0.75rem' }}>
                    {typingSettings.whitelistPackages.map((p) => (
                      <li key={p}>
                        {p}{' '}
                        {familyId && (
                          <button
                            className="btn ghost compact"
                            type="button"
                            onClick={() => void repo.removeTypingWhitelistApp(familyId, p)}
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {section === 'apps' && familyId && (
            <AppsSection
              familyId={familyId}
              devices={devices}
              appBlockSchedules={appBlockSchedules}
              usageDaily={usageDaily}
              onError={(msg) => setError(msg)}
            />
          )}

          {section === 'usage' && (
            <section className="stack">
              <div className="card form-card">
                <h3>Add app time limit</h3>
                <label>
                  Device
                  <select value={limitDeviceId} onChange={(e) => setLimitDeviceId(e.target.value)}>
                    {devices.length === 0 && <option value="">No devices</option>}
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.childName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Package name
                  <input
                    value={limitPackage}
                    onChange={(e) => setLimitPackage(e.target.value)}
                    placeholder="com.instagram.android"
                  />
                </label>
                <label>
                  Label
                  <input
                    value={limitLabel}
                    onChange={(e) => setLimitLabel(e.target.value)}
                    placeholder="Instagram"
                  />
                </label>
                <label>
                  Daily limit (minutes)
                  <input
                    value={limitMinutes}
                    onChange={(e) => setLimitMinutes(e.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy || devices.length === 0}
                  onClick={() => void submitAppLimit()}
                >
                  Add limit
                </button>
              </div>

              {appLimits.length > 0 && (
                <div className="card">
                  <h3>App limits</h3>
                  <ul className="meta">
                    {appLimits.map((l) => {
                      const name = devices.find((d) => d.id === l.deviceId)?.childName || l.deviceId
                      return (
                        <li key={l.id}>
                          {l.label || l.packageName} ({l.packageName}) · {l.dailyLimitMinutes} min/day ·{' '}
                          {name}{' '}
                          {familyId && (
                            <button
                              className="btn ghost compact"
                              type="button"
                              onClick={() => void repo.deleteAppLimit(familyId, l.id)}
                            >
                              Remove
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="card form-card">
                <h3>Add scheduled app block</h3>
                <label>
                  Package name
                  <input
                    value={blockPackage}
                    onChange={(e) => setBlockPackage(e.target.value)}
                    placeholder="com.whatsapp"
                  />
                </label>
                <label>
                  Label
                  <input value={blockLabel} onChange={(e) => setBlockLabel(e.target.value)} placeholder="WhatsApp" />
                </label>
                <label>
                  Days (1=Sun ... 7=Sat, comma-separated, blank = every day)
                  <input value={blockDays} onChange={(e) => setBlockDays(e.target.value)} />
                </label>
                <label>
                  Start minute of day
                  <input value={blockStart} onChange={(e) => setBlockStart(e.target.value)} inputMode="numeric" />
                </label>
                <label>
                  End minute of day
                  <input value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} inputMode="numeric" />
                </label>
                <button className="btn primary" type="button" disabled={busy} onClick={() => void submitAppBlock()}>
                  Add scheduled block
                </button>
                <button className="btn ghost" type="button" disabled={busy} onClick={() => void addBlockPresets()}>
                  Add school + bedtime presets for TikTok/WhatsApp/Facebook
                </button>
              </div>

              {appBlockSchedules.length > 0 && (
                <div className="card">
                  <h3>Scheduled app blocks</h3>
                  <ul className="meta">
                    {appBlockSchedules.map((r) => {
                      const name = devices.find((d) => d.id === r.deviceId)?.childName || r.deviceId
                      return (
                        <li key={r.id}>
                          {r.label || r.packageName} ({r.packageName}) · {name} · {r.startMinute}-{r.endMinute} · days:{' '}
                          {r.daysOfWeek.length ? r.daysOfWeek.join(',') : 'all'}{' '}
                          {familyId && (
                            <button
                              className="btn ghost compact"
                              type="button"
                              onClick={() => void repo.deleteAppBlockSchedule(familyId, r.id)}
                            >
                              Remove
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="card form-card">
                <h3>Offline auto-call fallback</h3>
                <p className="muted small">
                  When internet is unavailable, the child app can place best-effort emergency calls to
                  this number. Child must have consented and granted call permission.
                </p>
                <label>
                  Parent number to call
                  <input
                    value={offlineCallNumber}
                    onChange={(e) => setOfflineCallNumber(e.target.value)}
                    placeholder="+1..."
                  />
                </label>
                <label>
                  Max call attempts per offline session (0-10)
                  <input
                    value={offlineCallAttempts}
                    onChange={(e) => setOfflineCallAttempts(e.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <button className="btn primary" type="button" disabled={busy} onClick={() => void saveOfflineCallConfig()}>
                  Save offline auto-call config
                </button>
                {limitDeviceId && (
                  <p className="muted small">
                    Current device setting:{' '}
                    {(() => {
                      const d = devices.find((x) => x.id === limitDeviceId)
                      if (!d) return 'n/a'
                      return `enabled=${d.offlineCallEnabled ? 'yes' : 'no'} number=${d.offlineCallNumber || 'not set'} max=${d.offlineCallMaxAttempts}`
                    })()}
                  </p>
                )}
              </div>

              <div className="card">
                <h3>Screen time by day</h3>
                {usageDaily.length === 0 ? (
                  <p className="muted small">No usage data synced yet.</p>
                ) : (
                  usageDaily.map((u) => {
                    const name = devices.find((d) => d.id === u.deviceId)?.childName || u.deviceId
                    return (
                      <div key={u.id} className="usage-row">
                        <div className="card-head">
                          <h4>
                            {u.day} · {name}
                          </h4>
                          <span className="pill">{u.totalMinutes} min</span>
                        </div>
                        {u.apps.length > 0 && (
                          <ul className="meta">
                            {u.apps
                              .slice()
                              .sort((a, b) => b.minutes - a.minutes)
                              .map((app) => (
                                <li key={app.packageName}>
                                  {app.label || app.packageName}: {app.minutes} min
                                </li>
                              ))}
                          </ul>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </section>
          )}

          {section === 'digests' && (
            <section className="stack">
              {digests.length === 0 ? (
                <Empty
                  title="No digests yet"
                  body="A weekly safety summary is generated automatically every Monday."
                />
              ) : (
                digests.map((d) => (
                  <article key={d.id} className="card">
                    <div className="card-head">
                      <h3>
                        {new Date(d.weekStartMs).toLocaleDateString()} –{' '}
                        {new Date(d.weekEndMs).toLocaleDateString()}
                      </h3>
                      <span className="pill">{d.alertCount} alerts</span>
                    </div>
                    <p>{d.summary}</p>
                    {d.topAlertTypes.length > 0 && (
                      <p className="muted small">Top types: {d.topAlertTypes.join(', ')}</p>
                    )}
                  </article>
                ))
              )}
            </section>
          )}

          {section === 'guardians' && (
            <section className="stack">
              <div className="card form-card">
                <h3>Invite a caregiver</h3>
                <p className="muted">
                  Generates a code that a caregiver can redeem after creating their own SareChild
                  account to get read/monitor access to this family.
                </p>
                <label>
                  Caregiver email
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="caregiver@example.com"
                  />
                </label>
                <button className="btn primary" type="button" disabled={busy} onClick={() => void submitInvite()}>
                  Create invite
                </button>
                {inviteCode && (
                  <div className="code-box">
                    <p className="muted small">Invite code</p>
                    <p className="code">{inviteCode}</p>
                  </div>
                )}
              </div>

              <div className="card form-card">
                <h3>Join a family with an invite code</h3>
                <label>
                  Invite code
                  <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="ABCD1234" />
                </label>
                <button className="btn ghost" type="button" disabled={busy} onClick={() => void submitJoin()}>
                  Join
                </button>
              </div>

              <div className="card">
                <h3>Guardians on this family</h3>
                {guardians.length === 0 ? (
                  <p className="muted small">No guardians yet.</p>
                ) : (
                  <ul className="meta">
                    {guardians.map((g) => (
                      <li key={g.uid}>
                        {g.email || g.uid} · {g.role}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {devices.length > 0 && (
                <div className="card">
                  <h3>Chat access</h3>
                  <p className="muted small">
                    Each paired device has its own private conversation. You (the owner) can always
                    see every device&apos;s chat — check a box below to let a caregiver see and
                    reply in that specific device&apos;s conversation too.
                  </p>
                  {guardians.filter((g) => g.role !== 'OWNER').length === 0 ? (
                    <p className="muted small">Invite a caregiver above to assign chat access.</p>
                  ) : (
                    <ul className="meta guardian-chat-access-list">
                      {devices.map((device) => (
                        <li key={device.id} className="guardian-chat-access-row">
                          <p className="guardian-chat-access-device">{device.childName || 'Child'}</p>
                          <div className="guardian-chat-access-checks">
                            {guardians
                              .filter((g) => g.role !== 'OWNER')
                              .map((g) => {
                                const assigned = device.assignedGuardianUids.includes(g.uid)
                                return (
                                  <label key={g.uid} className="guardian-chat-access-check">
                                    <input
                                      type="checkbox"
                                      checked={assigned}
                                      disabled={!familyId}
                                      onChange={(e) => {
                                        if (!familyId) return
                                        void repo
                                          .setGuardianAssignedToDevice(familyId, device.id, g.uid, e.target.checked)
                                          .catch((err) =>
                                            setError(err instanceof Error ? err.message : 'Failed to update chat access'),
                                          )
                                      }}
                                    />
                                    {g.email || g.uid}
                                  </label>
                                )
                              })}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {section === 'geofences' && (
            <section className="stack">
              <div className="card form-card">
                <h3>Add geofence at child’s last location</h3>
                <label>
                  Zone name
                  <input value={zoneName} onChange={(e) => setZoneName(e.target.value)} />
                </label>
                <label>
                  Radius (meters)
                  <input value={zoneRadius} onChange={(e) => setZoneRadius(e.target.value)} />
                </label>
                <label>
                  Active days (1=Sun … 7=Sat, comma-separated, blank = every day)
                  <input value={zoneDays} onChange={(e) => setZoneDays(e.target.value)} placeholder="2,3,4,5,6" />
                </label>
                <label>
                  Start minute of day (blank = always)
                  <input value={zoneStart} onChange={(e) => setZoneStart(e.target.value)} placeholder="480" />
                </label>
                <label>
                  End minute of day
                  <input value={zoneEnd} onChange={(e) => setZoneEnd(e.target.value)} placeholder="960" />
                </label>
                <button className="btn primary" type="button" disabled={busy} onClick={() => void addGeofence()}>
                  Add geofence
                </button>
              </div>
              {geofences.map((z) => (
                <article key={z.id} className="card row-card">
                  <div>
                    <h3>{z.name}</h3>
                    <p className="muted small">
                      {z.radiusM}m · {z.lat.toFixed(4)}, {z.lng.toFixed(4)}
                    </p>
                    <p className="muted small">
                      {z.daysOfWeek.length > 0 ? `Days: ${z.daysOfWeek.join(',')}` : 'Every day'}
                      {z.startMinute != null && z.endMinute != null
                        ? ` · ${formatMinute(z.startMinute)}–${formatMinute(z.endMinute)}`
                        : ' · All day'}
                    </p>
                  </div>
                  {familyId && (
                    <button
                      className="btn ghost compact"
                      type="button"
                      onClick={() => void repo.deleteGeofence(familyId, z.id)}
                    >
                      Delete
                    </button>
                  )}
                </article>
              ))}
            </section>
          )}

          {section === 'pair' && (
            <section className="stack">
              <div className="card form-card">
                <h3>Generate pairing code</h3>
                <p className="muted">
                  Enter this code on the SareChild child app. Codes expire in 30 minutes.
                </p>
                <label>
                  Child name
                  <input
                    value={childName}
                    onChange={(e) => setChildName(e.target.value)}
                    placeholder="Child"
                  />
                </label>
                <button className="btn primary" type="button" disabled={busy} onClick={() => void createCode()}>
                  Create pairing code
                </button>
                {pairingCode && (
                  <div className="code-box">
                    <p className="muted small">Pairing code</p>
                    <p className="code">{pairingCode}</p>
                  </div>
                )}
              </div>

              <div className="card">
                <h3>Your paired devices</h3>
                <p className="muted small">
                  Removing a device permanently deletes its location history, photos, WhatsApp
                  events, call recordings, activity timeline, and every other record tied to it.
                  This cannot be undone.
                </p>
                {devices.length === 0 && <p className="muted">No devices paired yet.</p>}
                <ul className="meta device-manage-list">
                  {devices.map((device) => (
                    <li key={device.id} className="device-manage-row">
                      <div className="device-manage-row-main">
                        <span>{device.childName || 'Child'}</span>
                        <span className={`pill ${device.online ? 'online' : 'offline'}`}>
                          {device.online ? 'Online' : 'Offline'}
                        </span>
                        {removeDeviceId !== device.id && (
                          <button
                            className="btn ghost compact danger"
                            type="button"
                            onClick={() => openRemoveDevice(device.id)}
                          >
                            Remove device
                          </button>
                        )}
                      </div>
                      {removeDeviceId === device.id && (
                        <div className="device-remove-confirm">
                          <p className="error">
                            This permanently deletes <strong>{device.childName || 'this device'}</strong>
                            &apos;s location history, photos, WhatsApp events, call recordings,
                            usage, alerts, and every other record. It cannot be undone. The device
                            will also be unpaired automatically.
                          </p>
                          <label>
                            Type &quot;{requiredRemoveConfirmText(device.childName)}&quot; to confirm
                            <input
                              value={removeConfirmText}
                              onChange={(e) => setRemoveConfirmText(e.target.value)}
                              placeholder={requiredRemoveConfirmText(device.childName)}
                            />
                          </label>
                          {removeError && <p className="error">{removeError}</p>}
                          <div className="device-remove-actions">
                            <button
                              className="btn danger"
                              type="button"
                              disabled={removeBusy}
                              onClick={() => void confirmRemoveDevice(device)}
                            >
                              {removeBusy ? 'Removing…' : 'Permanently delete device'}
                            </button>
                            <button
                              className="btn ghost compact"
                              type="button"
                              disabled={removeBusy}
                              onClick={cancelRemoveDevice}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="card form-card">
                <h3>SOS contacts</h3>
                <p className="muted">
                  Shown to guardians in the SOS alert when the child presses the SOS button.
                </p>
                <label>
                  Name
                  <input value={sosName} onChange={(e) => setSosName(e.target.value)} placeholder="Mom" />
                </label>
                <label>
                  Phone note
                  <input
                    value={sosPhone}
                    onChange={(e) => setSosPhone(e.target.value)}
                    placeholder="555-0100 (or how to reach them)"
                  />
                </label>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy}
                  onClick={() => void submitSosContact()}
                >
                  Add contact
                </button>
              </div>

              {sosContacts.length > 0 && (
                <div className="card">
                  <h3>Current SOS contacts</h3>
                  <ul className="meta">
                    {sosContacts.map((c) => (
                      <li key={c.id}>
                        {c.name} — {c.phoneNote || 'no note'}{' '}
                        {familyId && (
                          <button
                            className="btn ghost compact"
                            type="button"
                            onClick={() => void repo.deleteSosContact(familyId, c.id)}
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="card form-card">
                <h3>Safe WhatsApp contacts</h3>
                <p className="muted small">
                  Unidentified WhatsApp contacts not listed here will trigger alerts.
                </p>
                <label>
                  Display label
                  <input value={safeLabel} onChange={(e) => setSafeLabel(e.target.value)} placeholder="Aunt Mary" />
                </label>
                <label>
                  WhatsApp name / handle / phone fragment
                  <input
                    value={safeIdentifier}
                    onChange={(e) => setSafeIdentifier(e.target.value)}
                    placeholder="+15550100 or john_doe"
                  />
                </label>
                <button className="btn primary" type="button" disabled={busy} onClick={() => void submitSafeContact()}>
                  Add safe contact
                </button>
              </div>
              {safeContacts.filter((c) => c.channel === 'WHATSAPP').length > 0 && (
                <div className="card">
                  <h3>Current safe WhatsApp contacts</h3>
                  <ul className="meta">
                    {safeContacts
                      .filter((c) => c.channel === 'WHATSAPP')
                      .map((c) => (
                        <li key={c.id}>
                          {c.label || 'Contact'} — {c.identifier}{' '}
                          {familyId && (
                            <button
                              className="btn ghost compact"
                              type="button"
                              onClick={() => void repo.deleteSafeContact(familyId, c.id)}
                            >
                              Remove
                            </button>
                          )}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {section === 'tcd' && (
            <section className="stack">
              <div className="card form-card">
                <h3>Technical Control Dashboard (TCD)</h3>
                <p className="muted small">
                  Runs live checks for Firestore connectivity, child heartbeat freshness, alerts stream
                  health, and Cloudflare R2 proxy reachability.
                </p>
                <p className="muted small">
                  Dedicated monitor app link: <a href="/SareChild/tcd.html" target="_blank" rel="noreferrer">open standalone TCD</a>
                </p>
                <div className="btn-row">
                  <button className="btn primary" type="button" disabled={busy} onClick={() => void runTcdCheck()}>
                    Run health check
                  </button>
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => void runTcdRepair()}>
                    Run auto-repair
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>Live fleet status (real-time)</h3>
                  <span className="muted small">{new Date(liveFleet.generatedAtMs).toLocaleTimeString()}</span>
                </div>
                <p className="muted small">
                  Pushed straight from Firestore listeners — no click or reload needed.
                </p>
                <ul className="meta">
                  <li>Registered devices: {liveFleet.registeredDevices}</li>
                  <li>Online devices: {liveFleet.onlineDevices}</li>
                  <li>Offline devices: {liveFleet.offlineDevices}</li>
                  <li>Guardians registered: {liveFleet.guardians}</li>
                  <li>Alerts in last 24h: {liveFleet.alertsLast24h}</li>
                  <li>Critical alerts in last 24h: {liveFleet.criticalAlertsLast24h}</li>
                  <li>Pending commands: {liveFleet.pendingCommands}</li>
                </ul>
              </div>

              {tcdReport && (
                <div className="card">
                  <div className="card-head">
                    <h3>Latest report</h3>
                    <span className="muted small">{new Date(tcdReport.generatedAtMs).toLocaleString()}</span>
                  </div>
                  <ul className="meta">
                    {tcdReport.checks.map((check) => (
                      <li key={check.id}>
                        <span className={`pill tcd-${check.status}`}>{check.status.toUpperCase()}</span>{' '}
                        <strong>{check.label}:</strong> {check.message}
                        {check.latencyMs != null ? ` (${check.latencyMs} ms)` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {tcdOverview && (
                <div className="card">
                  <div className="card-head">
                    <h3>Fleet and application health</h3>
                    <span className="muted small">{new Date(tcdOverview.generatedAtMs).toLocaleString()}</span>
                  </div>
                  <ul className="meta">
                    <li>Registered devices: {tcdOverview.registeredDevices}</li>
                    <li>Online devices: {tcdOverview.onlineDevices}</li>
                    <li>Offline devices: {tcdOverview.offlineDevices}</li>
                    <li>Guardians registered: {tcdOverview.guardians}</li>
                    <li>Alerts in last 24h: {tcdOverview.alertsLast24h}</li>
                    <li>Critical alerts in last 24h: {tcdOverview.criticalAlertsLast24h}</li>
                    <li>Pending commands: {tcdOverview.pendingCommands}</li>
                    <li>
                      Edge cache source: {tcdOverview.edgeSource || 'n/a'}
                      {tcdOverview.edgeLatencyMs != null ? ` (${tcdOverview.edgeLatencyMs} ms)` : ''}
                    </li>
                    <li>
                      Latest heartbeat:{' '}
                      {tcdOverview.latestHeartbeatMs > 0
                        ? new Date(tcdOverview.latestHeartbeatMs).toLocaleString()
                        : 'No heartbeat recorded'}
                    </li>
                  </ul>
                </div>
              )}

              {repairLog.length > 0 && (
                <div className="card">
                  <h3>Last auto-repair actions</h3>
                  <ul className="meta">
                    {repairLog.map((line, idx) => (
                      <li key={`${line}-${idx}`}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}

              {!tcdReport && (
                <Empty
                  title="No report yet"
                  body="Press Run health check to generate a live status report for this family."
                />
              )}

              {isProjectAdmin(user) && (
                <div className="card">
                  <div className="card-head">
                    <h3>Parent accounts (admin)</h3>
                    <button className="btn ghost compact" type="button" disabled={busy} onClick={() => void loadAdminAccounts()}>
                      Refresh list
                    </button>
                  </div>
                  <p className="muted small">
                    Project-owner view of registered parent profiles across all families.
                  </p>
                  {adminAccountsError && <p className="error">{adminAccountsError}</p>}
                  {adminAccounts && adminAccounts.length === 0 && (
                    <p className="muted small">No parent profiles found.</p>
                  )}
                  {adminAccounts && adminAccounts.length > 0 && (
                    <div className="wa-table-wrap">
                      <table className="wa-table">
                        <thead>
                          <tr>
                            <th>Email</th>
                            <th>Registered</th>
                            <th>Last active</th>
                            <th>Family</th>
                            <th>Devices</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminAccounts.map((row) => (
                            <tr key={row.uid}>
                              <td>{row.email || row.uid.slice(0, 8)}</td>
                              <td>
                                {row.registeredAt ? new Date(row.registeredAt).toLocaleDateString() : '—'}
                              </td>
                              <td>
                                {row.lastActiveAt ? new Date(row.lastActiveAt).toLocaleString() : '—'}
                              </td>
                              <td className="small">{row.familyId ?? '—'}</td>
                              <td>{row.deviceCount ?? '—'}</td>
                              <td>{row.status ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  )
}

function TrialBannerText({ trialInfo }: { trialInfo: import('../types').TrialInfo }) {
  const daysLeft = Math.max(0, Math.ceil((trialInfo.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
  return (
    <span>
      Free trial — {daysLeft} day{daysLeft === 1 ? '' : 's'} left with full access. Paid plans are
      coming later; no card required for now.
    </span>
  )
}

function yesNo(v: boolean) {
  return v ? 'yes' : 'no'
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60) % 24
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function MediaThumb({ url }: { url: string }) {
  const kind = mediaKind(url)
  if (kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt="Media" />
      </a>
    )
  }
  if (kind === 'audio') {
    return <audio controls src={url} />
  }
  return (
    <a className="btn ghost compact" href={url} target="_blank" rel="noreferrer">
      Open media
    </a>
  )
}

function AlertMedia({ url }: { url: string }) {
  const kind = mediaKind(url)
  if (kind === 'image') {
    return (
      <div className="frame-preview">
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt="Alert media" />
        </a>
      </div>
    )
  }
  if (kind === 'audio') {
    return <audio controls src={url} className="alert-audio" />
  }
  return (
    <a className="btn ghost compact" href={url} target="_blank" rel="noreferrer">
      Open media
    </a>
  )
}

function isDeviceOnline(device: DeviceStatus, nowMs: number): boolean {
  return device.lastHeartbeatMs > 0 && nowMs - device.lastHeartbeatMs < WENT_DARK_AFTER_MS
}

const GOOGLE_MAPS_BROWSER_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim()

function staticMapThumbUrl(lat: number, lng: number, size: 'small' | 'large' = 'small'): string | null {
  if (!GOOGLE_MAPS_BROWSER_KEY) return null
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: size === 'large' ? '14' : '15',
    size: size === 'large' ? '640x320' : '360x180',
    scale: '2',
    maptype: 'roadmap',
    markers: `color:red|${lat},${lng}`,
    key: GOOGLE_MAPS_BROWSER_KEY,
  })
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`
}

/** Full-page map & locations overview — one bigger map card per paired device. */
function LocationsSection({
  devices,
  trail,
  nowTick,
}: {
  devices: DeviceStatus[]
  trail: LocationTrailSample[]
  nowTick: number
}) {
  if (devices.length === 0) {
    return (
      <section className="stack">
        <Empty title="No devices yet" body="Pair a child device to see their location here." />
      </section>
    )
  }
  return (
    <section className="stack">
      {devices.map((d) => (
        <LocationCard key={d.id} device={d} online={isDeviceOnline(d, nowTick)} trail={trail.filter((s) => s.deviceId === d.id).slice(0, 8)} />
      ))}
    </section>
  )
}

function LocationCard({
  device,
  online,
  trail,
}: {
  device: DeviceStatus
  online: boolean
  trail: LocationTrailSample[]
}) {
  const [address, setAddress] = useState<string | null>(null)
  const [mapFailed, setMapFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!device.lastLocation) {
      setAddress(null)
      return
    }
    void reverseGeocode(device.lastLocation.lat, device.lastLocation.lng).then((result) => {
      if (!cancelled) setAddress(result)
    })
    return () => {
      cancelled = true
    }
  }, [device.lastLocation?.lat, device.lastLocation?.lng])

  const mapsUrl = device.lastLocation
    ? `https://www.google.com/maps?q=${device.lastLocation.lat},${device.lastLocation.lng}`
    : null
  const thumbUrl = device.lastLocation ? staticMapThumbUrl(device.lastLocation.lat, device.lastLocation.lng, 'large') : null
  useEffect(() => {
    setMapFailed(false)
  }, [thumbUrl])

  return (
    <article className="card location-card">
      <div className="card-head">
        <h3>{device.childName}</h3>
        <span className={`pill ${online ? 'online' : 'offline'}`}>{online ? 'Online' : 'Offline'}</span>
      </div>
      {thumbUrl && !mapFailed ? (
        <a href={mapsUrl ?? undefined} target="_blank" rel="noreferrer" className="map-thumb map-thumb-large">
          <img
            src={thumbUrl}
            alt={`Map for ${device.childName}`}
            loading="lazy"
            onError={() => setMapFailed(true)}
          />
        </a>
      ) : (
        <div className="map-thumb map-thumb-placeholder map-thumb-large">
          <span aria-hidden>📍</span>
          <span>
            {!device.lastLocation
              ? 'Waiting for first location…'
              : mapFailed
                ? 'Map preview unavailable — see raw coordinates below'
                : 'Map preview unavailable (no Maps API key configured)'}
          </span>
        </div>
      )}
      {address && (
        <p className="address-line">
          <span aria-hidden>📍 </span>
          {address}
        </p>
      )}
      {device.lastLocation && (
        <p className="muted small">
          Raw coordinates: {device.lastLocation.lat.toFixed(5)}, {device.lastLocation.lng.toFixed(5)}
          {device.lastLocation.updatedAtMs ? ` · updated ${relativeTime(device.lastLocation.updatedAtMs)}` : ''}
        </p>
      )}
      {mapsUrl && (
        <a className="btn primary compact" href={mapsUrl} target="_blank" rel="noreferrer">
          Open in Google Maps
        </a>
      )}
      {trail.length > 0 && (
        <details className="battery-history">
          <summary className="muted small">Recent timeline points ({trail.length})</summary>
          <ul className="meta">
            {trail.map((s) => (
              <li key={s.id}>
                {new Date(s.recordedAtMs).toLocaleString()} ·{' '}
                {s.location ? `${s.location.lat.toFixed(5)}, ${s.location.lng.toFixed(5)}` : 'n/a'}
                {!s.hadNetwork ? ' · captured offline' : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  )
}

/** Family chat — one isolated thread per paired device at
 *  families/{id}/devices/{deviceId}/chatMessages. The right sidebar lists every device with an
 *  unread badge; selecting a device loads only that device's conversation, so pairing another
 *  device never merges the two conversations together. Guardians only see devices the parent has
 *  assigned to them (managed from the Guardians tab; enforced in firestore.rules). */
function ChatSection({
  familyId,
  devices,
  currentUid,
  setError,
}: {
  familyId: string
  devices: DeviceStatus[]
  currentUid: string | undefined
  setError: (msg: string | null) => void
}) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [messages, setMessages] = useState<FamilyChatMessage[]>([])
  const [unreadByDevice, setUnreadByDevice] = useState<Record<string, number>>({})
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const recordStartRef = useRef(0)

  const deviceIdsKey = devices.map((d) => d.id).join(',')

  useEffect(() => {
    if ((!selectedDeviceId || !devices.some((d) => d.id === selectedDeviceId)) && devices.length > 0) {
      setSelectedDeviceId(devices[0]!.id)
    }
  }, [devices, selectedDeviceId])

  useEffect(() => {
    if (!selectedDeviceId) {
      setMessages([])
      return
    }
    return repo.observeDeviceChat(familyId, selectedDeviceId, setMessages, (e) => setError(e.message))
  }, [familyId, selectedDeviceId])

  useEffect(() => {
    if (!selectedDeviceId) return
    void repo.markDeviceChatRead(familyId, selectedDeviceId)
  }, [familyId, selectedDeviceId, messages.length])

  useEffect(() => {
    if (!deviceIdsKey) {
      setUnreadByDevice({})
      return
    }
    const ids = deviceIdsKey.split(',')
    const unsubs = ids.map((id) =>
      repo.observeDeviceChatUnreadCount(familyId, id, (count) =>
        setUnreadByDevice((prev) => ({ ...prev, [id]: count })),
      ),
    )
    return () => unsubs.forEach((u) => u())
  }, [familyId, deviceIdsKey])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId)

  const sendText = async () => {
    if (!selectedDeviceId || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await repo.sendDeviceChatMessage(familyId, selectedDeviceId, { text })
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send message')
    } finally {
      setBusy(false)
    }
  }

  const sendMedia = async (
    blob: Blob,
    fileName: string,
    mediaType: 'image' | 'audio',
    durationMs?: number,
  ) => {
    if (!selectedDeviceId) return
    setBusy(true)
    setError(null)
    try {
      const { path, url } = await repo.uploadChatMedia(familyId, selectedDeviceId, blob, fileName)
      await repo.sendDeviceChatMessage(familyId, selectedDeviceId, {
        mediaUrl: url,
        mediaPath: path,
        mediaType,
        durationMs: durationMs ?? null,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send attachment')
    } finally {
      setBusy(false)
    }
  }

  const toggleRecording = async () => {
    if (recording) {
      mediaRecorderRef.current?.stop()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      recordedChunksRef.current = []
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordedChunksRef.current.push(ev.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const durationMs = Date.now() - recordStartRef.current
        const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' })
        setRecording(false)
        if (blob.size > 0) void sendMedia(blob, `voice_${Date.now()}.webm`, 'audio', durationMs)
      }
      recordStartRef.current = Date.now()
      mediaRecorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch {
      setError('Microphone access is required to record a voice note.')
    }
  }

  return (
    <section className="chat-shell-wrap">
      <section className="chat-shell">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Private chat with</p>
            <h2>{selectedDevice ? selectedDevice.childName : 'Select a device'}</h2>
          </div>
          <button
            type="button"
            className="btn ghost compact chat-sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            {sidebarOpen ? 'Hide devices \u203A' : '\u2039 Devices'}
          </button>
        </header>
        <div className="chat-scroll">
          {!selectedDeviceId ? (
            <Empty title="No child devices yet" body="Pair a device to start a private conversation with it." />
          ) : messages.length === 0 ? (
            <Empty
              title="No messages yet"
              body={`Send a warm check-in to ${selectedDevice?.childName || 'this device'} — this conversation is private to this device only.`}
            />
          ) : (
            messages.map((m) => {
              const mine = m.senderUid === currentUid
              return (
                <div key={m.id} className={mine ? 'chat-row mine' : 'chat-row'}>
                  <div className={mine ? 'chat-bubble mine' : 'chat-bubble'}>
                    <p className="chat-sender">
                      {m.senderName}
                      {m.senderRole === 'CHILD' ? ' · child' : ''}
                    </p>
                    {m.text && <p className="chat-text">{m.text}</p>}
                    {m.mediaUrl && <ChatMedia url={m.mediaUrl} type={m.mediaType} durationMs={m.durationMs} />}
                    <p className="chat-time">{new Date(m.createdAtMs).toLocaleString()}</p>
                  </div>
                </div>
              )
            })
          )}
          <div ref={bottomRef} />
        </div>
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && text.trim()) void sendText()
          }}
        >
          <input
            type="file"
            accept="image/*"
            ref={fileInputRef}
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void sendMedia(file, file.name, 'image')
            }}
          />
          <button
            type="button"
            className="btn ghost compact chat-icon-btn"
            title="Send a photo"
            disabled={busy || !selectedDeviceId}
            onClick={() => fileInputRef.current?.click()}
          >
            {'\u{1F4F7}'}
          </button>
          <button
            type="button"
            className={recording ? 'btn primary compact chat-icon-btn recording' : 'btn ghost compact chat-icon-btn'}
            title={recording ? 'Stop recording' : 'Record a voice note'}
            disabled={!selectedDeviceId}
            onClick={() => void toggleRecording()}
          >
            {recording ? '\u23F9' : '\u{1F3A4}'}
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={selectedDevice ? `Message ${selectedDevice.childName}…` : 'Select a device to chat with…'}
            disabled={busy || !selectedDeviceId}
          />
          <button className="btn primary compact" type="submit" disabled={busy || !text.trim() || !selectedDeviceId}>
            Send
          </button>
        </form>
      </section>
      {sidebarOpen && (
        <aside className="chat-devices-sidebar">
          <p className="chat-devices-title">Devices</p>
          {devices.length === 0 ? (
            <p className="muted small">Pair a device to start chatting.</p>
          ) : (
            devices.map((d) => {
              const unread = unreadByDevice[d.id] || 0
              const active = d.id === selectedDeviceId
              return (
                <button
                  key={d.id}
                  type="button"
                  className={active ? 'chat-device-row active' : 'chat-device-row'}
                  onClick={() => setSelectedDeviceId(d.id)}
                >
                  <span className={d.online ? 'chat-device-dot online' : 'chat-device-dot'} />
                  <span className="chat-device-name">{d.childName}</span>
                  {unread > 0 && <span className="chat-device-badge">{unread > 99 ? '99+' : unread}</span>}
                </button>
              )
            })
          )}
        </aside>
      )}
    </section>
  )
}

function ChatMedia({
  url,
  type,
  durationMs,
}: {
  url: string
  type?: string | null
  durationMs?: number | null
}) {
  const kind = type === 'image' || type === 'audio' || type === 'video' ? type : mediaKind(url)
  if (kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img className="chat-media-img" src={url} alt="Shared media" />
      </a>
    )
  }
  if (kind === 'audio') {
    return (
      <div className="chat-media-audio-wrap">
        <audio controls src={url} className="chat-media-audio" />
        {durationMs ? <span className="chat-media-duration">{formatChatDuration(durationMs)}</span> : null}
      </div>
    )
  }
  if (kind === 'video') {
    return (
      <div className="chat-media-video-wrap">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video controls src={url} className="chat-media-video" />
        {durationMs ? <span className="chat-media-duration">{formatChatDuration(durationMs)}</span> : null}
      </div>
    )
  }
  return (
    <a className="btn ghost compact" href={url} target="_blank" rel="noreferrer">
      Open media
    </a>
  )
}

function formatChatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function DeviceCard({
  device,
  online,
  trail,
  latestAlert,
  onOpenAlerts,
  onOpenSafety,
}: {
  device: DeviceStatus
  online: boolean
  trail: LocationTrailSample[]
  latestAlert?: FamilyAlert
  onOpenAlerts: () => void
  onOpenSafety: () => void
}) {
  const mapsUrl = device.lastLocation
    ? `https://www.google.com/maps?q=${device.lastLocation.lat},${device.lastLocation.lng}`
    : null
  const thumbUrl = device.lastLocation
    ? staticMapThumbUrl(device.lastLocation.lat, device.lastLocation.lng)
    : null
  const [address, setAddress] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [mapFailed, setMapFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!device.lastLocation) {
      setAddress(null)
      return
    }
    void reverseGeocode(device.lastLocation.lat, device.lastLocation.lng).then((result) => {
      if (!cancelled) setAddress(result)
    })
    return () => {
      cancelled = true
    }
  }, [device.lastLocation?.lat, device.lastLocation?.lng])

  useEffect(() => {
    setMapFailed(false)
  }, [thumbUrl])

  return (
    <article className="card device-card">
      <div className="card-head">
        <h3>{device.childName}</h3>
        <span className={`pill ${online ? 'online' : 'offline'}`}>
          {online ? 'Online' : 'Offline / went dark'}
        </span>
      </div>
      <p className="muted small">
        Battery: {device.batteryPercent >= 0 ? `${device.batteryPercent}%` : '—'}
        {device.charging ? ' (charging)' : ''} · Screen time today: {device.todayScreenMinutes} min
      </p>

      {thumbUrl && !mapFailed ? (
        <a href={mapsUrl ?? undefined} target="_blank" rel="noreferrer" className="map-thumb">
          <img
            src={thumbUrl}
            alt={`Map thumbnail for ${device.childName}`}
            loading="lazy"
            onError={() => setMapFailed(true)}
          />
        </a>
      ) : (
        <div className="map-thumb map-thumb-placeholder">
          <span aria-hidden>📍</span>
          <span>
            {!device.lastLocation
              ? 'Waiting for first location…'
              : mapFailed
                ? 'Map preview unavailable — use "Open map" below'
                : 'Map preview unavailable (no Maps API key configured)'}
          </span>
        </div>
      )}
      {address && (
        <p className="address-line">
          <span aria-hidden>📍 </span>
          {address}
        </p>
      )}

      {latestAlert && (
        <button type="button" className={`mini-alert-row tone-${severityTone(latestAlert.severity)}`} onClick={onOpenAlerts}>
          <span aria-hidden>{alertIcon(latestAlert.type)}</span>
          <span>
            {latestAlert.title} · {relativeTime(latestAlert.createdAtMs)}
          </span>
        </button>
      )}

      <div className="btn-row">
        {mapsUrl && (
          <a className="btn primary compact" href={mapsUrl} target="_blank" rel="noreferrer">
            Open map
          </a>
        )}
        <button className="btn ghost compact" type="button" onClick={onOpenSafety}>
          Safety checks
        </button>
      </div>

      <button type="button" className="details-toggle" onClick={() => setShowDetails((v) => !v)}>
        {showDetails ? 'Hide details' : 'Show more details'}
      </button>
      {showDetails && (
        <ul className="meta">
          <li>Monitoring: {device.monitoringActive ? 'on' : 'off'}</li>
          <li>Session: {device.activeSession || 'none'}</li>
          <li>Notification access: {device.notificationAccess ? 'yes' : 'no'}</li>
          <li>Location permission: {device.locationPermission ? 'yes' : 'no'}</li>
          <li>
            Consents — screen: {yesNo(device.screenShareConsent)}, camera:{' '}
            {yesNo(device.cameraCheckConsent)}, mic: {yesNo(device.micCheckConsent)}, messages:{' '}
            {yesNo(device.messageMonitorConsent)}, installs: {yesNo(device.installMonitorConsent)},
            usage: {yesNo(device.usageConsent)}, call/SMS: {yesNo(device.callSmsConsent)}, offline SMS
            fallback: {yesNo(device.offlineSmsFallbackConsent)}, offline auto-call:{' '}
            {yesNo(device.offlineAutoCallConsent)}
          </li>
          {device.lastLocation && (
            <li>
              Raw coordinates: {device.lastLocation.lat.toFixed(5)}, {device.lastLocation.lng.toFixed(5)}
            </li>
          )}
        </ul>
      )}
      {device.batteryHistory.length > 0 && (
        <details className="battery-history">
          <summary className="muted small">Battery history ({device.batteryHistory.length})</summary>
          <ul className="meta">
            {device.batteryHistory
              .slice()
              .reverse()
              .map((s, i) => (
                <li key={`${s.atMs}-${i}`}>
                  {new Date(s.atMs).toLocaleString()}: {s.percent}%{s.charging ? ' (charging)' : ''}
                </li>
              ))}
          </ul>
        </details>
      )}
      {device.latestFrameUrl && (
        <div className="frame-preview">
          <p className="muted small">Latest screen frame</p>
          <a href={device.latestFrameUrl} target="_blank" rel="noreferrer">
            <img src={device.latestFrameUrl} alt={`Latest frame from ${device.childName}`} />
          </a>
        </div>
      )}
      {trail.length > 0 && (
        <details className="battery-history">
          <summary className="muted small">Recent timeline points (offline-capable)</summary>
          <ul className="meta">
            {trail.map((s) => (
              <li key={s.id}>
                {new Date(s.recordedAtMs).toLocaleString()} ·{' '}
                {s.location ? `${s.location.lat.toFixed(5)}, ${s.location.lng.toFixed(5)}` : 'n/a'}
                {!s.hadNetwork ? ' · captured offline' : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {mapsUrl && (
        <a className="btn ghost compact" href={mapsUrl} target="_blank" rel="noreferrer">
          Open in Maps
        </a>
      )}
    </article>
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p className="muted">{body}</p>
    </div>
  )
}
