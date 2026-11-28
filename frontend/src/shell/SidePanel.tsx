import { useState, type ReactNode } from 'react'

export interface PanelTab {
  id: string
  label: string
  body: ReactNode
  /** A wider panel for this tab (e.g. trackers), as a CSS length. */
  width?: string
}

const KEY = 'doctus.panel.open'

function loadOpen(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'false'
  } catch {
    return true
  }
}

/** The right-hand panel: tabs (chat, space widgets), collapsible. */
export function SidePanel({ tabs }: { tabs: PanelTab[] }) {
  const [active, setActive] = useState(tabs[0].id)
  const [open, setOpen] = useState(loadOpen)
  const toggle = () => {
    setOpen((o) => {
      try {
        window.localStorage.setItem(KEY, String(!o))
      } catch {
        // per-viewer convenience only
      }
      return !o
    })
  }
  if (!open)
    return (
      <aside className="side-panel is-collapsed">
        <button type="button" className="panel-expand" onClick={toggle} aria-label="Show panel">
          ‹ {tabs[0].label}
        </button>
      </aside>
    )
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]
  return (
    <aside className="side-panel" style={tab.width ? { width: tab.width } : undefined}>
      <div className="side-panel-head" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab.id}
            className="panel-tab"
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="demo-badge small">Demo · scripted agent</span>
        <button type="button" className="icon-button" aria-label="Hide panel" onClick={toggle}>
          ›
        </button>
      </div>
      {/* Every tab stays mounted, so a streaming reply survives a tab switch. */}
      {tabs.map((t) => (
        <div key={t.id} className="side-panel-body" role="tabpanel" hidden={t.id !== tab.id}>
          {t.body}
        </div>
      ))}
    </aside>
  )
}
