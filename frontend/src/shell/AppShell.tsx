import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useMatch, useNavigate } from 'react-router'
import { api } from '../api/client'
import { applyTheme, loadTheme, type ThemeChoice } from '../lib/theme'

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' }
const LABEL: Record<ThemeChoice, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }

/** The left rail (spaces, the open space's worlds, demo controls, theme) and the main area. */
export function AppShell() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces })
  const match = useMatch('/s/:spaceId/*')
  const spaceId = match ? Number(match.params.spaceId) : null
  const space = useQuery({
    queryKey: ['space', spaceId],
    queryFn: () => api.getSpace(spaceId!),
    enabled: spaceId != null && Number.isFinite(spaceId),
  })
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme)
  const [confirmReset, setConfirmReset] = useState(false)
  useEffect(() => applyTheme(theme), [theme])

  return (
    <div className="shell">
      <nav className="rail" aria-label="Spaces">
        <Link to="/" className="brand">
          Doctus
        </Link>
        <span className="demo-badge" title="Data lives in this browser; agents are scripted.">
          Prototype · demo
        </span>
        <h2 className="rail-heading">Spaces</h2>
        <ul className="rail-list">
          {(spaces.data ?? []).map((s) => (
            <li key={s.id}>
              <NavLink to={`/s/${s.id}`} end className="rail-item" title={s.title}>
                {s.title}
              </NavLink>
              {s.id === spaceId && space.data && space.data.worlds.length > 0 && (
                <ul className="rail-sublist">
                  {space.data.worlds.map((w) => (
                    <li key={w.id}>
                      <NavLink to={`/s/${s.id}/w/${w.id}`} className="rail-item rail-world" title={w.title}>
                        <span className="world-dot" data-colour={w.colour} aria-hidden />
                        {w.title}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <div className="rail-foot">
          {confirmReset ? (
            <div className="rail-confirm">
              <span className="small">Drop your changes and reload the demo data?</span>
              <div className="form-actions">
                <button
                  type="button"
                  className="button small-button"
                  onClick={async () => {
                    setConfirmReset(false)
                    await api.resetDemo()
                    await qc.resetQueries()
                    navigate('/')
                  }}
                >
                  Reset
                </button>
                <button type="button" className="button ghost small-button" onClick={() => setConfirmReset(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="link-button small" onClick={() => setConfirmReset(true)}>
              Reset demo
            </button>
          )}
          <button type="button" className="link-button small" onClick={() => setTheme(NEXT[theme])}>
            {LABEL[theme]}
          </button>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
