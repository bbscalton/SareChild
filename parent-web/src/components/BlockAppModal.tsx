import { useEffect, useState } from 'react'
import type { AppBlockSchedule } from '../types'

/** Calendar.SUNDAY=1 … SATURDAY=7 */
export const DAY_OPTIONS = [
  { label: 'Mon', value: 2 },
  { label: 'Tue', value: 3 },
  { label: 'Wed', value: 4 },
  { label: 'Thu', value: 5 },
  { label: 'Fri', value: 6 },
  { label: 'Sat', value: 7 },
  { label: 'Sun', value: 1 },
] as const

export function minutesToTime(m: number): string {
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

export function timeToMinutes(value: string): number {
  const [h, min] = value.split(':').map((x) => Number(x))
  if (!Number.isFinite(h) || !Number.isFinite(min)) return 0
  return Math.max(0, Math.min(1439, h * 60 + min))
}

export function formatDays(days: number[]): string {
  if (!days.length) return 'Every day'
  const labels = DAY_OPTIONS.filter((d) => days.includes(d.value)).map((d) => d.label)
  return labels.join(', ')
}

type Props = {
  open: boolean
  appName: string
  packageName: string
  initial?: Partial<AppBlockSchedule>
  onClose: () => void
  onSave: (input: {
    label: string
    packageName: string
    daysOfWeek: number[]
    startMinute: number
    endMinute: number
    message: string
  }) => Promise<void>
}

export function BlockAppModal({ open, appName, packageName, initial, onClose, onSave }: Props) {
  const [label, setLabel] = useState(appName)
  const [startTime, setStartTime] = useState('08:00')
  const [endTime, setEndTime] = useState('17:00')
  const [days, setDays] = useState<number[]>([2, 3, 4, 5, 6])
  const [message, setMessage] = useState('Application has been blocked.')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setLabel(initial?.label || appName)
    setStartTime(minutesToTime(initial?.startMinute ?? 0))
    setEndTime(minutesToTime(initial?.endMinute ?? 1439))
    setDays(initial?.daysOfWeek?.length ? [...initial.daysOfWeek] : [2, 3, 4, 5, 6])
    setMessage(initial?.message || 'Application has been blocked.')
  }, [open, appName, initial])

  if (!open) return null

  function toggleDay(value: number) {
    setDays((prev) => (prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value]))
  }

  async function handleSave() {
    setBusy(true)
    try {
      await onSave({
        label: label.trim() || appName,
        packageName,
        daysOfWeek: days,
        startMinute: timeToMinutes(startTime),
        endMinute: timeToMinutes(endTime),
        message: message.trim() || 'Application has been blocked.',
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" role="presentation" onClick={onClose}>
      <div className="modal-card apps-block-modal" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <h3>Block the application: {appName}</h3>
        <label>
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div className="apps-time-row">
          <label>
            Start time
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <label>
            End time
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </label>
        </div>
        <fieldset className="apps-day-toggles">
          <legend>Days</legend>
          <div className="apps-day-grid">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                className={days.includes(d.value) ? 'chip active' : 'chip'}
                onClick={() => toggleDay(d.value)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          Message
          <textarea
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Application has been blocked."
          />
          <span className="muted small">Shown on the child phone when this app is blocked.</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void handleSave()} disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
