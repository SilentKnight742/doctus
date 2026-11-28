import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A floating window over the canvas: drag it by its title bar, minimise it to
 * a small bar (button or double-click on the bar). A window docked at the
 * bottom keeps its foot in place when minimised (the bar sits where the
 * window ended); one docked at the top keeps its title bar in place.
 * Position and minimised state are remembered per window (`storeKey`) in this
 * browser; every storage access is guarded.
 */
interface Place {
  left: number
  /** Distance from the docked edge (bottom or top) of the viewport. */
  y: number
  min: boolean
}

const MARGIN = 8
/** Keep windows below the screen's top bar. */
const TOP = 64
const BAR_HEIGHT = 40
const BAR_WIDTH = 256

function load(key: string, fallback: Place): Place {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    if (v && typeof v.left === 'number' && typeof v.y === 'number' && typeof v.min === 'boolean') return v
  } catch {
    // storage unavailable or bad data: use the default
  }
  return fallback
}

function save(key: string, p: Place) {
  try {
    window.localStorage.setItem(key, JSON.stringify(p))
  } catch {
    // per-viewer convenience only
  }
}

export interface FloatingWindowProps {
  storeKey: string
  title: string
  /** Which viewport edge the window is docked to. */
  dock?: 'bottom' | 'top'
  /** Default distance from the left edge, or from the right edge with `right`. */
  left?: number
  right?: number
  /** Default distance from the docked edge (below the top bar for `top`). */
  offset?: number
  width: number
  height: number
  minimised?: boolean
  badge?: ReactNode
  className?: string
  children: ReactNode
}

export function FloatingWindow({
  storeKey,
  title,
  dock = 'bottom',
  left,
  right,
  offset = 16,
  width,
  height,
  minimised = false,
  badge,
  className,
  children,
}: FloatingWindowProps) {
  const [place, setPlace] = useState<Place>(() =>
    load(storeKey, {
      left: left ?? (right != null ? window.innerWidth - (minimised ? BAR_WIDTH : width) - right : 16),
      y: dock === 'top' ? TOP + offset : offset,
      min: minimised,
    }),
  )
  const [, setViewport] = useState(0)
  const drag = useRef<{ x: number; y: number; start: Place } | null>(null)

  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(width, vw - 2 * MARGIN)
  const h = Math.min(height, vh - TOP - 2 * MARGIN)
  const boxW = place.min ? BAR_WIDTH : w
  const boxH = place.min ? BAR_HEIGHT : h
  // Keep the window (or its bar) on screen and below the top bar.
  const shown: Place = {
    ...place,
    left: Math.max(MARGIN, Math.min(place.left, vw - boxW - MARGIN)),
    y:
      dock === 'top'
        ? Math.max(TOP, Math.min(place.y, vh - boxH - MARGIN))
        : Math.max(MARGIN, Math.min(place.y, vh - boxH - TOP)),
  }
  const update = (p: Place) => {
    setPlace(p)
    save(storeKey, p)
  }
  // A window on the right half keeps its right edge when it folds or opens.
  const toggle = () => {
    const nextW = place.min ? w : BAR_WIDTH
    const onRight = shown.left + boxW / 2 > vw / 2
    update({ ...shown, left: onRight ? shown.left + boxW - nextW : shown.left, min: !place.min })
  }

  return (
    <section
      className={`float-win${place.min ? ' is-min' : ''}${className ? ` ${className}` : ''}`}
      style={{ left: shown.left, [dock]: shown.y, width: boxW, height: place.min ? undefined : h }}
      aria-label={title}
    >
      <header
        className="float-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, start: shown }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const dy = e.clientY - d.y
          setPlace({ ...d.start, left: d.start.left + e.clientX - d.x, y: d.start.y + (dock === 'top' ? dy : -dy) })
        }}
        onPointerUp={() => {
          if (!drag.current) return
          drag.current = null
          update(shown)
        }}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) toggle()
        }}
      >
        <h2 className="float-title">{title}</h2>
        {badge}
        <button
          type="button"
          className="icon-button small"
          aria-label={`${place.min ? 'Expand' : 'Minimise'} ${title}`}
          aria-expanded={!place.min}
          onClick={toggle}
        >
          {/* The arrow points the way the window opens or folds. */}
          {place.min === (dock === 'bottom') ? '▴' : '▾'}
        </button>
      </header>
      {/* The body stays mounted while minimised, so a streaming reply keeps going. */}
      <div className="float-body" hidden={place.min}>
        {children}
      </div>
    </section>
  )
}
