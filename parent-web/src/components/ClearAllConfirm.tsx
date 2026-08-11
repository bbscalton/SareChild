export const CLEAR_CONFIRM_TEXT = 'CLEAR'

import type { ReactNode } from 'react'

type ClearAllConfirmProps = {
  open: boolean
  title: string
  description: ReactNode
  confirmText: string
  onConfirmTextChange: (value: string) => void
  error: string | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
  className?: string
}

export function ClearAllConfirm({
  open,
  title,
  description,
  confirmText,
  onConfirmTextChange,
  error,
  busy,
  onConfirm,
  onCancel,
  confirmLabel = 'Permanently clear',
  className = 'device-remove-confirm eventrecorder-clear-confirm',
}: ClearAllConfirmProps) {
  if (!open) return null

  return (
    <div className={className}>
      <p className="error">
        <strong>{title}</strong>
        <br />
        {description}
      </p>
      <label>
        Type &quot;{CLEAR_CONFIRM_TEXT}&quot; to confirm
        <input
          value={confirmText}
          onChange={(e) => onConfirmTextChange(e.target.value)}
          placeholder={CLEAR_CONFIRM_TEXT}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="device-remove-actions">
        <button className="btn danger" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? 'Clearing…' : confirmLabel}
        </button>
        <button className="btn ghost compact" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
