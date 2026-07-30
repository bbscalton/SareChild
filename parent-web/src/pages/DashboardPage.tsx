import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../AuthContext'
import * as repo from '../lib/parentRepo'
import type {
  AppBlockSchedule,
  AppLimit,
  DeviceStatus,
  FamilyAlert,
  FamilySafetySettings,
  GeofenceZone,
  GuardianInfo,
  LocationTrailSample,
  SafeContact,
  SafetyCommand,
  ScreenShareSchedule,
  SosContact,
  TcdReport,
  UsageDaily,
  WeeklyDigest,
} from '../types'
import { mediaKind } from '../types'
import type { SafetyCommandType } from '../lib/parentRepo'

type Tab = 'devices' | 'alerts' | 'safety' | 'usage' | 'digests' | 'guardians' | 'geofences' | 'pair' | 'tcd'

export function DashboardPage() {
  const { user, familyId, signOut, refreshFamilyId } = useAuth()
  const [tab, setTab] = useState<Tab>('devices')
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
      repo.observeSafetySettings(familyId, setSafetySettings, (e) => setError(e.message)),
      repo.observeScreenShareSchedules(familyId, setScreenShareSchedules, (e) => setError(e.message)),
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
      const report = await repo.runTcdHealthCheck(familyId)
      setTcdReport(report)
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
      const report = await repo.runTcdHealthCheck(familyId)
      setTcdReport(report)
      setStatusMsg('Auto-repair completed and health re-checked.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run auto-repair')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dash">
      <header className="topbar">
        <div>
          <p className="eyebrow">SareChild</p>
          <h1>Parent dashboard</h1>
          <p className="muted small">{user?.email}</p>
        </div>
        <button className="btn ghost" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      {error && <div className="banner error-banner">{error}</div>}
      {statusMsg && <div className="banner ok-banner">{statusMsg}</div>}

      <nav className="tabs">
        {(
          [
            ['devices', 'Devices'],
            ['alerts', `Alerts${unread ? ` (${unread})` : ''}`],
            ['safety', 'Safety checks'],
            ['usage', 'Usage'],
            ['digests', 'Digests'],
            ['guardians', 'Guardians'],
            ['geofences', 'Geofences'],
            ['pair', 'Pair'],
            ['tcd', 'TCD Ops'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'tab active' : 'tab'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="panel">
        {tab === 'devices' && (
          <section className="stack">
            {devices.length === 0 ? (
              <Empty
                title="No child devices yet"
                body="Open the Pair tab, create a code, and enter it on the child phone."
              />
            ) : (
              devices.map((d) => (
                <DeviceCard
                  key={d.id}
                  device={d}
                  trail={locationTrail.filter((s) => s.deviceId === d.id).slice(0, 5)}
                />
              ))
            )}
          </section>
        )}

        {tab === 'alerts' && (
          <section className="stack">
            {alerts.length === 0 ? (
              <Empty title="No alerts yet" body="Safety alerts from the child device will appear here." />
            ) : (
              alerts.map((a) => (
                <article key={a.id} className={`card ${a.read ? '' : 'unread'}`}>
                  <div className="card-head">
                    <h3>{a.title}</h3>
                    <span className={`pill sev-${a.severity.toLowerCase()}`}>{a.severity}</span>
                  </div>
                  <p className="muted small">
                    {a.type}
                    {a.category ? ` · ${a.category}` : ''} ·{' '}
                    {new Date(a.createdAtMs).toLocaleString()}
                  </p>
                  {a.snippet && <p>{a.snippet}</p>}
                  {a.riskScore != null && a.riskScore > 0 && (
                    <p className="muted small">Risk score: {a.riskScore}</p>
                  )}
                  {a.mediaUrl && <AlertMedia url={a.mediaUrl} />}
                  {!a.read && familyId && (
                    <button
                      className="btn ghost compact"
                      type="button"
                      onClick={() => void repo.markAlertRead(familyId, a.id)}
                    >
                      Mark read
                    </button>
                  )}
                </article>
              ))
            )}
          </section>
        )}

        {tab === 'safety' && (
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
                    <span className={`pill ${d.online ? 'online' : 'offline'}`}>
                      {d.online ? 'Online' : 'Offline'}
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

        {tab === 'usage' && (
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

        {tab === 'digests' && (
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

        {tab === 'guardians' && (
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

        {tab === 'geofences' && (
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

        {tab === 'pair' && (
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

        {tab === 'tcd' && (
          <section className="stack">
            <div className="card form-card">
              <h3>Technical Control Dashboard (TCD)</h3>
              <p className="muted small">
                Runs live checks for Firestore connectivity, child heartbeat freshness, alerts stream
                health, and Cloudflare R2 proxy reachability.
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
                    </li>
                  ))}
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

function DeviceCard({ device, trail }: { device: DeviceStatus; trail: LocationTrailSample[] }) {
  const mapsUrl = device.lastLocation
    ? `https://www.google.com/maps?q=${device.lastLocation.lat},${device.lastLocation.lng}`
    : null

  return (
    <article className="card">
      <div className="card-head">
        <h3>{device.childName}</h3>
        <span className={`pill ${device.online ? 'online' : 'offline'}`}>
          {device.online ? 'Online' : 'Offline / went dark'}
        </span>
      </div>
      <ul className="meta">
        <li>
          Battery: {device.batteryPercent >= 0 ? `${device.batteryPercent}%` : '—'}
          {device.charging ? ' (charging)' : ''}
        </li>
        <li>Screen time today: {device.todayScreenMinutes} min</li>
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
            Last location: {device.lastLocation.lat.toFixed(5)},{' '}
            {device.lastLocation.lng.toFixed(5)}
          </li>
        )}
      </ul>
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
