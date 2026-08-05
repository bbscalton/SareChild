import { useMemo, useState } from 'react'
import type { WhatsAppEvent } from '../types'
import {
  displayType,
  displayTypeLabel,
  eventMatchesTypeFilter,
  formatWhatsAppDate,
  parseEventDisplay,
  type WhatsAppDisplayType,
} from '../lib/whatsappEventDisplay'

type Props = {
  events: WhatsAppEvent[]
  deviceName?: string
  typeFilter: WhatsAppDisplayType | 'ALL'
  onTypeFilterChange: (t: WhatsAppDisplayType | 'ALL') => void
  onDeleteSelected: (ids: string[]) => Promise<void>
  deleteEnabled: boolean
}

type SortDir = 'asc' | 'desc'

type ColFilters = {
  type: string
  name: string
  message: string
  date: string
}

const PAGE_SIZES = [10, 25, 50, 100] as const

const TYPE_BADGE_CLASS: Record<WhatsAppDisplayType, string> = {
  INCOMING: 'wa-badge wa-badge-in',
  OUTGOING: 'wa-badge wa-badge-out',
  CALL: 'wa-badge wa-badge-call',
  MEDIA: 'wa-badge wa-badge-media',
  UNKNOWN: 'wa-badge wa-badge-unknown',
}

export function WhatsAppEventsTable({
  events,
  deviceName,
  typeFilter,
  onTypeFilterChange,
  onDeleteSelected,
  deleteEnabled,
}: Props) {
  const [search, setSearch] = useState('')
  const [pageSize, setPageSize] = useState<number>(25)
  const [page, setPage] = useState(0)
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [colFilters, setColFilters] = useState<ColFilters>({ type: '', name: '', message: '', date: '' })
  const [toolsOpen, setToolsOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events
      .filter((ev) => eventMatchesTypeFilter(ev, typeFilter))
      .map((ev) => {
        const { name, message } = parseEventDisplay(ev)
        const type = displayType(ev)
        return {
          ev,
          type,
          typeLabel: displayTypeLabel(type),
          name,
          message,
          dateMs: ev.createdAtMs,
          dateStr: formatWhatsAppDate(ev.createdAtMs),
          searchBlob: [type, name, message, formatWhatsAppDate(ev.createdAtMs)].join(' ').toLowerCase(),
        }
      })
      .filter((row) => {
        if (q && !row.searchBlob.includes(q)) return false
        if (colFilters.type && !row.typeLabel.toLowerCase().includes(colFilters.type.toLowerCase())) return false
        if (colFilters.name && !row.name.toLowerCase().includes(colFilters.name.toLowerCase())) return false
        if (colFilters.message && !row.message.toLowerCase().includes(colFilters.message.toLowerCase())) return false
        if (colFilters.date && !row.dateStr.includes(colFilters.date)) return false
        return true
      })
      .sort((a, b) => (sortDir === 'desc' ? b.dateMs - a.dateMs : a.dateMs - b.dateMs))
  }, [events, typeFilter, search, colFilters, sortDir])

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const pageRows = rows.slice(safePage * pageSize, safePage * pageSize + pageSize)
  const allPageSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.ev.id))

  function toggleAllPage() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allPageSelected) pageRows.forEach((r) => next.delete(r.ev.id))
      else pageRows.forEach((r) => next.add(r.ev.id))
      return next
    })
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function bulkDelete() {
    if (!deleteEnabled || selected.size === 0) return
    setBusy(true)
    try {
      await onDeleteSelected([...selected])
      setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  function exportCsv() {
    const header = ['Type', 'Name', 'Message', 'Date', 'Device', 'Source']
    const deviceLabel = deviceName || 'device'
    const lines = rows.map((r) =>
      [r.typeLabel, r.name, r.message, r.dateStr, deviceLabel, r.ev.source]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(','),
    )
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `whatsapp-events-${deviceLabel.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setToolsOpen(false)
  }

  const typeChips: { id: WhatsAppDisplayType | 'ALL'; label: string }[] = [
    { id: 'ALL', label: 'All' },
    { id: 'INCOMING', label: 'Incoming' },
    { id: 'OUTGOING', label: 'Outgoing' },
    { id: 'CALL', label: 'Calls' },
    { id: 'MEDIA', label: 'Media' },
    { id: 'UNKNOWN', label: 'Unknown' },
  ]

  return (
    <div className="card wa-table-card">
      <div className="wa-table-header">
        <h3>{deviceName ? `WHATSAPP · ${deviceName}` : 'WHATSAPP'}</h3>
        <div className="wa-table-toolbar">
          <div className="wa-tools-wrap">
            <button type="button" className="btn ghost compact" onClick={() => setToolsOpen((v) => !v)}>
              TOOLS ▾
            </button>
            {toolsOpen && (
              <div className="wa-tools-menu">
                <button type="button" onClick={exportCsv}>
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setColFilters({ type: '', name: '', message: '', date: '' })
                    setSearch('')
                    setToolsOpen(false)
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
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
            placeholder="Search…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
          />
          {deleteEnabled && selected.size > 0 && (
            <button type="button" className="btn ghost compact wa-trash" disabled={busy} onClick={() => void bulkDelete()}>
              🗑 Delete ({selected.size})
            </button>
          )}
        </div>
      </div>

      <div className="filter-row wa-type-chips">
        {typeChips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={typeFilter === chip.id ? 'chip active' : 'chip'}
            onClick={() => {
              onTypeFilterChange(chip.id)
              setPage(0)
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="wa-table-scroll">
        <table className="wa-table">
          <thead>
            <tr>
              <th className="wa-col-check">
                <input
                  type="checkbox"
                  aria-label="Select all on page"
                  checked={allPageSelected}
                  onChange={toggleAllPage}
                />
              </th>
              <th>Type</th>
              <th>Name</th>
              <th>Message</th>
              <th>
                <button
                  type="button"
                  className="wa-sort-btn"
                  onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                >
                  Date {sortDir === 'desc' ? '↓' : '↑'}
                </button>
              </th>
            </tr>
            <tr className="wa-filter-row">
              <th />
              <th>
                <input
                  placeholder="Filter"
                  value={colFilters.type}
                  onChange={(e) => {
                    setColFilters((f) => ({ ...f, type: e.target.value }))
                    setPage(0)
                  }}
                />
              </th>
              <th>
                <input
                  placeholder="Filter"
                  value={colFilters.name}
                  onChange={(e) => {
                    setColFilters((f) => ({ ...f, name: e.target.value }))
                    setPage(0)
                  }}
                />
              </th>
              <th>
                <input
                  placeholder="Filter"
                  value={colFilters.message}
                  onChange={(e) => {
                    setColFilters((f) => ({ ...f, message: e.target.value }))
                    setPage(0)
                  }}
                />
              </th>
              <th>
                <input
                  placeholder="Filter"
                  value={colFilters.date}
                  onChange={(e) => {
                    setColFilters((f) => ({ ...f, date: e.target.value }))
                    setPage(0)
                  }}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="wa-empty-cell">
                  No matching events
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr key={row.ev.id} className={row.ev.riskFlag ? 'wa-row-risk' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(row.ev.id)}
                      onChange={() => toggleRow(row.ev.id)}
                      aria-label={`Select ${row.name}`}
                    />
                  </td>
                  <td>
                    <span className={TYPE_BADGE_CLASS[row.type]}>{row.typeLabel}</span>
                  </td>
                  <td className="wa-col-name">
                    <span className="wa-name-cell">
                      <strong>{row.name}</strong>
                      {!row.ev.contactSafe && (
                        <span
                          className="pill offline compact"
                          title="This contact/handle is not on your safe list"
                        >
                          Unknown contact
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="wa-col-message">
                    {row.message || <span className="muted">—</span>}
                    {row.ev.mediaUrl && (
                      <a href={row.ev.mediaUrl} target="_blank" rel="noreferrer" className="wa-media-link">
                        View media
                      </a>
                    )}
                  </td>
                  <td className="wa-col-date muted small">{row.dateStr}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="wa-pagination">
        <span className="muted small">
          Showing {rows.length === 0 ? 0 : safePage * pageSize + 1} to{' '}
          {Math.min((safePage + 1) * pageSize, rows.length)} of {rows.length} entries
        </span>
        <div className="wa-page-btns">
          <button type="button" className="btn ghost compact" disabled={safePage <= 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span className="muted small">
            Page {safePage + 1} / {totalPages}
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
      </div>
    </div>
  )
}
