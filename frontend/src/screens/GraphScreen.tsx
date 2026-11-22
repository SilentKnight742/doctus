import { useSearchParams, useNavigate } from 'react-router'
import { useState } from 'react'
import { GraphCanvas } from '../graph/GraphCanvas'
import { ChatWindow } from '../shell/ChatWindow'
import { useSubject } from '../state/context'

export function GraphScreen() {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const { subjectId, openFrom, tidy } = useSubject()
  const openId = params.get('open') ? Number(params.get('open')) : null
  const [minimised, setMinimised] = useState(false)

  const select = (id: number) => {
    openFrom(id, openId)
    setMinimised(false)
    setParams({ open: String(id) }, { replace: true })
  }

  return (
    <div className="graph-screen">
      <GraphCanvas currentId={openId} onSelect={select} />
      <div className="graph-tools">
        <button type="button" className="button ghost" onClick={tidy}>
          Tidy layout
        </button>
      </div>
      {openId !== null && (
        <ChatWindow
          nodeId={openId}
          minimised={minimised}
          onMinimise={() => setMinimised((v) => !v)}
          onClose={() => setParams({}, { replace: true })}
          onExpand={() => nav(`/s/${subjectId}/chat/${openId}`)}
          onOpen={select}
        />
      )}
    </div>
  )
}
