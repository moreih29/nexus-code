import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceList } from './components/workspace-list'

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
      <main>
        <h1>Nexus Code</h1>
        <WorkspaceList />
      </main>
    </QueryClientProvider>
  )
}
