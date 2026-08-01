import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ArchNode, TcdCheck, TcdCheckStatus } from './types'

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

type EdgeDef = {
  from: string
  to: string
  verb?: string
  flows?: FlowId[]
  /** Shown only when a flow guide is active, or on edge hover */
  optional?: boolean
}

type FlowId = 'pairing' | 'liveView' | 'deploy'

const COLUMNS: { id: NodeDef['column']; header: string }[] = [
  { id: 'apps', header: '1. Apps' },
  { id: 'firebase', header: '2. Firebase' },
  { id: 'cloudflare', header: '3. Cloudflare' },
  { id: 'ops', header: '4. Hosting & tools' },
]

const NODES: NodeDef[] = [
  {
    id: 'parent-web',
    label: 'Parent web',
    subtitle: 'Website for guardians',
    group: 'client',
    column: 'apps',
    url: 'parent-web',
    siteIds: ['parent-web'],
  },
  {
    id: 'parent-apk',
    label: 'Parent app',
    subtitle: 'Android app for parents',
    group: 'client',
    column: 'apps',
    checkIds: ['parent-apk'],
  },
  {
    id: 'child-apk',
    label: 'Child app',
    subtitle: 'Phone on the kid',
    group: 'client',
    column: 'apps',
    checkIds: ['child-apk'],
  },
  {
    id: 'firebase-auth',
    label: 'Firebase Auth',
    subtitle: 'Sign-in & accounts',
    group: 'firebase',
    column: 'firebase',
    checkIds: ['firebase-auth'],
  },
  {
    id: 'firestore',
    label: 'Firestore',
    subtitle: 'Family & device data',
    group: 'firebase',
    column: 'firebase',
    checkIds: ['firestore-family', 'alerts-read'],
  },
  {
    id: 'fcm',
    label: 'Cloud Messaging',
    subtitle: 'Push alerts to phones',
    group: 'firebase',
    column: 'firebase',
  },
  {
    id: 'functions',
    label: 'Cloud Functions',
    subtitle: 'Server-side jobs',
    group: 'firebase',
    column: 'firebase',
    checkIds: ['functions-health'],
  },
  {
    id: 'firebase-hosting',
    label: 'Firebase Hosting',
    subtitle: 'Serves parent web app',
    group: 'hosting',
    column: 'firebase',
    siteIds: ['parent-web'],
  },
  {
    id: 'cf-worker',
    label: 'Cloudflare Worker',
    subtitle: 'Live video & API edge',
    group: 'edge',
    column: 'cloudflare',
    checkIds: ['platform-health', 'r2-proxy'],
  },
  {
    id: 'r2',
    label: 'R2 storage',
    subtitle: 'Camera frames & media',
    group: 'edge',
    column: 'cloudflare',
    checkIds: ['r2-proxy', 'parent-apk', 'child-apk'],
  },
  {
    id: 'd1',
    label: 'D1 database',
    subtitle: 'Structured edge data',
    group: 'edge',
    column: 'cloudflare',
    checkIds: ['platform-health'],
  },
  {
    id: 'kv',
    label: 'KV cache',
    subtitle: 'Fast edge lookups',
    group: 'edge',
    column: 'cloudflare',
    checkIds: ['platform-health'],
  },
  {
    id: 'gh-pages',
    label: 'GitHub Pages',
    subtitle: 'Public marketing site',
    group: 'hosting',
    column: 'ops',
    siteIds: ['marketing-site', 'tcd-page'],
  },
  {
    id: 'tcd',
    label: 'TCD console',
    subtitle: 'This admin dashboard',
    group: 'hosting',
    column: 'ops',
    siteIds: ['tcd-page'],
  },
  {
    id: 'google-maps',
    label: 'Google Maps',
    subtitle: 'Location on maps',
    group: 'external',
    column: 'ops',
    checkIds: ['google-maps'],
  },
]

/** Nearest-neighbor column bridges — always visible, no labels */
const COLUMN_EDGES: EdgeDef[] = [
  { from: 'parent-apk', to: 'firestore', optional: true },
  { from: 'firestore', to: 'cf-worker', optional: true },
  { from: 'cf-worker', to: 'tcd', optional: true },
]

const FLOW_EDGES: Record<FlowId, EdgeDef[]> = {
  pairing: [
    { from: 'child-apk', to: 'firestore', verb: 'register' },
    { from: 'parent-apk', to: 'firebase-auth', verb: 'sign in' },
    { from: 'parent-apk', to: 'firestore', verb: 'link family' },
    { from: 'parent-web', to: 'firebase-auth', verb: 'sign in' },
    { from: 'parent-web', to: 'firestore', verb: 'link family' },
  ],
  liveView: [
    { from: 'child-apk', to: 'r2', verb: 'upload frames' },
    { from: 'cf-worker', to: 'r2', verb: 'read frames' },
    { from: 'parent-web', to: 'cf-worker', verb: 'watch live' },
    { from: 'parent-apk', to: 'cf-worker', verb: 'watch live' },
  ],
  deploy: [
    { from: 'firebase-hosting', to: 'parent-web', verb: 'publish web' },
    { from: 'gh-pages', to: 'tcd', verb: 'publish TCD' },
  ],
}

const FLOW_META: Record<FlowId, { label: string; hint: string }> = {
  pairing: {
    label: 'Show pairing path',
    hint: 'Child registers → parents sign in → family link saved in Firestore.',
  },
  liveView: {
    label: 'Show live viewing path',
    hint: 'Child uploads camera frames → edge worker streams them to parent apps.',
  },
  deploy: {
    label: 'Show website deploy path',
    hint: 'Builds publish to Firebase Hosting & GitHub Pages → live sites update.',
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

type NodeRect = { cx: number; cy: number; right: number; left: number }

function edgeKey(from: string, to: string): string {
  return `${from}→${to}`
}

/** Gentle orthogonal path: horizontal exit → vertical → horizontal entry */
function buildOrthPath(a: NodeRect, b: NodeRect): string {
  const x1 = a.right
  const y1 = a.cy
  const x2 = b.left
  const y2 = b.cy
  const midX = (x1 + x2) / 2
  return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`
}

function labelPoint(a: NodeRect, b: NodeRect): { x: number; y: number } {
  const x1 = a.right
  const y1 = a.cy
  const x2 = b.left
  const y2 = b.cy
  const midX = (x1 + x2) / 2
  return { x: midX, y: (y1 + y2) / 2 - 8 }
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
  const boardRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [rects, setRects] = useState<Map<string, NodeRect>>(new Map())
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const [activeFlow, setActiveFlow] = useState<FlowId | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [stacked, setStacked] = useState(false)

  useEffect(() => {
    const t = window.setTimeout(() => setRevealed(true), 60)
    return () => window.clearTimeout(t)
  }, [])

  const measure = useCallback(() => {
    const board = boardRef.current
    if (!board) return
    const boardBox = board.getBoundingClientRect()
    const next = new Map<string, NodeRect>()
    nodeRefs.current.forEach((el, id) => {
      const box = el.getBoundingClientRect()
      next.set(id, {
        cx: box.left + box.width / 2 - boardBox.left,
        cy: box.top + box.height / 2 - boardBox.top,
        right: box.right - boardBox.left,
        left: box.left - boardBox.left,
      })
    })
    setRects(next)
    setStacked(window.matchMedia('(max-width: 860px)').matches)
  }, [])

  useLayoutEffect(() => {
    measure()
    const board = boardRef.current
    if (!board) return
    const ro = new ResizeObserver(measure)
    ro.observe(board)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  const archMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const visibleEdges = useMemo(() => {
    if (activeFlow) return FLOW_EDGES[activeFlow]
    return COLUMN_EDGES
  }, [activeFlow])

  const highlightEdgeKeys = useMemo(() => {
    if (activeFlow) {
      return new Set(FLOW_EDGES[activeFlow].map(({ from, to }) => edgeKey(from, to)))
    }
    return null
  }, [activeFlow])

  const highlightNodes = useMemo(() => {
    if (!activeFlow) return null
    const set = new Set<string>()
    FLOW_EDGES[activeFlow].forEach(({ from, to }) => {
      set.add(from)
      set.add(to)
    })
    return set
  }, [activeFlow])

  const toggleFlow = useCallback((flow: FlowId) => {
    setActiveFlow((prev) => (prev === flow ? null : flow))
  }, [])

  const setNodeRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) nodeRefs.current.set(id, el)
    else nodeRefs.current.delete(id)
  }, [])

  const probesPending = loading || nodes.length === 0
  const selected = selectedId ? archMap.get(selectedId) : null
  const svgSize = boardRef.current
    ? { w: boardRef.current.clientWidth, h: boardRef.current.clientHeight }
    : { w: 0, h: 0 }

  return (
    <div className={`tcd-arch-wrap ${revealed ? 'is-revealed' : ''}`}>
      <p className="tcd-arch-intro">
        This map shows how SareChild pieces talk to each other. Left = phones &amp; websites.
        Middle = databases &amp; cloud. Right = where the admin tools live.
      </p>

      <div className="tcd-arch-toolbar">
        <div className="tcd-arch-flows" role="group" aria-label="Architecture flow guides">
          {(Object.keys(FLOW_META) as FlowId[]).map((flow) => (
            <button
              key={flow}
              type="button"
              className={`tcd-arch-flow-btn ${activeFlow === flow ? 'active' : ''}`}
              onClick={() => toggleFlow(flow)}
              aria-pressed={activeFlow === flow}
            >
              {FLOW_META[flow].label}
              {activeFlow === flow ? ' ✕' : ''}
            </button>
          ))}
        </div>
        <p className="tcd-arch-flow-hint">
          {activeFlow
            ? FLOW_META[activeFlow].hint
            : 'Tap a component for health details. Use the buttons above to highlight a common data path.'}
        </p>
      </div>

      {probesPending && (
        <div className="tcd-arch-loading" aria-live="polite">
          <span className="tcd-arch-loading-pulse" />
          Waiting for probe results — run a health check on Overview if badges stay amber.
        </div>
      )}

      <div className="tcd-arch-board-wrap">
        <div className="tcd-arch-board" ref={boardRef}>
          {!stacked && svgSize.w > 0 && svgSize.h > 0 && (
            <svg
              className="tcd-arch-edges-svg"
              width={svgSize.w}
              height={svgSize.h}
              aria-hidden="true"
            >
              <defs>
                <marker id="arch-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 Z" className="tcd-arch-arrowhead" />
                </marker>
                <marker id="arch-arrow-hot" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 Z" className="tcd-arch-arrowhead-hot" />
                </marker>
              </defs>
              {visibleEdges.map(({ from, to, verb, optional }) => {
                const a = rects.get(from)
                const b = rects.get(to)
                if (!a || !b) return null
                const key = edgeKey(from, to)
                const hot = highlightEdgeKeys?.has(key) ?? !optional
                const dimmed = highlightEdgeKeys != null && !hot
                const showLabel = Boolean(verb && (hot || hoveredEdge === key))
                return (
                  <g
                    key={key}
                    className={`tcd-arch-edge-group ${hot ? 'hot' : ''} ${dimmed ? 'dimmed' : ''}`}
                    onMouseEnter={() => setHoveredEdge(key)}
                    onMouseLeave={() => setHoveredEdge(null)}
                  >
                    <path
                      d={buildOrthPath(a, b)}
                      className="tcd-arch-edge"
                      markerEnd={hot ? 'url(#arch-arrow-hot)' : 'url(#arch-arrow)'}
                      fill="none"
                    />
                    {showLabel && verb && (
                      <text x={labelPoint(a, b).x} y={labelPoint(a, b).y} className="tcd-arch-edge-label" textAnchor="middle">
                        {verb}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
          )}

          <div className="tcd-arch-columns">
            {COLUMNS.map((col) => (
              <section key={col.id} className={`tcd-arch-col col-${col.id}`} aria-label={col.header}>
                <h3 className="tcd-arch-col-header">{col.header}</h3>
                <div className="tcd-arch-col-nodes">
                  {NODES.filter((n) => n.column === col.id).map((n) => {
                    const arch = archMap.get(n.id)
                    const status = arch?.status ?? 'warn'
                    const isSelected = selectedId === n.id
                    const inFlow = highlightNodes?.has(n.id) ?? false
                    const dimmed = highlightNodes != null && !inFlow
                    return (
                      <button
                        key={n.id}
                        ref={(el) => setNodeRef(n.id, el)}
                        type="button"
                        className={`tcd-arch-card-node group-${n.group} status-${status} ${isSelected ? 'selected' : ''} ${inFlow ? 'flow-hot' : ''} ${dimmed ? 'flow-dimmed' : ''}`}
                        onClick={() => onSelect(n.id)}
                        aria-pressed={isSelected}
                        aria-label={`${n.label}, status ${STATUS_LABEL[status]}`}
                      >
                        <span className={`tcd-arch-status-badge status-${status}`} aria-hidden="true">
                          {STATUS_LABEL[status]}
                        </span>
                        <span className="tcd-arch-card-title">{n.label}</span>
                        <span className="tcd-arch-card-sub">{n.subtitle}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      <div className="tcd-arch-legend">
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-badge status-ok">OK</span> Healthy
        </span>
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-badge status-warn">WARN</span> Check soon
        </span>
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-badge status-fail">FAIL</span> Needs fix
        </span>
      </div>

      <div className={`tcd-arch-detail ${selected ? 'has-selection' : ''}`}>
        {selected ? (
          <>
            <strong>{selected.label}</strong>
            <span className={`tcd-arch-detail-badge status-${selected.status}`}>
              {STATUS_LABEL[selected.status]}
            </span>
            {selected.detail ? (
              <p className="muted small">{selected.detail}</p>
            ) : (
              <p className="muted small">No probe wired for this component — inferred healthy or not monitored.</p>
            )}
          </>
        ) : (
          <p className="muted small tcd-arch-detail-empty">Select a component to see live probe details.</p>
        )}
      </div>
    </div>
  )
}
