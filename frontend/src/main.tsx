import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@xyflow/react/dist/style.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { ApiError, api } from './api/client'
import { App } from './App'
import './theme.css'
import './app.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Do not hammer a rate-limited or missing resource.
      retry: (n, err) => !(err instanceof ApiError) && n < 2,
    },
  },
})

// Any change (a screen's edit or an agent's tool call) refreshes what is on screen.
api.subscribe(() => void queryClient.invalidateQueries())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
