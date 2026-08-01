import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArchNode, TcdCheck, TcdCheckStatus } from './types'

type NodeDef = {
  id: string
  label: string
  group: ArchNode['group']
  lane: 'clients' | 'firebase' | 'edge' | 'ops'
  x: number
  y: number
  url?: string
  checkIds?: string[]
  siteIds?: string[]
}

type EdgeDef = {
  from: string
  to: string
  verb: string
  flows?: FlowId[]
}

type FlowId = 'pairing' | 'liveView' | 'deploy'

const NODE_W = 148
const NODE_H = 34

const NODES: NodeDef[] = [
  { id: 'parent-web', label: 'Parent web', group: 'client', lane: 'clients', x: 28, y: 72, url: 'parent-web', siteIds: ['parent-web'] },
  { id: 'parent-apk', label: 'Parent APK', group: 'client', lane: 'clients', x: 28, y: 148, checkIds: ['parent-apk'] },
  { id: 'child-apk', label: 'Child APK', group: 'client', lane: 'clients', x: 28, y: 224, checkIds: ['child-apk'] },
  { id: 'firebase-auth', label: 'Firebase Auth', group: 'firebase', lane: 'firebase', x: 248, y: 56, checkIds: ['firebase-auth'] },
  { id: 'firestore', label: 'Firestore', group: 'firebase', lane: 'firebase', x: 248, y: 122, checkIds: ['firestore-family', 'alerts-read'] },
  { id: 'fcm', label: 'FCM', group: 'firebase', lane: 'firebase', x: 248, y: 188 },
  { id: 'functions', label: 'Cloud Functions', group: 'firebase', lane: 'firebase', x: 248, y: 254, checkIds: ['functions-health'] },
  { id: 'firebase-hosting', label: 'Firebase Hosting', group: 'hosting', lane: 'firebase', x: 248, y: 320, siteIds: ['parent-web'] },
  { id: 'cf-worker', label: 'Cloudflare Worker', group: 'edge', lane: 'edge', x: 468, y: 72, checkIds: ['platform-health', 'r2-proxy'] },
  { id: 'r2', label: 'R2 storage', group: 'edge', lane: 'edge', x: 468, y: 148, checkIds: ['r2-proxy', 'parent-apk', 'child-apk'] },
  { id: 'd1', label: 'D1', group: 'edge', lane: 'edge', x: 468, y: 224, checkIds: ['platform-health'] },
  { id: 'kv', label: 'KV', group: 'edge', lane: 'edge', x: 468, y: 300, checkIds: ['platform-health'] },
  { id: 'gh-pages', label: 'GitHub Pages', group: 'hosting', lane: 'ops', x: 688, y: 56, siteIds: ['marketing-site', 'tcd-page'] },
  { id: 'gh-repo', label: 'GitHub repo', group: 'hosting', lane: 'ops', x: 688, y: 122 },
  { id: 'tcd', label: 'TCD console', group: 'hosting', lane: 'ops', x: 688, y: 188, siteIds: ['tcd-page'] },
  { id: 'google-maps', label: 'Google Maps', group: 'external', lane: 'ops', x: 688, y: 264, checkIds: ['google-maps'] },
]

const EDGES: EdgeDef[] = [
  { from: 'parent-web', to: 'firebase-auth', verb: 'auth', flows: ['pairing'] },
  { from: 'parent-web', to: 'firestore', verb: 'sync', flows: ['pairing'] },
  { from: 'parent-apk', to: 'firebase-auth', verb: 'auth', flows: ['pairing'] },
  { from: 'parent-apk', to: 'firestore', verb: 'sync', flows: ['pairing'] },
  { from: 'child-apk', to: 'firestore', verb: 'sync', flows: ['pairing'] },
  { from: 'child-apk', to: 'fcm', verb: 'push' },
  { from: 'parent-web', to: 'cf-worker', verb: 'stream', flows: ['liveView'] },
  { from: 'parent-apk', to: 'cf-worker', verb: 'stream', flows: ['liveView'] },
  { from: 'child-apk', to: 'r2', verb: 'store', flows: ['liveView'] },
  { from: 'firestore', to: 'cf-worker', verb: 'sync' },
  { from: 'cf-worker', to: 'r2', verb: 'stream', flows: ['liveView'] },
  { from: 'cf-worker', to: 'd1', verb: 'store' },
  { from: 'cf-worker', to: 'kv', verb: 'store' },
  { from: 'gh-repo', to: 'gh-pages', verb: 'deploy', flows: ['deploy'] },
  { from: 'gh-pages', to: 'tcd', verb: 'deploy', flows: ['deploy'] },
  { from: 'firebase-hosting', to: 'parent-web', verb: 'deploy', flows: ['deploy'] },
  { from: 'parent-web', to: 'google-maps', verb: 'api' },
  { from: 'functions', to: 'firestore', verb: 'sync' },
]

const LANES: { id: NodeDef['lane']; label: string; x: number; w: number }[] = [
  { id: 'clients', label: 'Clients', x: 12, w: 196 },
  { id: 'firebase', label: 'Firebase', x: 232, w: 196 },
  { id: 'edge', label: 'Edge', x: 452, w: 196 },
  { id: 'ops', label: 'Ops & hosting', x: 672, w: 276 },
]

const FLOW_META: Record<FlowId, { label: string; hint: string }> = {
  pairing: {
    label: 'Pairing flow',
    hint: 'Child registers → parents authenticate → family link lands in Firestore.',
  },
  liveView: {
    label: 'Live view',
    hint: 'Child stores frames in R2 → edge worker streams to parent dashboards.',
  },
  deploy: {
    label: 'Deploy path',
    hint: 'Repo push → GitHub Pages / Firebase Hosting → live parent web & TCD.',
  },
}

const FLOW_EDGES: Record<FlowId, [string, string][]> = {
  pairing: [
    ['child-apk', 'firestore'],
    ['parent-apk', 'firebase-auth'],
    ['parent-apk', 'firestore'],
    ['parent-web', 'firebase-auth'],
    ['parent-web', 'firestore'],
  ],
  liveView: [
    ['child-apk', 'r2'],
    ['cf-worker', 'r2'],
    ['parent-web', 'cf-worker'],
    ['parent-apk', 'cf-worker'],
  ],
  deploy: [
    ['gh-repo', 'gh-pages'],
    ['gh-pages', 'tcd'],
    ['firebase-hosting', 'parent-web'],
  ],
}

const STATUS_RANK: Record<TcdCheckStatus, number> = { ok: 0, warn: 1, fail: 2 }

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
    if (node.id === 'fcm' || node.id === 'gh-repo') return 'ok'
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

const GROUP_COLORS: Record<ArchNode['group'], string> = {
  client: '#3fd6a0',
  firebase: '#f0a53a',
  edge: '#ff7a59',
  hosting: '#7b9cff',
  external: '#94a8d4',
}

function edgeKey(from: string, to: string): string {
  return `${from}→${to}`
}

function buildEdgePath(a: NodeDef, b: NodeDef): string {
  const x1 = a.x + NODE_W
  const y1 = a.y + NODE_H / 2
  const x2 = b.x
  const y2 = b.y + NODE_H / 2
  const dx = x2 - x1
  const c1x = x1 + dx * 0.45
  const c2x = x2 - dx * 0.45
  return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`
}

function labelPoint(a: NodeDef, b: NodeDef): { x: number; y: number } {
  const x1 = a.x + NODE_W
  const y1 = a.y + NODE_H / 2
  const x2 = b.x
  const y2 = b.y + NODE_H / 2
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6 }
}

function buildFlowPath(flow: FlowId, nodeMap: Map<string, NodeDef>): string | null {
  const segments = FLOW_EDGES[flow]
    .map(([from, to]) => {
      const a = nodeMap.get(from)
      const b = nodeMap.get(to)
      if (!a || !b) return null
      const x1 = a.x + NODE_W
      const y1 = a.y + NODE_H / 2
      const x2 = b.x
      const y2 = b.y + NODE_H / 2
      const dx = x2 - x1
      const c1x = x1 + dx * 0.45
      const c2x = x2 - dx * 0.45
      return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`
    })
    .filter(Boolean) as string[]
  if (segments.length === 0) return null
  return segments.join(' ')
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
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [activeFlow, setActiveFlow] = useState<FlowId | null>(null)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    const t = window.setTimeout(() => setRevealed(true), 60)
    return () => window.clearTimeout(t)
  }, [])

  const nodeMap = useMemo(() => new Map(NODES.map((n) => [n.id, n])), [])
  const archMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const adjacency = useMemo(() => {
    const connected = new Map<string, Set<string>>()
    const add = (a: string, b: string) => {
      if (!connected.has(a)) connected.set(a, new Set())
      connected.get(a)!.add(b)
    }
    EDGES.forEach(({ from, to }) => {
      add(from, to)
      add(to, from)
    })
    return connected
  }, [])

  const highlightNodes = useMemo(() => {
    const focus = hoveredId ?? selectedId
    if (activeFlow) {
      const set = new Set<string>()
      FLOW_EDGES[activeFlow].forEach(([from, to]) => {
        set.add(from)
        set.add(to)
      })
      return set
    }
    if (!focus) return null
    const set = new Set<string>([focus])
    adjacency.get(focus)?.forEach((id) => set.add(id))
    return set
  }, [hoveredId, selectedId, activeFlow, adjacency])

  const highlightEdges = useMemo(() => {
    if (activeFlow) {
      return new Set(FLOW_EDGES[activeFlow].map(([from, to]) => edgeKey(from, to)))
    }
    const focus = hoveredId ?? selectedId
    if (!focus) return null
    return new Set(
      EDGES.filter(({ from, to }) => from === focus || to === focus).map(({ from, to }) => edgeKey(from, to)),
    )
  }, [hoveredId, selectedId, activeFlow])

  const flowPath = useMemo(
    () => (activeFlow ? buildFlowPath(activeFlow, nodeMap) : null),
    [activeFlow, nodeMap],
  )

  const toggleFlow = useCallback((flow: FlowId) => {
    setActiveFlow((prev) => (prev === flow ? null : flow))
  }, [])

  const probesPending = loading || nodes.length === 0
  const selected = selectedId ? archMap.get(selectedId) : null

  return (
    <div className={`tcd-arch-wrap ${revealed ? 'is-revealed' : ''}`}>
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
              {activeFlow === flow ? 'Stop' : 'Follow'} {FLOW_META[flow].label.toLowerCase()}
            </button>
          ))}
        </div>
        <p className="tcd-arch-flow-hint">
          {activeFlow ? FLOW_META[activeFlow].hint : 'Hover or click a node to trace its connections. Use flow guides to animate data paths.'}
        </p>
      </div>

      {probesPending && (
        <div className="tcd-arch-loading" aria-live="polite">
          <span className="tcd-arch-loading-pulse" />
          Waiting for probe results — run a health check on Overview if badges stay amber.
        </div>
      )}

      <div className="tcd-arch-canvas">
        <svg viewBox="0 0 960 400" className="tcd-arch-svg" role="img" aria-label="SareChild architecture diagram">
          <defs>
            <marker id="arch-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" className="tcd-arch-arrowhead" />
            </marker>
            <marker id="arch-arrow-hot" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" className="tcd-arch-arrowhead-hot" />
            </marker>
            <filter id="arch-glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {LANES.map((lane, i) => (
            <g key={lane.id} className={`tcd-arch-lane lane-${lane.id}`} style={{ animationDelay: `${i * 80}ms` }}>
              <rect x={lane.x} y={36} width={lane.w} height={348} rx="14" className="tcd-arch-lane-bg" />
              <text x={lane.x + lane.w / 2} y={26} className="tcd-arch-lane-label" textAnchor="middle">
                {lane.label}
              </text>
            </g>
          ))}

          <g className="tcd-arch-edges">
            {EDGES.map(({ from, to, verb, flows }) => {
              const a = nodeMap.get(from)
              const b = nodeMap.get(to)
              if (!a || !b) return null
              const key = edgeKey(from, to)
              const hot = highlightEdges?.has(key) ?? false
              const dimmed = highlightEdges != null && !hot
              const path = buildEdgePath(a, b)
              const lp = labelPoint(a, b)
              return (
                <g key={key} className={`tcd-arch-edge-group ${hot ? 'hot' : ''} ${dimmed ? 'dimmed' : ''}`}>
                  <path
                    d={path}
                    className={`tcd-arch-edge ${activeFlow && flows?.includes(activeFlow) ? 'flow-edge' : ''}`}
                    markerEnd={hot ? 'url(#arch-arrow-hot)' : 'url(#arch-arrow)'}
                    fill="none"
                  />
                  <text x={lp.x} y={lp.y} className="tcd-arch-edge-label" textAnchor="middle">
                    {verb}
                  </text>
                </g>
              )
            })}
          </g>

          {activeFlow && flowPath && (
            <g className="tcd-arch-token-wrap" aria-hidden="true">
              <circle r="5" className="tcd-arch-token">
                <animateMotion dur="4.5s" repeatCount="indefinite" path={flowPath} />
              </circle>
            </g>
          )}

          {NODES.map((n, i) => {
            const arch = archMap.get(n.id)
            const status = arch?.status ?? 'warn'
            const selectedNode = selectedId === n.id
            const hot = highlightNodes?.has(n.id) ?? false
            const dimmed = highlightNodes != null && !hot
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                className={`tcd-arch-node ${selectedNode ? 'selected' : ''} ${hot ? 'hot' : ''} ${dimmed ? 'dimmed' : ''}`}
                style={{ animationDelay: `${120 + i * 35}ms` }}
                onClick={() => onSelect(n.id)}
                onMouseEnter={() => setHoveredId(n.id)}
                onMouseLeave={() => setHoveredId(null)}
                role="button"
                tabIndex={0}
                aria-label={`${n.label}, status ${status}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelect(n.id)
                }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx="9"
                  className={`tcd-arch-rect group-${n.group} status-${status}`}
                  filter={selectedNode || hot ? 'url(#arch-glow)' : undefined}
                />
                <circle cx={NODE_W - 12} cy={10} r="5" className={`tcd-arch-badge status-${status}`} />
                <text x="12" y="22" className="tcd-arch-label">
                  {n.label}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="tcd-arch-legend">
        {(['client', 'firebase', 'edge', 'hosting', 'external'] as const).map((g) => (
          <span key={g} className="tcd-arch-legend-item">
            <span className="tcd-arch-legend-dot" style={{ background: GROUP_COLORS[g] }} />
            {g}
          </span>
        ))}
        <span className="tcd-arch-legend-sep" aria-hidden="true" />
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-dot status-ok" /> OK
        </span>
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-dot status-warn" /> WARN
        </span>
        <span className="tcd-arch-legend-item">
          <span className="tcd-arch-legend-dot status-fail" /> FAIL
        </span>
      </div>

      <div className={`tcd-arch-detail ${selected ? 'has-selection' : ''}`}>
        {selected ? (
          <>
            <strong>{selected.label}</strong>
            <span className={`pill tcd-${selected.status}`}>{selected.status.toUpperCase()}</span>
            {selected.detail ? (
              <p className="muted small">{selected.detail}</p>
            ) : (
              <p className="muted small">No probe wired for this node — inferred healthy or not monitored.</p>
            )}
          </>
        ) : (
          <p className="muted small tcd-arch-detail-empty">Select a component to see live probe details.</p>
        )}
      </div>
    </div>
  )
}
