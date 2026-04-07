import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppLayout } from './components/layout/app-layout'
import { WorkspaceNav } from './components/workspace/workspace-nav'
import { ChatArea } from './components/chat/chat-area'
import { RightPanel } from './components/panel/right-panel'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppLayout left={<WorkspaceNav />} center={<ChatArea />} right={<RightPanel />} />
    </QueryClientProvider>
  )
}
