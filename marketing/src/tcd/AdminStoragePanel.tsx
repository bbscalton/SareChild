import { useEffect, useMemo, useState } from 'react'
import * as adminRepo from './adminRepo'
import type { InfraStatus, StorageAccountRow, StorageDump, StorageFeatureRow } from './types'

function fmtBytes(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function pct(used: number, max: number): number {
  if (!max || max <= 0) return 0
  return Math.min(100, Math.round((used / max) * 100))
}

function parseMb(raw: string, fallbackMb: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallbackMb * 1024 * 1024
  return Math.round(n * 1024 * 1024)
}

const PREFERRED_FAMILY_ID = 'tS2mTEiFqoY76nq7ei1d'
const PREFERRED_ADMIN_EMAIL = 'neuereatec@gmail.com'

function emptyAccount(familyId: string): StorageAccountRow {
  return {
    familyId,
    parentUid: null,
    email: '',
    childNames: [],
    deviceCount: 0,
    firestoreDocs: 0,
    r2Bytes: 0,
    r2Objects: 0,
    estimatedFirestoreBytes: 0,
    usedBytes: 0,
    accountBytesMax: 2 * 1024 * 1024 * 1024,
    overLimit: false,
    storageBlocked: false,
    features: {},
  }
}

export function AdminStoragePanel({
  busy,
  onBusy,
  onStatus,
  onError,
}: {
  busy: boolean
  onBusy: (v: boolean) => void
  onStatus: (msg: string) => void
  onError: (msg: string | null) => void
}) {
  const [dump, setDump] = useState<StorageDump | null>(null)
  const [infra, setInfra] = useState<InfraStatus | null>(null)
  const [dumpError, setDumpError] = useState<string | null>(null)
  const [infraError, setInfraError] = useState<string | null>(null)
  const [scanningDump, setScanningDump] = useState(true)
  const [showLegacyNote, setShowLegacyNote] = useState(false)
  const [featureEdits, setFeatureEdits] = useState<Record<string, string>>({})
  const [globalGb, setGlobalGb] = useState('50')
  const [accountGb, setAccountGb] = useState('2')
  const [selectedFamily, setSelectedFamily] = useState(PREFERRED_FAMILY_ID)
  const [familyIdInput, setFamilyIdInput] = useState(PREFERRED_FAMILY_ID)
  const [confirmText, setConfirmText] = useState('')
  const [search, setSearch] = useState('')
  const [pcFiles, setPcFiles] = useState<Array<{ path: string; bytes: number; mtimeMs: number }>>([])
  const [pcListNote, setPcListNote] = useState<string | null>(null)

  const applyDump = (storage: StorageDump) => {
    const accounts = Array.isArray(storage?.accounts) ? storage.accounts : []
    const features = Array.isArray(storage?.features) ? storage.features : []
    const limits = storage?.limits ?? {
      globalBytesMax: 50 * 1024 * 1024 * 1024,
      defaultAccountBytesMax: 2 * 1024 * 1024 * 1024,
      featureBytesMax: {},
      updatedAtMs: 0,
      updatedBy: null,
    }
    const normalized: StorageDump = {
      ...storage,
      accounts,
      features,
      limits,
      backends: storage?.backends ?? {
        r2: {
          reachable: false,
          error: null,
          bytes: 0,
          objects: 0,
          truncated: false,
          otherBytes: 0,
          bucket: 'luscsl-uploads',
        },
        firestore: { docs: 0, estimatedBytes: 0, families: 0 },
        firebaseStorage: { bytes: 0, objects: 0, truncated: false, error: null },
        d1: {},
        kv: { note: '' },
      },
    }
    setDump(normalized)
    const globalCap = normalized.limits.globalBytesMax || 50 * 1024 * 1024 * 1024
    const accountCap = normalized.limits.defaultAccountBytesMax || 2 * 1024 * 1024 * 1024
    setGlobalGb(String((globalCap / (1024 * 1024 * 1024)).toFixed(0)))
    setAccountGb(String((accountCap / (1024 * 1024 * 1024)).toFixed(2)))
    const edits: Record<string, string> = {}
    for (const f of features) {
      edits[f.id] = String(((f.limitBytes || 0) / (1024 * 1024)).toFixed(0))
    }
    setFeatureEdits(edits)
    setSelectedFamily((prev) => {
      if (prev && accounts.some((a) => a.familyId === prev)) return prev
      if (accounts.some((a) => a.familyId === PREFERRED_FAMILY_ID)) return PREFERRED_FAMILY_ID
      const byEmail = accounts.find((a) => (a.email || '').toLowerCase() === PREFERRED_ADMIN_EMAIL)
      return byEmail?.familyId || accounts[0]?.familyId || prev || PREFERRED_FAMILY_ID
    })
  }

  const load = async (label: string) => {
    onBusy(true)
    setScanningDump(true)
    setDumpError(null)
    setInfraError(null)
    let dumpFailed = false
    let dumpApplied = false
    const dumpTask = (async () => {
      try {
        const storage = await adminRepo.adminGetStorageDump()
        applyDump(storage)
        dumpApplied = true
        const issues = [
          storage.error,
          ...(storage.warnings ?? []),
          storage.stale ? 'Showing a cached dump; live scan failed or was incomplete.' : null,
        ].filter(Boolean) as string[]
        if (issues.length) {
          setDumpError(issues.join(' · '))
          onError(issues[0])
        } else {
          onError(null)
        }
      } catch (e) {
        dumpFailed = true
        const msg = e instanceof Error ? e.message : 'Storage dump failed'
        setDumpError(msg)
        onError(msg)
      }
    })()
    const infraTask = (async () => {
      try {
        setInfra(await adminRepo.adminGetInfraStatus())
      } catch (e) {
        setInfraError(e instanceof Error ? e.message : 'PC health / infra status failed')
      }
    })()
    await Promise.allSettled([dumpTask, infraTask])
    if (dumpApplied && !dumpFailed) onStatus(label)
    setScanningDump(false)
    onBusy(false)
  }

  useEffect(() => {
    void load('Storage dump loaded.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const accounts = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = dump?.accounts ?? []
    if (!q) return rows
    return rows.filter(
      (a) =>
        (a.email || '').toLowerCase().includes(q) ||
        a.familyId.toLowerCase().includes(q) ||
        a.childNames.some((n) => String(n).toLowerCase().includes(q)),
    )
  }, [dump, search])

  const selected: StorageAccountRow | undefined =
    dump?.accounts.find((a) => a.familyId === selectedFamily) ??
    (selectedFamily.trim() ? emptyAccount(selectedFamily.trim()) : undefined)

  const saveLimits = async () => {
    onBusy(true)
    onError(null)
    try {
      const featureBytesMax: Record<string, number> = {}
      for (const [id, raw] of Object.entries(featureEdits)) {
        featureBytesMax[id] = parseMb(raw, 100)
      }
      await adminRepo.adminSetStorageLimits({
        globalBytesMax: Number(globalGb) * 1024 * 1024 * 1024,
        defaultAccountBytesMax: Number(accountGb) * 1024 * 1024 * 1024,
        featureBytesMax,
      })
      onStatus('Storage limits saved. New uploads over the account cap are rejected.')
      await load('Limits applied.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save limits')
      onBusy(false)
    }
  }

  const saveAccountCap = async (familyId: string, gb: string) => {
    onBusy(true)
    onError(null)
    try {
      await adminRepo.adminSetStorageLimits({ familyId, accountBytesMax: Number(gb) * 1024 * 1024 * 1024 })
      onStatus(`Account cap updated for ${familyId}.`)
      await load('Account cap saved.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not set account cap')
      onBusy(false)
    }
  }

  const clearFeature = async (familyId: string, feature: StorageFeatureRow['id'] | string) => {
    if (!window.confirm(`Clear ${feature} data for this account? Firestore rows and R2 objects are deleted.`)) return
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminClearStorage({ scope: 'feature', familyId, feature })
      onStatus(`Cleared ${feature}: ${result.docs} docs, ${result.media} media objects.`)
      await load('Dump refreshed after feature clear.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Clear failed')
      onBusy(false)
    }
  }

  const clearAccount = async () => {
    if (!selected) return
    if (confirmText !== 'CLEAR-ACCOUNT') {
      onError('Type CLEAR-ACCOUNT to wipe this account’s stored data (login/pairing kept).')
      return
    }
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminClearStorage({
        scope: 'account',
        familyId: selected.familyId,
        confirm: 'CLEAR-ACCOUNT',
      })
      setConfirmText('')
      onStatus(`Account data cleared: ${result.docs} docs, ${result.media} media objects.`)
      await load('Dump refreshed after account clear.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Account clear failed')
      onBusy(false)
    }
  }

  const factoryResetAccount = async () => {
    if (!selected) return
    if (confirmText !== 'FACTORY-RESET') {
      onError('Type FACTORY-RESET to delete this family’s devices, media, and event data.')
      return
    }
    onBusy(true)
    onError(null)
    try {
      await adminRepo.adminFactoryResetAccount(selected.familyId, 'FACTORY-RESET')
      setConfirmText('')
      onStatus(`Factory reset family ${selected.familyId}.`)
      await load('Dump refreshed after factory reset.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Factory reset failed')
      onBusy(false)
    }
  }

  const factoryResetPlatform = async () => {
    if (confirmText !== 'RESET-PLATFORM') {
      onError('Type RESET-PLATFORM to wipe operational data for every family (accounts stay).')
      return
    }
    if (!window.confirm('This deletes alerts, trails, recordings, and media for ALL families. Continue?')) return
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminClearStorage({ scope: 'platform', confirm: 'RESET-PLATFORM' })
      setConfirmText('')
      onStatus(`Platform wipe: ${result.families} families, ${result.docs} docs, ${result.media} media.`)
      await load('Dump refreshed after platform wipe.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Platform wipe failed')
      onBusy(false)
    }
  }

  const pc = infra?.pc
  const pcDisk = pc?.disk
  const pcBackend = dump?.backends?.pcXampp
  const dumpScanning = scanningDump || (busy && !dump && !dumpError)

  const listPcStore = async () => {
    onBusy(true)
    onError(null)
    setPcListNote(null)
    try {
      const result = await adminRepo.adminManagePcStorage('list')
      setPcFiles(result.files ?? [])
      setPcListNote(
        `${result.storeFiles ?? result.files?.length ?? 0} files · ${fmtBytes(result.storeBytes)} in ${result.storePath || 'store/'}`,
      )
      onStatus('PC archive listed.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not list the PC store')
    } finally {
      onBusy(false)
    }
  }

  const clearPcStore = async () => {
    if (confirmText !== 'CLEAR-PC-STORE') {
      onError('Type CLEAR-PC-STORE to wipe files under C:\\xampp2\\htdocs\\sarechild-storage\\store (R2 is not touched).')
      return
    }
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminClearStorage({ scope: 'pc-store', confirm: 'CLEAR-PC-STORE' })
      setConfirmText('')
      setPcFiles([])
      onStatus(
        `PC archive cleared: ${result.media} files (${fmtBytes(result.deletedBytes)}). Path ${result.storePath || 'store/'}.`,
      )
      await load('Dump refreshed after PC store clear.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'PC store clear failed')
      onBusy(false)
    }
  }

  return (
    <div className="tcd-storage">
      <div className="tcd-admin-panel-head">
        <div>
          <h2>Storage &amp; infrastructure</h2>
          <p className="muted small">
            Storage backends: Cloudflare R2 (live media), Firestore (family docs), and this Windows PC (XAMPP
            archive via Cloudflare Worker). Live child uploads go to R2 / Firestore — the PC folder is ops health plus
            an archive you can list and clear.
          </p>
          <label className="muted small" style={{ display: 'block', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              checked={showLegacyNote}
              onChange={(e) => setShowLegacyNote(e.target.checked)}
            />{' '}
            Show unused legacy note
          </label>
          {showLegacyNote ? <p className="muted small">Legacy droplet unused.</p> : null}
        </div>
        <button className="btn btn-primary compact" type="button" disabled={busy} onClick={() => void load('Dump refreshed.')}>
          {busy ? 'Scanning…' : 'Refresh dump'}
        </button>
      </div>

      {(dumpError || infraError) && (
        <div className="tcd-banner error" style={{ marginBottom: '1rem' }}>
          {dumpError ? (
            <div>
              Cloud dump: {dumpError}
              {pc?.reachableFromFunctions
                ? ' PC disk below is XAMPP health only — it does not mean R2 / Firestore loaded.'
                : ''}
            </div>
          ) : null}
          {infraError ? <div>This PC probe: {infraError}</div> : null}
        </div>
      )}
      {dump?.warnings && dump.warnings.length > 0 && !dumpError && (
        <p className="muted small">Partial dump: {dump.warnings.join(' · ')}</p>
      )}

      <div className="tcd-pulse-grid">
        <article className="tcd-pulse-card">
          <p className="tcd-pulse-eyebrow">Platform used</p>
          <p className="tcd-pulse-value">{dump ? fmtBytes(dump.totals?.usedBytes) : dumpScanning ? '…' : fmtBytes(0)}</p>
          <p className="tcd-pulse-meta">of {fmtBytes(dump?.limits?.globalBytesMax || 50 * 1024 * 1024 * 1024)} global cap</p>
        </article>
        <article className="tcd-pulse-card">
          <p className="tcd-pulse-eyebrow">Cloudflare R2</p>
          <p className="tcd-pulse-value">{dump ? fmtBytes(dump.backends?.r2?.bytes) : dumpScanning ? '…' : fmtBytes(0)}</p>
          <p className="tcd-pulse-meta">
            {dump?.backends?.r2?.objects ?? 0} objects · bucket {dump?.backends?.r2?.bucket || 'luscsl-uploads'}
            {dump?.backends?.r2?.error ? ` · ${dump.backends.r2.error}` : ''}
          </p>
        </article>
        <article className="tcd-pulse-card">
          <p className="tcd-pulse-eyebrow">Firestore</p>
          <p className="tcd-pulse-value">
            {dump?.backends?.firestore?.docs ?? (dumpScanning ? '…' : dumpError ? '—' : 0)}
          </p>
          <p className="tcd-pulse-meta">
            {fmtBytes(dump?.backends?.firestore?.estimatedBytes)} estimated · {dump?.backends?.firestore?.families ?? 0}{' '}
            families
          </p>
        </article>
        <article className="tcd-pulse-card">
          <p className="tcd-pulse-eyebrow">Accounts over cap</p>
          <p className={`tcd-pulse-value ${dump && (dump.totals?.overLimitCount ?? 0) > 0 ? 'fail' : ''}`}>
            {dump?.totals?.overLimitCount ?? 0}
          </p>
          <p className="tcd-pulse-meta">{dump?.totals?.accountCount ?? 0} parent accounts scanned</p>
        </article>
        <article className="tcd-pulse-card">
          <p className="tcd-pulse-eyebrow">Cloudflare Tunnel → this PC</p>
          <p className="tcd-pulse-value">
            {pcDisk ? fmtBytes(pcDisk.usedBytes) : pcBackend?.diskUsedBytes ? fmtBytes(pcBackend.diskUsedBytes) : '—'}
          </p>
          <p className="tcd-pulse-meta">
            {pc?.reachableFromFunctions || pcBackend?.reachable
              ? `of ${fmtBytes(pcDisk?.totalBytes ?? pcBackend?.diskTotalBytes)} on ${pcDisk?.drive ?? pcBackend?.drive ?? 'C:'}`
              : 'Not reachable from Cloud Functions yet'}
          </p>
        </article>
      </div>

      <div className="tcd-card tcd-card-wide">
        <div className="tcd-card-head">
          <h2>This PC (XAMPP)</h2>
          <span className="tcd-card-timestamp">Cloudflare Tunnel (free) → this PC Apache</span>
        </div>
        <p className="muted small">
          Cloudflare (free) publishes this Windows PC archive at{" "}
          <code>sarechild-pc-storage.neuereatec.workers.dev</code> → Apache/PHP on this machine
          (<code>C:\xampp2\htdocs\sarechild-storage</code>). That folder is a <strong>local archive + disk dump</strong>,
          not the live media bucket — child devices still upload to Cloudflare R2 and Firestore.
        </p>
        <ul className="tcd-vps-roles">
          {(pc?.roles ?? []).map((r) => (
            <li key={r.id}>
              <strong>{r.label}</strong>
              <span>{r.detail}</span>
            </li>
          ))}
        </ul>
        <div className="tcd-vps-probes">
          <span className={`pill tcd-${pc?.reachableFromFunctions ? 'ok' : pc?.probe?.inconclusive ? 'warn' : 'fail'}`}>
            {pc?.reachableFromFunctions
              ? `Functions reached health.json (${pc.probe?.latencyMs} ms)`
              : pc?.publicUrl
                ? 'Functions could not reach the tunnel URL'
                : 'XAMPP_STORAGE_URL not set on Functions'}
          </span>
          <span className={`pill tcd-${pc?.secretConfigured ? 'ok' : 'warn'}`}>
            {pc?.secretConfigured ? 'Clear-store secret configured' : 'Set XAMPP_STORAGE_SECRET to list/clear'}
          </span>
        </div>
        {pcDisk && (
          <p className="muted small" style={{ marginTop: '0.75rem' }}>
            Drive {pcDisk.drive} {fmtBytes(pcDisk.usedBytes)} / {fmtBytes(pcDisk.totalBytes)} ({pcDisk.percent}%) ·
            archive {fmtBytes(pcDisk.storeBytes)} ({pcDisk.storeFiles} files)
          </p>
        )}
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          {pc?.mixedContentNote ||
            'GitHub Pages is HTTPS, so this tab cannot fetch http://127.0.0.1/sarechild-storage (mixed content). Open that URL in a separate tab on this PC. Cloud Functions also cannot see the PC loopback — a Cloudflare Tunnel hostname is required.'}
        </p>
        {pc?.probe?.note && <p className="muted small">{pc.probe.note}</p>}
        {pc?.tunnelHint && <p className="muted small">{pc.tunnelHint}</p>}
        <p className="muted small">
          Local health (this PC only):{' '}
          <a href={pc?.localHealthUrl ?? 'http://127.0.0.1/sarechild-storage/health.json'} target="_blank" rel="noreferrer">
            {pc?.localHealthUrl ?? 'http://127.0.0.1/sarechild-storage/health.json'}
          </a>
          {' · '}
          Folder <code>{pcDisk?.storePath ?? pcBackend?.storePath ?? 'C:\\xampp2\\htdocs\\sarechild-storage\\store'}</code>
        </p>
        <div className="tcd-system-actions" style={{ marginTop: '0.75rem' }}>
          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void listPcStore()}>
            List PC archive
          </button>
          <button className="btn btn-ghost compact danger" type="button" disabled={busy} onClick={() => void clearPcStore()}>
            Clear PC archive
          </button>
        </div>
        {pcListNote && <p className="muted small">{pcListNote}</p>}
        {pcFiles.length > 0 && (
          <div className="tcd-table-wrap" style={{ marginTop: '0.75rem' }}>
            <table className="tcd-admin-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {pcFiles.map((f) => (
                  <tr key={f.path}>
                    <td>
                      <code>{f.path}</code>
                    </td>
                    <td>{fmtBytes(f.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="tcd-card tcd-card-wide">
        <div className="tcd-card-head">
          <h2>Platform limits</h2>
          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void saveLimits()}>
            Save limits
          </button>
        </div>
        <div className="tcd-form-grid">
          <label>
            Global cap (GB)
            <input type="number" min={1} step={1} value={globalGb} onChange={(e) => setGlobalGb(e.target.value)} />
          </label>
          <label>
            Default per-account cap (GB)
            <input type="number" min={0.25} step={0.25} value={accountGb} onChange={(e) => setAccountGb(e.target.value)} />
          </label>
        </div>
        <p className="muted small" style={{ margin: '0.75rem 0' }}>
          Feature caps (MB). Accounts that exceed their cap are flagged and new R2 uploads can be rejected.
        </p>
        <div className="tcd-table-wrap">
          <table className="tcd-admin-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>R2 media</th>
                <th>Firestore</th>
                <th>Cap (MB)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(dump?.features ?? []).map((f) => (
                <tr key={f.id}>
                  <td>
                    <div className="tcd-cell-main">{f.label}</div>
                    <div className="tcd-cell-sub">{f.id}</div>
                  </td>
                  <td>
                    {fmtBytes(f.r2Bytes)} ({f.r2Objects})
                  </td>
                  <td>
                    {f.docs} docs · {fmtBytes(f.estimatedBytes)}
                  </td>
                  <td>
                    <input
                      className="tcd-admin-input-sm"
                      type="number"
                      min={0}
                      value={featureEdits[f.id] ?? ''}
                      onChange={(e) => setFeatureEdits((p) => ({ ...p, [f.id]: e.target.value }))}
                    />
                  </td>
                  <td>
                    {selected && (
                      <button
                        className="btn btn-ghost compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void clearFeature(selected.familyId, f.id)}
                      >
                        Clear on selected
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="tcd-card tcd-card-wide">
        <div className="tcd-card-head">
          <h2>Per-account usage</h2>
          <input
            className="tcd-admin-search"
            type="search"
            placeholder="Filter email / family / child"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="tcd-form-grid" style={{ marginBottom: '0.75rem' }}>
          <label>
            Family ID to manage
            <input
              type="text"
              value={familyIdInput}
              onChange={(e) => setFamilyIdInput(e.target.value)}
              placeholder={PREFERRED_FAMILY_ID}
            />
          </label>
          <div style={{ alignSelf: 'end' }}>
            <button
              className="btn btn-primary compact"
              type="button"
              onClick={() => {
                const id = familyIdInput.trim() || PREFERRED_FAMILY_ID
                setFamilyIdInput(id)
                setSelectedFamily(id)
              }}
            >
              Manage this family
            </button>
          </div>
        </div>
        <div className="tcd-table-wrap">
          <table className="tcd-admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Used</th>
                <th>Cap</th>
                <th>R2</th>
                <th>Docs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.familyId} className={a.overLimit ? 'row-blocked' : ''}>
                  <td>
                    <div className="tcd-cell-main">{a.email || 'no email'}</div>
                    <div className="tcd-cell-sub">
                      {a.familyId.slice(0, 10)}… · {a.deviceCount} device(s)
                    </div>
                  </td>
                  <td>{fmtBytes(a.usedBytes)}</td>
                  <td>
                    {fmtBytes(a.accountBytesMax)}
                    <div className="tcd-storage-bar">
                      <span style={{ width: `${pct(a.usedBytes, a.accountBytesMax)}%` }} />
                    </div>
                  </td>
                  <td>{fmtBytes(a.r2Bytes)}</td>
                  <td>{a.firestoreDocs}</td>
                  <td>
                    <button className="btn btn-ghost compact" type="button" onClick={() => setSelectedFamily(a.familyId)}>
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={6} className="tcd-empty-note">
                    {dumpError
                      ? 'Dump failed — use Family ID above to Manage / Clear / Reset anyway.'
                      : dumpScanning
                        ? 'Scanning families…'
                        : 'No families in this dump yet. Paste a family ID above to manage one.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="tcd-card tcd-card-wide">
          <div className="tcd-card-head">
            <h2>Manage {selected.email || selected.familyId}</h2>
            <button className="btn btn-ghost compact" type="button" onClick={() => setSelectedFamily('')}>
              Close
            </button>
          </div>
          <p className="muted small">
            Children: {selected.childNames.join(', ') || 'none'}. Over limit: {selected.overLimit ? 'yes' : 'no'}
            {selected.storageBlocked ? ' · uploads blocked' : ''}.
          </p>
          <div className="tcd-form-grid">
            <label>
              This account cap (GB)
              <input
                type="number"
                min={0.25}
                step={0.25}
                defaultValue={(selected.accountBytesMax / (1024 * 1024 * 1024)).toFixed(2)}
                onBlur={(e) => void saveAccountCap(selected.familyId, e.target.value)}
              />
            </label>
            <label>
              Confirm destructive action
              <input
                type="text"
                autoComplete="off"
                placeholder="CLEAR-ACCOUNT / FACTORY-RESET / RESET-PLATFORM / CLEAR-PC-STORE"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </label>
          </div>
          <div className="tcd-system-actions" style={{ marginTop: '0.75rem' }}>
            <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void clearAccount()}>
              Clear stored data (keep pairing)
            </button>
            <button className="btn btn-ghost compact danger" type="button" disabled={busy} onClick={() => void factoryResetAccount()}>
              Factory reset this family
            </button>
            <button className="btn btn-ghost compact danger" type="button" disabled={busy} onClick={() => void factoryResetPlatform()}>
              Factory reset ALL operational data
            </button>
          </div>
          <div className="tcd-table-wrap" style={{ marginTop: '1rem' }}>
            <table className="tcd-admin-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>R2</th>
                  <th>Docs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(selected.features).map(([id, usage]) => (
                  <tr key={id}>
                    <td>{id}</td>
                    <td>
                      {fmtBytes(usage.r2Bytes)} ({usage.r2Objects})
                    </td>
                    <td>{usage.docs}</td>
                    <td>
                      <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void clearFeature(selected.familyId, id)}>
                        Clear
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
