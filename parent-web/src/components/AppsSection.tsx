import { useEffect, useMemo, useState } from 'react'
import type { AppBlockSchedule, DeviceStatus, InstalledApp, UsageDaily } from '../types'
import * as repo from '../lib/parentRepo'
import { BlockAppModal, formatDays, minutesToTime } from './BlockAppModal'

type Tab = 'list' | 'blocked' | 'usage'

type Props = {
  familyId: string
  devices: DeviceStatus[]
  appBlockSchedules: AppBlockSchedule[]
  usageDaily: UsageDaily[]
  onError: (msg: string) => void
}

const PAGE_SIZES = [10, 25, 50, 100] as const

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function AppsSection({
  familyId,
  devices,
  appBlockSchedules,
  usageDaily,
  onError,
}: Props) {
  const [tab, setTab] = useState<Tab>('list')
  const [deviceId, setDeviceId] = useState('')
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
  const [search, setSearch] = useState('')
  const [pageSize, setPageSize] = useState<number>(25)
  const [page, setPage] = useState(0)
  const [syncBusy, setSyncBusy] = useState(false)
  const [blockTarget, setBlockTarget] = useState<InstalledApp | null>(null)
  const [editSchedule, setEditSchedule] = useState<AppBlockSchedule | null>(null)

  const effectiveDeviceId = deviceId || devices[0]?.id || ''

  useEffect(() => {
    if (!familyId || !effectiveDeviceId) {
      setInstalledApps([])
      return
    }
    return repo.observeInstalledApps(familyId, effectiveDeviceId, setInstalledApps, (e) => onError(e.message))
  }, [familyId, effectiveDeviceId])

  const blockedForDevice = useMemo(
    () => appBlockSchedules.filter((s) => s.deviceId === effectiveDeviceId && s.active),
    [appBlockSchedules, effectiveDeviceId],
  )

  const blockedPackages = useMemo(
    () => new Set(blockedForDevice.map((s) => s.packageName)),
    [blockedForDevice],
  )

  const listRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return installedApps
      .filter((a) => a.deviceId === effectiveDeviceId)
      .filter((a) => {
        if (!q) return true
        return [a.name, a.packageName, a.versionName].join(' ').toLowerCase().includes(q)
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [installedApps, effectiveDeviceId, search])

  const usageRows = useMemo(() => {
    const latest = usageDaily
      .filter((u) => u.deviceId === effectiveDeviceId)
      .sort((a, b) => b.day.localeCompare(a.day))[0]
    return latest?.apps ?? []
  }, [usageDaily, effectiveDeviceId])

  const totalPages = Math.max(1, Math.ceil(listRows.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const pageRows = listRows.slice(safePage * pageSize, safePage * pageSize + pageSize)

  async function refreshInventory() {
    if (!effectiveDeviceId) return
    setSyncBusy(true)
    try {
      await repo.requestAppInventory(familyId, effectiveDeviceId)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to request inventory sync')
    } finally {
      setSyncBusy(false)
    }
  }

  async function saveBlock(input: {
    label: string
    packageName: string
    daysOfWeek: number[]
    startMinute: number
    endMinute: number
    message: string
  }) {
    try {
      if (editSchedule) {
        await repo.updateAppBlockSchedule(familyId, editSchedule.id, {
          ...input,
          active: true,
        })
      } else {
        await repo.addAppBlockSchedule(familyId, {
          ...input,
          deviceId: effectiveDeviceId,
          active: true,
          createdAtMs: Date.now(),
        })
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to save block schedule')
      throw e
    }
  }

  const deviceLabel = devices.find((d) => d.id === effectiveDeviceId)?.childName || effectiveDeviceId

  return (
    <section className="stack apps-section">
      <div className="card wa-table-card">
        <div className="wa-table-header">
          <h3>APPS</h3>
          <div className="wa-table-toolbar">
            <label className="wa-page-size">
              Device{' '}
              <select
                value={effectiveDeviceId}
                onChange={(e) => {
                  setDeviceId(e.target.value)
                  setPage(0)
                }}
              >
                {devices.length === 0 && <option value="">No devices</option>}
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.childName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn ghost compact"
              disabled={syncBusy || !effectiveDeviceId}
              onClick={() => void refreshInventory()}
            >
              {syncBusy ? 'Syncing…' : 'Refresh inventory'}
            </button>
          </div>
        </div>

        <div className="filter-row wa-type-chips">
          {(
            [
              { id: 'list' as Tab, label: 'List' },
              { id: 'blocked' as Tab, label: 'Blocked' },
              { id: 'usage' as Tab, label: 'Usage' },
            ] as const
          ).map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={tab === chip.id ? 'chip active' : 'chip'}
              onClick={() => setTab(chip.id)}
            >
              {chip.label}
              {chip.id === 'blocked' && blockedForDevice.length > 0 ? ` (${blockedForDevice.length})` : ''}
            </button>
          ))}
        </div>

        {tab === 'list' && (
          <>
            <div className="wa-table-toolbar apps-list-toolbar">
              <label className="wa-page-size">
                Show{' '}
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value))
                    setPage(0)
                  }}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>{' '}
                entries
              </label>
              <input
                className="wa-search"
                type="search"
                placeholder="Search apps…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(0)
                }}
              />
            </div>
            <div className="wa-table-scroll">
              <table className="wa-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Package</th>
                    <th>Version</th>
                    <th>Size</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="wa-empty-cell">
                        {devices.length === 0
                          ? 'Pair a child device first.'
                          : 'No apps synced yet — tap Refresh inventory on the child device.'}
                      </td>
                    </tr>
                  ) : (
                    pageRows.map((app) => (
                      <tr key={app.id}>
                        <td className="wa-col-name">
                          <strong>{app.name}</strong>
                        </td>
                        <td className="mono small">{app.packageName}</td>
                        <td>{app.versionName || app.versionCode || '—'}</td>
                        <td>{formatBytes(app.apkSizeBytes)}</td>
                        <td>{formatDate(app.lastUpdateTime || app.firstInstallTime)}</td>
                        <td>
                          <span className="wa-badge wa-badge-in">INSTALLED</span>
                          {blockedPackages.has(app.packageName) && (
                            <span className="pill offline compact">Blocked</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn ghost compact"
                            title="Block app"
                            onClick={() => {
                              setEditSchedule(null)
                              setBlockTarget(app)
                            }}
                          >
                            + Block
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {listRows.length > pageSize && (
              <div className="wa-pagination">
                <button
                  type="button"
                  className="btn ghost compact"
                  disabled={safePage <= 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </button>
                <span className="muted small">
                  Page {safePage + 1} of {totalPages} · {listRows.length} apps on {deviceLabel}
                </span>
                <button
                  type="button"
                  className="btn ghost compact"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}

        {tab === 'blocked' && (
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Schedule</th>
                  <th>Days</th>
                  <th>Message</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {blockedForDevice.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="wa-empty-cell">
                      No block schedules for {deviceLabel}. Use List → + Block on an app.
                    </td>
                  </tr>
                ) : (
                  blockedForDevice.map((rule) => (
                    <tr key={rule.id}>
                      <td className="wa-col-name">
                        <strong>{rule.label || rule.packageName}</strong>
                        <div className="mono small">{rule.packageName}</div>
                      </td>
                      <td>
                        {minutesToTime(rule.startMinute)} – {minutesToTime(rule.endMinute)}
                      </td>
                      <td>{formatDays(rule.daysOfWeek)}</td>
                      <td className="small">{rule.message}</td>
                      <td className="apps-actions-cell">
                        <button
                          type="button"
                          className="btn ghost compact"
                          onClick={() => {
                            setBlockTarget(null)
                            setEditSchedule(rule)
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn ghost compact"
                          onClick={() => void repo.deleteAppBlockSchedule(familyId, rule.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'usage' && (
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Package</th>
                  <th>Today (min)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {usageRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="wa-empty-cell">
                      No usage data yet — requires Usage Access on the child device.
                    </td>
                  </tr>
                ) : (
                  usageRows.map((app) => (
                    <tr key={app.packageName}>
                      <td>{app.label || app.packageName}</td>
                      <td className="mono small">{app.packageName}</td>
                      <td>{app.minutes}</td>
                      <td>
                        <button
                          type="button"
                          className="btn ghost compact"
                          onClick={() => {
                            setEditSchedule(null)
                            setBlockTarget({
                              id: app.packageName,
                              packageName: app.packageName,
                              name: app.label || app.packageName,
                              versionName: '',
                              versionCode: 0,
                              apkSizeBytes: 0,
                              firstInstallTime: 0,
                              lastUpdateTime: 0,
                              updatedAtMs: 0,
                              deviceId: effectiveDeviceId,
                            })
                          }}
                        >
                          + Block
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <BlockAppModal
        open={Boolean(blockTarget || editSchedule)}
        appName={blockTarget?.name || editSchedule?.label || editSchedule?.packageName || ''}
        packageName={blockTarget?.packageName || editSchedule?.packageName || ''}
        initial={editSchedule ?? undefined}
        onClose={() => {
          setBlockTarget(null)
          setEditSchedule(null)
        }}
        onSave={saveBlock}
      />
    </section>
  )
}
