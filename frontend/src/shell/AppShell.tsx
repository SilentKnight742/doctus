import { Link, Outlet } from 'react-router'

/** The whole window is the current screen; no side rail. */
export function AppShell() {
  return (
    <main className="main">
      <Outlet />
    </main>
  )
}

export function DemoBadge() {
  return (
    <span className="demo-badge" title="Data lives in this browser; agents are scripted demos, not a model.">
      Prototype · demo
    </span>
  )
}

/** The left end of a screen's top bar: back to the spaces list, and (inside a node) to its space. */
export function Crumbs({ space }: { space?: { id: number; title: string } }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumbs">
      <Link to="/" className="back-link">
        ← Spaces
      </Link>
      {space && (
        <>
          <span className="crumb-sep" aria-hidden>
            /
          </span>
          <Link to={`/s/${space.id}`} className="back-link">
            {space.title}
          </Link>
        </>
      )}
    </nav>
  )
}
