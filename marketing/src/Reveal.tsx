import type { ReactNode, RefObject } from 'react'
import { useReveal } from './useReveal'

export function Reveal({
  children,
  as: Tag = 'div',
  id,
  className = '',
  delayMs = 0,
}: {
  children: ReactNode
  as?: 'div' | 'section'
  id?: string
  className?: string
  delayMs?: number
}) {
  const { ref, visible } = useReveal<HTMLElement>()
  return (
    <Tag
      id={id}
      ref={ref as RefObject<HTMLDivElement & HTMLElement>}
      className={`reveal ${visible ? 'reveal-visible' : ''} ${className}`.trim()}
      style={{ transitionDelay: visible ? `${delayMs}ms` : '0ms' }}
    >
      {children}
    </Tag>
  )
}
