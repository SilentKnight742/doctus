import { Navigate, Route, Routes, useParams } from 'react-router'
import { ChatScreen } from './screens/ChatScreen'
import { GraphScreen } from './screens/GraphScreen'
import { Home } from './screens/Home'
import { AppShell } from './shell/AppShell'
import { SubjectLayout } from './shell/SubjectLayout'
import { useSubject } from './state/context'

function SubjectIndex() {
  const { graph } = useSubject()
  const { subjectId } = useParams()
  if (!graph) return null
  return <Navigate to={`/s/${subjectId}/chat/${graph.subject.origin_node_id}`} replace />
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="s/:subjectId" element={<SubjectLayout />}>
          <Route index element={<SubjectIndex />} />
          <Route path="chat/:nodeId" element={<ChatScreen />} />
          <Route path="graph" element={<GraphScreen />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
