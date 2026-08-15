import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArchNode, TcdCheck, TcdCheckStatus } from './types'

/** Bump when architecture layout changes — visible in DOM for cache-bust verification */
export const ARCH_LAYOUT_VERSION = 'arch-map-v6-20260815'

type NodeDef = {
  id: string
  label: string
  subtitle: string
  group: ArchNode['group']
  column: 'apps' | 'firebase' | 'cloudflare' | 'ops'
  url?: string
  checkIds?: string[]
  siteIds?: string[]
}

type FlowId =
  | 'pairing'
  | 'heartbeat'
  | 'location'
  | 'whatsapp'
  | 'typing'
  | 'callRecording'
  | 'appBlocking'
  | 'liveView'
  | 'familyChat'
  | 'alerts'
  | 'deploy'

type FlowGroupId = 'features' | 'ops'

type FlowMeta = {
  label: string
  hint: string
  steps: string[]
  nodeIds: string[]
}

const FLOW_GROUPS: { id: FlowGroupId; label: string; flows: FlowId[] }[] = [
  {
    id: 'features',
    label: 'Child & parent features',
    flows: [
      'pairing',
      'heartbeat',
      'location',
      'whatsapp',
      'typing',
      'callRecording',
      'appBlocking',
      'liveView',
      'familyChat',
      'alerts',
    ],
  },
  {
    id: 'ops',
    label: 'Ops',
    flows: ['deploy'],
  },
]

const COLUMNS: { id: NodeDef['column']; header: string; num: string }[] = [
  { id: 'apps', num: '1', header: 'Apps' },
  { id: 'firebase', num: '2', header: 'Firebase' },
  { id: 'cloudflare', num: '3', header: 'Cloudflare' },
  { id: 'ops', num: '4', header: 'Hosting & admin' },
]

const NODES: NodeDef[] = [
  {
    id: 'parent-web',
    label: 'Parent web',
    subtitle: 'Guardian dashboard in the browser.',
    group: 'client',
    column: 'apps',
    url: 'parent-web',
    siteIds: ['parent-web'],
  },
  {
    id: 'parent-apk',
    label: 'Parent app',
    subtitle: 'Android app for parents on the go.',
    group: 'client',
    column: 'apps',
    checkIds: ['parent-apk'],
  },
  {
    id: 'child-apk',
    label: 'Child app',
    subtitle: 'Runs on the child phone and reports status.',
    group: 'client',
    column: 'apps',
    checkIds: ['child-apk'],
  },
  {
    id: 'firebase-auth',
    label: 'Firebase Auth',
    subtitle: 'Sign-in and secure account sessions.',
    group: 'firebase',
    column: 'firebase',
    checkIds: ['firebase-auth'],
  },
  {
    id: 'firestore',
    label: 'Firestore',
    subtitle: 'Family links, devices, and alert records.',
    group: 'firebase',
    column: 'firebase',
    checkIds: ['firestore-family', 'alerts-read'],
  },
  {
    id: 'fcm',
    label: 'Cloud Messaging',
    subtitle: 'Push notifications to parent and child apps.',
    group: 'firebase',
    column: 'firebase',
  },
  {
    id: 'functions',
    label: 'Cloud Functions',
    subtitle: 'Background jobs and server-side logic.',
    group: 'firebase',
    column: 'firebase',
    checkIds: ['functions-health'],
  },
  {
    id: 'firebase-hosting',
    label: 'Firebase Hosting',
    subtitle: 'Delivers the parent web app to browsers.',
    group: 'hosting',
    column: 'firebase',
    siteIds: ['parent-web'],
  },
  {
    id: 'cf-worker',
    label: 'Cloudflare Worker',
    subtitle: 'Live video API and edge request routing.',
    group: 'edge',
    column: 'cloudflare',
    checkIds: ['platform-health', 'r2-proxy'],
  },
  {
    id: 'r2',
    label: 'R2 storage',
    subtitle: 'Camera frames and media blobs.',
    group: 'edge',
    column: 'cloudflare',
    checkIds: ['r2-proxy', 'parent-apk', 'child-apk'],
  },
  {
    id: 'd1',
    label: 'D1 database',
    subtitle: 'Structured data at the edge.',
    group: 'edge',
    column: 'cloudflare',
    checkIds: ['platform-health'],
  },
  {
    id: 'kv',
    label: 'KV cache',
    subtitle: 'Fast edge key-value lookups.',
    group: 'edge',
    column: 'cloudflare',
    checkIds: ['platform-health'],
  },
  {
    id: 'gh-pages',
    label: 'GitHub Pages',
    subtitle: 'Public marketing site and docs.',
    group: 'hosting',
    column: 'ops',
    siteIds: ['marketing-site', 'tcd-page'],
  },
  {
    id: 'tcd',
    label: 'TCD console',
    subtitle: 'This operator dashboard you are using.',
    group: 'hosting',
    column: 'ops',
    siteIds: ['tcd-page'],
  },
  {
    id: 'google-maps',
    label: 'Google Maps',
    subtitle: 'Map tiles for live location views.',
    group: 'external',
    column: 'ops',
    checkIds: ['google-maps'],
  },
  {
    id: 'pc-xampp',
    label: 'This PC (XAMPP)',
    subtitle: 'Local archive via Cloudflare Worker',
    group: 'hosting',
    column: 'ops',
    url: 'https://sarechild-pc-storage.neuereatec.workers.dev/sarechild-storage/health.json',
  },
]

const FLOW_META: Record<FlowId, FlowMeta> = {
  pairing: {
    label: 'Pairing',
    hint: 'How a new child phone joins a family.',
    steps: [
      'Parent creates a pairing code in the parent app or web dashboard.',
      'Child app enters the code and claims the device on that phone.',
      'Firestore writes the family link and device record for both sides.',
      'Parent dashboard shows the new device and can manage protection settings.',
    ],
    nodeIds: ['parent-apk', 'parent-web', 'child-apk', 'firebase-auth', 'firestore'],
  },
  heartbeat: {
    label: 'Heartbeat / online',
    hint: 'How the parent knows a child phone is active and reachable.',
    steps: [
      'Child MonitoringService runs in the background while protection is on.',
      'The service writes a heartbeat timestamp to the device doc in Firestore.',
      'Parent Home (app or web) listens to device records in real time.',
      'Online status turns green when the heartbeat is recent; stale means offline.',
    ],
    nodeIds: ['child-apk', 'firestore', 'parent-apk', 'parent-web'],
  },
  location: {
    label: 'Location / live map',
    hint: 'How GPS from the child phone appears on the parent map.',
    steps: [
      'Child app reads GPS on a schedule while location permission is granted.',
      'Each fix is appended to the locationTrail collection in Firestore.',
      'Parent Live map loads trail points and draws the route on the map.',
      'Google Maps supplies map tiles and markers in the parent app or web.',
    ],
    nodeIds: ['child-apk', 'firestore', 'parent-apk', 'parent-web', 'google-maps'],
  },
  whatsapp: {
    label: 'WhatsApp protection',
    hint: 'How WhatsApp activity on the child phone reaches the parent.',
    steps: [
      'Child app watches WhatsApp via notification listener and accessibility.',
      'Message metadata and media land in whatsappEvents in Firestore.',
      'Large media blobs upload to R2; the Cloudflare Worker serves signed URLs.',
      'Parent WhatsApp table lists events with previews and download links.',
    ],
    nodeIds: ['child-apk', 'firestore', 'r2', 'cf-worker', 'parent-apk', 'parent-web'],
  },
  typing: {
    label: 'Typing safety',
    hint: 'How risky text typed on the child phone triggers parent alerts.',
    steps: [
      'Child accessibility service reads on-screen text as the child types.',
      'Debounced typingEvents and safety alerts write to Firestore.',
      'Cloud Messaging pushes urgent matches to parent devices immediately.',
      'Parent Typing safety screen shows flagged events for review.',
    ],
    nodeIds: ['child-apk', 'firestore', 'fcm', 'parent-apk', 'parent-web'],
  },
  callRecording: {
    label: 'Call recording',
    hint: 'How phone calls on the child device become parent-visible recordings.',
    steps: [
      'Child call monitor detects incoming and outgoing calls.',
      'Recording metadata saves to callRecordings; audio uploads to R2 storage.',
      'Cloudflare Worker proxies media download for the parent dashboard.',
      'Parent Call recording list plays back clips with call details.',
    ],
    nodeIds: ['child-apk', 'firestore', 'r2', 'cf-worker', 'parent-apk', 'parent-web'],
  },
  appBlocking: {
    label: 'Apps blocking',
    hint: 'How a parent schedule blocks apps on the child phone.',
    steps: [
      'Parent sets an app block schedule in Apps (app or web dashboard).',
      'Rules save to appBlockSchedules in Firestore for that family.',
      'Child UsageMonitor syncs schedules and enforces blocks locally.',
      'Blocked apps cannot open until the schedule window ends or parent clears it.',
    ],
    nodeIds: ['parent-apk', 'parent-web', 'firestore', 'child-apk'],
  },
  liveView: {
    label: 'Live viewing',
    hint: 'How parents watch a live camera feed from the child phone.',
    steps: [
      'Parent taps Start live view; a command reaches the child app.',
      'Child streams camera/mic over WebRTC; Cloudflare Worker helps signaling; frames may archive to R2.',
      'Parent viewer (app or web) connects to watch the stream in real time.',
    ],
    nodeIds: ['parent-apk', 'parent-web', 'child-apk', 'cf-worker', 'r2', 'fcm'],
  },
  familyChat: {
    label: 'Family chat',
    hint: 'How messages travel between parent and child in-app chat.',
    steps: [
      'Either side composes a message in the Family chat screen.',
      'The message writes to familyChat in Firestore for the family.',
      'Cloud Messaging notifies the other device of the new message.',
      'Recipient app opens chat and reads the thread in real time.',
    ],
    nodeIds: ['child-apk', 'parent-apk', 'parent-web', 'firestore', 'fcm'],
  },
  alerts: {
    label: 'Alerts / SOS',
    hint: 'How child SOS and safety alerts reach parents instantly.',
    steps: [
      'Child triggers SOS or a safety rule fires an alert on the device.',
      'Alert record writes to the alerts collection in Firestore.',
      'Cloud Messaging pushes a high-priority notification to all guardians.',
      'Parent Alerts screen shows severity, time, and acknowledgment options.',
    ],
    nodeIds: ['child-apk', 'firestore', 'fcm', 'parent-apk', 'parent-web'],
  },
  deploy: {
    label: 'Website deploy',
    hint: 'How website builds reach production hosting.',
    steps: [
      'GitHub Actions builds the parent web app on push to main.',
      'Firebase Hosting serves the parent dashboard to browsers.',
      'Marketing site and this TCD console deploy to GitHub Pages.',
      'This PC (XAMPP) holds a local archive reached through a Cloudflare Worker.',
      'Hard-refresh after deploy to load the latest architecture map version.',
    ],
    nodeIds: ['gh-pages', 'tcd', 'firebase-hosting', 'parent-web', 'pc-xampp'],
  },
}

const STATUS_RANK: Record<TcdCheckStatus, number> = { ok: 0, warn: 1, fail: 2 }

const STATUS_LABEL: Record<TcdCheckStatus, string> = {
  ok: 'OK',
  warn: 'WARN',
  fail: 'FAIL',
}

function worst(statuses: TcdCheckStatus[]): TcdCheckStatus {
  if (statuses.length === 0) return 'ok'
  return statuses.reduce((acc, s) => (STATUS_RANK[s] > STATUS_RANK[acc] ? s : acc))
}

function resolveNodeStatus(
  node: NodeDef,
  checks: TcdCheck[],
  siteStatuses: Record<string, TcdCheckStatus>,
): TcdCheckStatus {
  const fromChecks = (node.checkIds ?? [])
    .map((id) => checks.find((c) => c.id === id)?.status)
    .filter(Boolean) as TcdCheckStatus[]
  const fromSites = (node.siteIds ?? []).map((id) => siteStatuses[id] ?? 'ok')
  const all = [...fromChecks, ...fromSites]
  if (all.length === 0) {
    if (node.id === 'fcm') return 'ok'
    return 'warn'
  }
  return worst(all)
}

export function buildArchNodes(
  checks: TcdCheck[],
  siteStatuses: Record<string, TcdCheckStatus>,
): ArchNode[] {
  return NODES.map((n) => ({
    id: n.id,
    label: n.label,
    group: n.group,
    status: resolveNodeStatus(n, checks, siteStatuses),
    url: n.url,
    detail: checks
      .filter((c) => n.checkIds?.includes(c.id))
      .map((c) => `${c.label}: ${c.message}`)
      .join(' · '),
  }))
}

export function ArchitectureTree({
  nodes,
  selectedId,
  onSelect,
  loading = false,
}: {
  nodes: ArchNode[]
  selectedId: string | null
  onSelect: (id: string) => void
  loading?: boolean
}) {
  const [activeFlow, setActiveFlow] = useState<FlowId | null>(null)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    const t = window.setTimeout(() => setRevealed(true), 60)
    return () => window.clearTimeout(t)
  }, [])

  const archMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const highlightNodes = useMemo(() => {
    if (!activeFlow) return null
    return new Set(FLOW_META[activeFlow].nodeIds)
  }, [activeFlow])

  const toggleFlow = useCallback((flow: FlowId) => {
    setActiveFlow((prev) => (prev === flow ? null : flow))
  }, [])

  const selectFlow = useCallback((flow: FlowId | '') => {
    setActiveFlow(flow === '' ? null : flow)
  }, [])

  const probesPending = loading || nodes.length === 0
  const selected = selectedId ? archMap.get(selectedId) : null
  const activeMeta = activeFlow ? FLOW_META[activeFlow] : null

  return (
    <div
      className={`tcd-arch-wrap ${revealed ? 'is-revealed' : ''}`}
      data-arch-version={ARCH_LAYOUT_VERSION}
    >
      <p className="tcd-arch-intro">
        SareChild connects phones, cloud services, and hosting in four layers. Each card shows live
        health from probes — green is healthy, amber needs attention, red needs a fix. Pick a flow
        below to see how data moves for common tasks.
      </p>

      <div className="tcd-arch-toolbar">
        <label className="tcd-arch-flow-select-wrap">
          <span className="tcd-arch-flow-select-label">Choose a feature flow</span>
          <select
            className="tcd-arch-flow-select"
            value={activeFlow ?? ''}
            onChange={(e) => selectFlow(e.target.value as FlowId | '')}
            aria-label="Choose a feature flow"
          >
            <option value="">— Select to highlight data path —</option>
            {FLOW_GROUPS.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.flows.map((flow) => (
                  <option key={flow} value={flow}>
                    {FLOW_META[flow].label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {FLOW_GROUPS.map((group) => (
          <div key={group.id} className="tcd-arch-flow-group">
            <p className="tcd-arch-flow-group-label">{group.label}</p>
            <div className="tcd-arch-flow-tabs" role="tablist" aria-label={`${group.label} flow guides`}>
              {group.flows.map((flow) => (
                <button
                  key={flow}
                  type="button"
                  role="tab"
                  aria-selected={activeFlow === flow}
                  className={`tcd-arch-flow-tab ${activeFlow === flow ? 'is-active' : ''}`}
                  onClick={() => toggleFlow(flow)}
                >
                  {FLOW_META[flow].label}
                </button>
              ))}
            </div>
          </div>
        ))}

        <p className="tcd-arch-flow-hint">
          {activeMeta
            ? activeMeta.hint
            : 'Pick a flow above to highlight how data moves. Select any card for live probe details.'}
        </p>
      </div>

      {probesPending && (
        <div className="tcd-arch-loading" aria-live="polite">
          <span className="tcd-arch-loading-pulse" />
          Waiting for probe results — run a health check on Overview if badges stay amber.
        </div>
      )}

      <div className="tcd-arch-map-scroll">
        <div className="tcd-arch-map" role="list" aria-label="System architecture map">
          {COLUMNS.map((col, colIndex) => (
            <div key={col.id} className="tcd-arch-map-segment">
              {colIndex > 0 && (
                <div className="tcd-arch-step-arrow" aria-hidden="true">
                  <span className="tcd-arch-step-arrow-icon" />
                </div>
              )}
              <section className={`tcd-arch-step-col col-${col.id}`} aria-label={`${col.num}. ${col.header}`}>
                <header className="tcd-arch-step-header">
                  <span className="tcd-arch-step-num">{col.num}</span>
                  <span className="tcd-arch-step-title">{col.header}</span>
                </header>
                <div className="tcd-arch-step-cards">
                  {NODES.filter((n) => n.column === col.id).map((n) => {
                    const arch = archMap.get(n.id)
                    const status = arch?.status ?? 'warn'
                    const isSelected = selectedId === n.id
                    const inFlow = highlightNodes?.has(n.id) ?? false
                    const dimmed = highlightNodes != null && !inFlow
                    return (
                      <button
                        key={n.id}
                        type="button"
                        role="listitem"
                        className={[
                          'tcd-arch-component-card',
                          `group-${n.group}`,
                          `status-${status}`,
                          isSelected ? 'is-selected' : '',
                          inFlow ? 'is-flow-active' : '',
                          dimmed ? 'is-flow-dimmed' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => onSelect(n.id)}
                        aria-pressed={isSelected}
                        aria-label={`${n.label}, status ${STATUS_LABEL[status]}`}
                      >
                        <span className={`tcd-arch-status-pill status-${status}`} aria-hidden="true">
                          {STATUS_LABEL[status]}
                        </span>
                        <span className="tcd-arch-component-title">{n.label}</span>
                        <span className="tcd-arch-component-desc">{n.subtitle}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            </div>
          ))}
        </div>
      </div>

      {activeMeta && (
        <div className="tcd-arch-data-flow" aria-live="polite">
          <h4 className="tcd-arch-data-flow-title">How data moves — {activeMeta.label}</h4>
          <ol className="tcd-arch-data-flow-list">
            {activeMeta.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      <div className="tcd-arch-legend">
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-pill status-ok">OK</span> Healthy
        </span>
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-pill status-warn">WARN</span> Check soon
        </span>
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-pill status-fail">FAIL</span> Needs fix
        </span>
      </div>

      <div className={`tcd-arch-detail ${selected ? 'has-selection' : ''}`}>
        {selected ? (
          <>
            <strong className="tcd-arch-detail-name">{selected.label}</strong>
            <span className={`tcd-arch-detail-pill status-${selected.status}`}>
              {STATUS_LABEL[selected.status]}
            </span>
            {selected.detail ? (
              <p className="tcd-arch-detail-text">{selected.detail}</p>
            ) : (
              <p className="tcd-arch-detail-text">
                No probe wired for this component — inferred healthy or not monitored.
              </p>
            )}
          </>
        ) : (
          <p className="tcd-arch-detail-empty">Select a component to see live probe details.</p>
        )}
      </div>
    </div>
  )
}
