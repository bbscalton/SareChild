import type { ArchNode, TcdCheck, TcdCheckStatus } from './types'

type NodeDef = {
  id: string
  label: string
  group: ArchNode['group']
  x: number
  y: number
  url?: string
  checkIds?: string[]
  siteIds?: string[]
}

const NODES: NodeDef[] = [
  { id: 'parent-web', label: 'Parent web', group: 'client', x: 80, y: 60, url: 'parent-web', siteIds: ['parent-web'] },
  { id: 'parent-apk', label: 'Parent APK', group: 'client', x: 80, y: 140, checkIds: ['parent-apk'] },
  { id: 'child-apk', label: 'Child APK', group: 'client', x: 80, y: 220, checkIds: ['child-apk'] },
  { id: 'firebase-auth', label: 'Firebase Auth', group: 'firebase', x: 280, y: 40, checkIds: ['firebase-auth'] },
  { id: 'firestore', label: 'Firestore', group: 'firebase', x: 280, y: 100, checkIds: ['firestore-family', 'alerts-read'] },
  { id: 'fcm', label: 'FCM', group: 'firebase', x: 280, y: 160 },
  { id: 'firebase-hosting', label: 'Firebase Hosting', group: 'hosting', x: 280, y: 220, siteIds: ['parent-web'] },
  { id: 'functions', label: 'Cloud Functions', group: 'firebase', x: 280, y: 280, checkIds: ['functions-health'] },
  { id: 'cf-worker', label: 'Cloudflare Worker', group: 'edge', x: 480, y: 80, checkIds: ['platform-health', 'r2-proxy'] },
  { id: 'r2', label: 'R2 storage', group: 'edge', x: 480, y: 140, checkIds: ['r2-proxy', 'parent-apk', 'child-apk'] },
  { id: 'd1', label: 'D1', group: 'edge', x: 480, y: 200, checkIds: ['platform-health'] },
  { id: 'kv', label: 'KV', group: 'edge', x: 480, y: 260, checkIds: ['platform-health'] },
  { id: 'gh-pages', label: 'GitHub Pages', group: 'hosting', x: 680, y: 60, siteIds: ['marketing-site', 'tcd-page'] },
  { id: 'gh-repo', label: 'GitHub repo', group: 'hosting', x: 680, y: 120 },
  { id: 'tcd', label: 'TCD console', group: 'hosting', x: 680, y: 180, siteIds: ['tcd-page'] },
  { id: 'google-maps', label: 'Google Maps', group: 'external', x: 680, y: 260, checkIds: ['google-maps'] },
]

const EDGES: [string, string][] = [
  ['parent-web', 'firebase-auth'],
  ['parent-web', 'firestore'],
  ['parent-apk', 'firebase-auth'],
  ['parent-apk', 'firestore'],
  ['child-apk', 'firestore'],
  ['child-apk', 'fcm'],
  ['parent-web', 'cf-worker'],
  ['parent-apk', 'cf-worker'],
  ['child-apk', 'r2'],
  ['firestore', 'cf-worker'],
  ['cf-worker', 'r2'],
  ['cf-worker', 'd1'],
  ['cf-worker', 'kv'],
  ['gh-pages', 'tcd'],
  ['parent-web', 'google-maps'],
  ['firebase-hosting', 'parent-web'],
  ['functions', 'firestore'],
]

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
  external: '#b8a0ff',
}

export function ArchitectureTree({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: ArchNode[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const nodeMap = new Map(NODES.map((n) => [n.id, n]))
  const archMap = new Map(nodes.map((n) => [n.id, n]))

  return (
    <div className="tcd-arch-wrap">
      <svg viewBox="0 0 780 320" className="tcd-arch-svg" role="img" aria-label="SareChild architecture diagram">
        <defs>
          <marker id="arch-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.35)" />
          </marker>
        </defs>
        {EDGES.map(([from, to]) => {
          const a = nodeMap.get(from)
          const b = nodeMap.get(to)
          if (!a || !b) return null
          return (
            <line
              key={`${from}-${to}`}
              x1={a.x + 70}
              y1={a.y + 18}
              x2={b.x}
              y2={b.y + 18}
              className="tcd-arch-edge"
              markerEnd="url(#arch-arrow)"
            />
          )
        })}
        {NODES.map((n) => {
          const arch = archMap.get(n.id)
          const status = arch?.status ?? 'warn'
          const selected = selectedId === n.id
          return (
            <g
              key={n.id}
              transform={`translate(${n.x}, ${n.y})`}
              className={`tcd-arch-node ${selected ? 'selected' : ''}`}
              onClick={() => onSelect(n.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect(n.id)
              }}
            >
              <rect width="140" height="36" rx="8" className={`tcd-arch-rect group-${n.group} status-${status}`} />
              <circle cx="126" cy="10" r="5" className={`tcd-arch-badge status-${status}`} />
              <text x="12" y="23" className="tcd-arch-label">
                {n.label}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="tcd-arch-legend">
        {(['client', 'firebase', 'edge', 'hosting', 'external'] as const).map((g) => (
          <span key={g} className="tcd-arch-legend-item">
            <span className="tcd-arch-legend-dot" style={{ background: GROUP_COLORS[g] }} />
            {g}
          </span>
        ))}
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
      {selectedId && archMap.get(selectedId) && (
        <div className="tcd-arch-detail">
          <strong>{archMap.get(selectedId)!.label}</strong>
          <span className={`pill tcd-${archMap.get(selectedId)!.status}`}>{archMap.get(selectedId)!.status.toUpperCase()}</span>
          {archMap.get(selectedId)!.detail && <p className="muted small">{archMap.get(selectedId)!.detail}</p>}
        </div>
      )}
    </div>
  )
}
