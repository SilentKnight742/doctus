import { Navigate, Route, Routes } from 'react-router'
import { Home } from './screens/Home'
import { SpaceScreen } from './space/SpaceScreen'
import { AppShell } from './shell/AppShell'
import { WorldScreen } from './world/WorldScreen'

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="s/:spaceId" element={<SpaceScreen />} />
        <Route path="s/:spaceId/w/:worldId" element={<WorldScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
