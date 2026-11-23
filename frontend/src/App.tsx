import { Navigate, Route, Routes } from 'react-router'
import { Home } from './screens/Home'
import { SubjectScreen } from './screens/SubjectScreen'
import { AppShell } from './shell/AppShell'

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="s/:subjectId" element={<SubjectScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
