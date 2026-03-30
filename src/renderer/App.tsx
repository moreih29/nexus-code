import { Component, type ReactNode, useMemo, useLayoutEffect } from 'react'
import log from 'electron-log/renderer'

const rlog = log.scope('renderer:app')
import { AppLayout } from './components/layout/AppLayout'
import { SessionStoreContext, getOrCreateWorkspaceStore, setActiveStore } from './stores/session-store'
import { useWorkspaceStore } from './stores/workspace-store'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    rlog.error('React rendering crash:', error.message)
    rlog.error('Stack:', error.stack)
    rlog.error('Component:', info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
          <div className="max-w-lg rounded-xl border border-error/50 bg-error/10 p-6">
            <h2 className="text-lg font-bold text-error">Rendering Error</h2>
            <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-error">
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 rounded bg-error/80 px-4 py-2 text-sm text-white hover:bg-error"
            >
              재시도
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function SessionStoreProvider({ children }: { children: ReactNode }) {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  const store = useMemo(() => {
    if (!activeWorkspace) return null
    return getOrCreateWorkspaceStore(activeWorkspace)
  }, [activeWorkspace])

  // 비React 코드용 activeStore 동기화
  useLayoutEffect(() => {
    setActiveStore(store)
  }, [store])

  return (
    <SessionStoreContext.Provider value={store}>
      {children}
    </SessionStoreContext.Provider>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <SessionStoreProvider>
        <AppLayout />
      </SessionStoreProvider>
    </ErrorBoundary>
  )
}

export default App
