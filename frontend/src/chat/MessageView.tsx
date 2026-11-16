import { useState } from 'react'
import type { ContextUsed as Ctx, Message } from '../api/types'
import { ContextUsed } from './ContextUsed'
import { Markdown } from './Markdown'

export function MessageView({ message, context }: { message: Message; context?: Ctx }) {
  const [showCtx, setShowCtx] = useState(false)
  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="bubble">{message.content}</div>
      </div>
    )
  }
  return (
    <div className="msg msg-assistant">
      <Markdown text={message.content} />
      {context && (
        <div className="msg-tools">
          <button type="button" className="link-button" onClick={() => setShowCtx((v) => !v)}>
            {showCtx ? 'Hide context used' : 'Context used'}
          </button>
          {showCtx && <ContextUsed ctx={context} />}
        </div>
      )}
    </div>
  )
}
