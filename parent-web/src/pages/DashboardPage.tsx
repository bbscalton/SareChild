import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../AuthContext'
import * as repo from '../lib/parentRepo'
import { WENT_DARK_AFTER_MS } from '../firebase'
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
  SafeContact,
  SafetyCommand,
  ScreenShareSchedule,
  SosContact,
  TcdReport,
  TcdOverview,
  TypingSafetyEvent,
  TypingSafetySettings,
  UsageDaily,
  WeeklyDigest,
  WhatsAppEvent,
  WhatsAppEventType,
} from '../types'
import { mediaKind } from '../types'
import type { SafetyCommandType } from '../lib/parentRepo'
import { alertCategoryLabel, alertIcon, relativeTime, severityTone } from '../lib/alertPresentation'
import { reverseGeocode } from '../lib/googleMaps'
import { LiveMapPage } from './LiveMapPage'

type Section =
  | 'home'
  | 'alerts'
  | 'chat'
  | 'livemap'
  | 'map'
  | 'pair'
  | 'safety'
  | 'whatsapp'
  | 'typing'
  | 'usage'
  | 'geofences'
  | 'digests'
  | 'guardians'
  | 'tcd'
type AlertFilter = 'all' | 'critical' | 'info'
type WhatsAppFilter = 'all' | 'messages' | 'calls' | 'media' | 'voice' | 'video' | 'unknown'
type TypingFilter = 'all' | 'flagged' | 'unreviewed'

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
  const [whatsAppEvents, setWhatsAppEvents] = useState<WhatsAppEvent[]>([])
  const [whatsAppFilter, setWhatsAppFilter] = useState<WhatsAppFilter>('all')
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
  const [chatMessages, setChatMessages] = useState<FamilyChatMessage[]>([])
  const [chatText, setChatText] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
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
  const [repairLog, setRepairLog] = useState<string[]>([])

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
      repo.observeWhatsAppEvents(familyId, setWhatsAppEvents, (e) => setError(e.message)),
      repo.observeTypingSafetyEvents(familyId, setTypingEvents, (e) => setError(e.message)),
      repo.observeTypingSafetySettings(familyId, setTypingSettings, (e) => setError(e.message)),
      repo.observeSafetySettings(familyId, setSafetySettings, (e) => setError(e.message)),
      repo.observeScreenShareSchedules(familyId, setScreenShareSchedules, (e) => setError(e.message)),
      repo.observeFamilyChat(familyId, setChatMessages, (e) => setError(e.message)),
    ]
    return () => unsubs.forEach((u) => u())
  }, [familyId])

  useEffect(() => {
    if (!limitDeviceId && devices.length > 0) setLimitDeviceId(devices[0]!.id)
    if (!scheduleDeviceId && devices.length > 0) setScheduleDeviceId(devices[0]!.id)
    if (devices.length > 0 && !offlineCallNumber) {
      setOfflineCallNumber(devices[0]!.offlineCallNumber || '')
      setOfflineCallAttempts(String(devices[0]!.offlineCallMaxAttempts || 2))
    }
  }, [devices, limitDeviceId, scheduleDeviceId])

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
    () => whatsAppEvents.filter((e) => !e.contactSafe).length,
    [whatsAppEvents],
  )

  const whatsAppLastEventByDevice = useMemo(() => {
    const map = new Map<string, number>()
    for (const ev of whatsAppEvents) {
      const prev = map.get(ev.deviceId) ?? 0
      if (ev.createdAtMs > prev) map.set(ev.deviceId, ev.createdAtMs)
    }
    return map
  }, [whatsAppEvents])

  const whatsAppSetupStatus = useMemo(() => {
    if (devices.length === 0) return null
    const statuses = devices.map((d) => d.whatsappProtection)
    const anyEnabled = statuses.some((s) => s?.enabled)
    if (anyEnabled) return null
    const missingConsent = devices.every(
      (d) => !(d.whatsappProtection?.consent ?? d.whatsappMonitorConsent),
    )
    if (missingConsent) {
      return {
        title: 'WhatsApp protection not enabled yet',
        body: 'Tap "Request WhatsApp protection" below — your child will see a visible Accept screen with steps to enable notification access and accessibility.',
      }
    }
    const missingNotif = devices.some((d) => !(d.whatsappProtection?.notificationAccess ?? d.notificationAccess))
    if (missingNotif) {
      return {
        title: 'Notification access needed',
        body: 'WhatsApp protection is consented on the device but notification access is off. On the child phone: SareChild → Review permissions → Open notification access settings → enable SareChild.',
      }
    }
    const missingMedia = devices.some((d) => !(d.whatsappProtection?.mediaPermission ?? d.whatsappMediaPermission))
    if (missingMedia) {
      return {
        title: 'WhatsApp media permission missing',
        body: 'Messages and calls can still be captured from notifications. For photos, videos, and voice notes, grant WhatsApp media access on the child device (Review permissions → step 8).',
      }
    }
    return {
      title: 'Waiting for child heartbeat',
      body: 'WhatsApp protection was just enabled — status updates on the next device heartbeat (within a few minutes). Send a test WhatsApp message to verify events appear.',
    }
  }, [devices])

  const filteredWhatsAppEvents = useMemo(() => {
    if (whatsAppFilter === 'all') return whatsAppEvents
    if (whatsAppFilter === 'unknown') return whatsAppEvents.filter((e) => !e.contactSafe)
    const typeMap: Record<Exclude<WhatsAppFilter, 'all' | 'unknown'>, WhatsAppEventType[]> = {
      messages: ['MESSAGE', 'UNKNOWN_CONTACT'],
      calls: ['CALL'],
      media: ['IMAGE', 'DOCUMENT'],
      voice: ['VOICE_NOTE'],
      video: ['VIDEO'],
    }
    const types = typeMap[whatsAppFilter as Exclude<WhatsAppFilter, 'all' | 'unknown'>]
    return whatsAppEvents.filter((e) => types.includes(e.eventType))
  }, [whatsAppEvents, whatsAppFilter])

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
      setStatusMsg('Request sent — the child must Accept on their phone (visible prompt + notification).')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send request')
    } finally {
      setBusy(false)
    }
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
        })
        await repo.addAppBlockSchedule(familyId, {
          packageName: app.packageName,
          label: `${app.label} (Bedtime)`,
          deviceId: limitDeviceId,
          daysOfWeek: [],
          startMinute: 21 * 60,
          endMinute: 6 * 60 + 30,
          active: true,
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

  const sendChatMessage = async () => {
    if (!familyId || !chatText.trim()) return
    setChatBusy(true)
    setError(null)
    try {
      await repo.sendFamilyChatMessage(familyId, chatText)
      setChatText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send message')
    } finally {
      setChatBusy(false)
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
        { id: 'usage', label: 'Usage & limits', icon: '\u23F1\uFE0F' },
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
    typing: 'Typing safety',
    usage: 'App usage & limits',
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

          {section === 'chat' && (
            <ChatSection
              messages={chatMessages}
              currentUid={user?.uid}
              text={chatText}
              onTextChange={setChatText}
              onSend={() => void sendChatMessage()}
              busy={chatBusy}
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
              <div className="card whatsapp-hero">
                <div className="whatsapp-hero-head">
                  <h3>WhatsApp protection</h3>
                  <span className="pill online">Live</span>
                </div>
                <p className="muted">
                  Consent-based monitoring of WhatsApp activity on paired devices. Message bodies are
                  end-to-end encrypted and are never read from WhatsApp&apos;s database — SareChild
                  captures notification previews, on-screen text (with consent), and media files saved
                  to the device&apos;s WhatsApp media folder.
                </p>
                <p className="muted small">
                  Safe-list contacts are still logged (marked safe) but do not trigger alerts.
                  Unknown contacts are monitored and flagged for your review.
                </p>
                <div className="whatsapp-stats">
                  <div className="whatsapp-stat">
                    <span className="whatsapp-stat-num">{whatsAppEvents.length}</span>
                    <span className="whatsapp-stat-label">Events (300 latest)</span>
                  </div>
                  <div className="whatsapp-stat">
                    <span className="whatsapp-stat-num warn">{whatsAppUnknownCount}</span>
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

              {devices.length > 0 && (
                <div className="card">
                  <h3>Device setup status</h3>
                  <p className="muted small">
                    Each child phone must consent and grant notification + accessibility access.
                    Events appear within a minute of the next WhatsApp message.
                  </p>
                  <ul className="whatsapp-device-status">
                    {devices.map((d) => {
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
                        <li key={d.id} className="whatsapp-device-row">
                          <div className="whatsapp-device-head">
                            <strong>{d.childName}</strong>
                            <span className={`pill ${ready ? 'online' : 'offline'}`}>
                              {ready ? 'Monitoring active' : 'Setup incomplete'}
                            </span>
                          </div>
                          <ul className="meta whatsapp-device-checks">
                            <li>{consent ? '✓' : '✗'} Child consent</li>
                            <li>{notif ? '✓' : '✗'} Notification listener</li>
                            <li>{accessibility ? '✓' : '✗'} Accessibility (on-screen text)</li>
                            <li>{media ? '✓' : '○'} Media permission (optional)</li>
                            <li>
                              Last event:{' '}
                              {lastEventMs > 0
                                ? new Date(lastEventMs).toLocaleString()
                                : 'None yet — send a test WhatsApp message'}
                            </li>
                          </ul>
                          <button
                            className="btn primary compact"
                            type="button"
                            disabled={busy}
                            onClick={() => void requestCheck(d.id, 'REQUEST_WHATSAPP_PROTECTION')}
                          >
                            Request WhatsApp protection
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="card">
                <h3>Timeline</h3>
                <div className="filter-row">
                  {(
                    [
                      ['all', `All (${whatsAppEvents.length})`],
                      ['messages', 'Messages'],
                      ['calls', 'Calls'],
                      ['media', 'Media'],
                      ['voice', 'Voice notes'],
                      ['video', 'Video'],
                      ['unknown', `Unknown only (${whatsAppUnknownCount})`],
                    ] as [WhatsAppFilter, string][]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={whatsAppFilter === id ? 'chip active' : 'chip'}
                      onClick={() => setWhatsAppFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {filteredWhatsAppEvents.length === 0 ? (
                  <Empty
                    title="No WhatsApp activity yet"
                    body="Events appear here once the child device has consent, notification access, and (optionally) accessibility enabled. Send a test WhatsApp message to verify."
                  />
                ) : (
                  <ul className="whatsapp-timeline">
                    {filteredWhatsAppEvents.map((ev) => {
                      const name = devices.find((d) => d.id === ev.deviceId)?.childName || ev.deviceId
                      return (
                        <li
                          key={ev.id}
                          className={`whatsapp-event ${ev.riskFlag ? 'whatsapp-event-risk' : ''}`}
                        >
                          <span className="whatsapp-event-icon" aria-hidden="true">
                            {whatsAppEventIcon(ev.eventType)}
                          </span>
                          <div className="whatsapp-event-body">
                            <div className="whatsapp-event-top">
                              <strong>{ev.contactLabel}</strong>
                              <span className={`pill ${ev.contactSafe ? 'online' : 'offline'}`}>
                                {ev.contactSafe ? 'Safe list' : 'Unknown'}
                              </span>
                              {ev.riskFlag && <span className="pill offline">Review</span>}
                              <span className="muted small whatsapp-event-time">
                                {new Date(ev.createdAtMs).toLocaleString()}
                              </span>
                            </div>
                            <p className="muted small">
                              {name} · {whatsAppEventLabel(ev.eventType)} · {ev.direction}
                              {ev.durationSec != null && ev.durationSec > 0
                                ? ` · ${Math.round(ev.durationSec)}s`
                                : ''}
                            </p>
                            {ev.preview && <p className="whatsapp-event-preview">&ldquo;{ev.preview}&rdquo;</p>}
                            {ev.mediaUrl && (
                              <figure className="gallery-item whatsapp-event-media">
                                <MediaThumb url={ev.mediaUrl} />
                              </figure>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              <div className="card form-card">
                <h3>Safe WhatsApp contacts</h3>
                <p className="muted small">
                  Activity from contacts listed here is still logged (marked safe) and will not
                  generate alerts. Anyone not listed is treated as unknown and fully monitored.
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

function whatsAppEventIcon(t: WhatsAppEventType): string {
  switch (t) {
    case 'MESSAGE':
    case 'UNKNOWN_CONTACT':
      return '\u{1F4AC}'
    case 'CALL':
      return '\u{1F4DE}'
    case 'IMAGE':
      return '\u{1F5BC}\uFE0F'
    case 'VOICE_NOTE':
      return '\u{1F3A4}'
    case 'VIDEO':
      return '\u{1F3A5}'
    case 'DOCUMENT':
      return '\u{1F4CE}'
    default:
      return '\u{1F7E2}'
  }
}

function whatsAppEventLabel(t: WhatsAppEventType): string {
  switch (t) {
    case 'MESSAGE':
      return 'Message'
    case 'UNKNOWN_CONTACT':
      return 'New unknown contact'
    case 'CALL':
      return 'Call'
    case 'IMAGE':
      return 'Image'
    case 'VOICE_NOTE':
      return 'Voice note'
    case 'VIDEO':
      return 'Video'
    case 'DOCUMENT':
      return 'File'
    default:
      return t
  }
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

/** Family chat — mirrors the Android family chat collection (families/{id}/familyChat). */
function ChatSection({
  messages,
  currentUid,
  text,
  onTextChange,
  onSend,
  busy,
}: {
  messages: FamilyChatMessage[]
  currentUid: string | undefined
  text: string
  onTextChange: (v: string) => void
  onSend: () => void
  busy: boolean
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  return (
    <section className="chat-shell">
      <div className="chat-scroll">
        {messages.length === 0 ? (
          <Empty title="No messages yet" body="Send a warm check-in — your family chat is shared with every guardian and child device." />
        ) : (
          messages.map((m) => {
            const mine = m.senderUid === currentUid
            return (
              <div key={m.id} className={mine ? 'chat-row mine' : 'chat-row'}>
                <div className={mine ? 'chat-bubble mine' : 'chat-bubble'}>
                  <p className="chat-sender">{m.senderName}{m.senderRole === 'CHILD' ? ' · child' : ''}</p>
                  {m.text && <p className="chat-text">{m.text}</p>}
                  {m.mediaUrl && <ChatMedia url={m.mediaUrl} />}
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
          if (!busy && text.trim()) onSend()
        }}
      >
        <input
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="Send a message to your family…"
          disabled={busy}
        />
        <button className="btn primary compact" type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </section>
  )
}

function ChatMedia({ url }: { url: string }) {
  const kind = mediaKind(url)
  if (kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img className="chat-media-img" src={url} alt="Shared media" />
      </a>
    )
  }
  if (kind === 'audio') {
    return <audio controls src={url} className="chat-media-audio" />
  }
  return (
    <a className="btn ghost compact" href={url} target="_blank" rel="noreferrer">
      Open media
    </a>
  )
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
