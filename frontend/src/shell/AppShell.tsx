import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
import { api } from '../api/client'
import { applyTheme, loadTheme, type ThemeChoice } from '../lib/theme'

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' }
const LABEL: Record<ThemeChoice, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }

export function AppShell() {
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: api.listSubjects })
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme)
  useEffect(() => applyTheme(theme), [theme])

  return (
    <div className="shell">
      <nav className="rail" aria-label="Subjects">
        <Link to="/" className="brand">
          Doctus
        </Link>
        <Link to="/" className="button rail-new">
          New subject
        </Link>
        <ul className="rail-list">
          {(subjects.data ?? []).map((s) => (
            <li key={s.id}>
              <NavLink to={`/s/${s.id}`} className="rail-item">
                {s.title}
              </NavLink>
            </li>
          ))}
        </ul>
        <button type="button" className="link-button rail-theme" onClick={() => setTheme(NEXT[theme])}>
          {LABEL[theme]}
        </button>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
