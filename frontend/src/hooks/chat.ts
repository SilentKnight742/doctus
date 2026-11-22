import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { NodeDetail } from '../api/types'
import { useSubject } from '../state/context'

export function useNode(nodeId: number | null) {
  return useQuery({
    queryKey: ['node', nodeId],
    queryFn: () => api.node(nodeId!),
    enabled: nodeId !== null,
  })
}

/** Send a chat message; on success refresh the node and start graph polling. */
export function useSendMessage(nodeId: number) {
  const qc = useQueryClient()
  const { noteStatus, arrivedFrom, setContext } = useSubject()
  return useMutation({
    mutationFn: (message: string) => api.chat(nodeId, message, arrivedFrom(nodeId)),
    onSuccess: async (reply) => {
      noteStatus({
        graph_version: reply.graph_version,
        cartographer: reply.cartographer,
        error: reply.error,
      })
      await qc.refetchQueries({ queryKey: ['node', nodeId] })
      const detail = qc.getQueryData<NodeDetail>(['node', nodeId])
      const last = detail?.messages.filter((m) => m.role === 'assistant').at(-1)
      if (last) setContext(last.id, reply.context_used)
    },
  })
}
