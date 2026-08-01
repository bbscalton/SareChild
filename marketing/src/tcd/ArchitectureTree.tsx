import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArchNode, TcdCheck, TcdCheckStatus } from './types'

/** Bump when architecture layout changes — visible in DOM for cache-bust verification */
export const ARCH_LAYOUT_VERSION = 'arch-map-v4-20260801'

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

type FlowId = 'pairing' | 'liveView' | 'deploy'

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
]

const FLOW_META: Record<FlowId, { label: string; hint: string; steps: string[]; nodeIds: string[] }> = {
  pairing: {
    label: 'Pairing',
    hint: 'How a new child phone joins a family.',
    steps: [
      'Child app registers the device in Firestore.',
      'Parent signs in through Firebase Auth (app or web).',
      'Parent links the family record so both sides share data.',
    ],
    nodeIds: ['child-apk', 'parent-apk', 'parent-web', 'firebase-auth', 'firestore'],
  },
  liveView: {
    label: 'Live viewing',
    hint: 'How parents watch a live camera feed.',
    steps: [
      'Child app uploads camera frames to R2 storage.',
      'Cloudflare Worker reads frames and serves the stream.',
      'Parent web or app connects to the Worker to watch live.',
    ],
    nodeIds: ['child-apk', 'r2', 'cf-worker', 'parent-web', 'parent-apk'],
  },
  deploy: {
    label: 'Deploy',
    hint: 'How website builds reach production.',
    steps: [
      'CI builds publish the parent web app to Firebase Hosting.',
      'Marketing site and this TCD console deploy to GitHub Pages.',
    ],
    nodeIds: ['firebase-hosting', 'parent-web', 'gh-pages', 'tcd'],
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
        <div className="tcd-arch-flow-tabs" role="tablist" aria-label="Architecture flow guides">
          {(Object.keys(FLOW_META) as FlowId[]).map((flow) => (
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
        <p className="tcd-arch-flow-hint">
          {activeMeta
            ? activeMeta.hint
            : 'Select a component for probe details. Use the tabs above to highlight a common data path.'}
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
