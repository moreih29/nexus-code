import { Component, type ReactNode } from 'react'
import log from 'electron-log/renderer'
import { AppLayout } from './components/layout/AppLayout'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    log.error('[ErrorBoundary] React rendering crash:', error.message)
    log.error('[ErrorBoundary] Stack:', error.stack)
    log.error('[ErrorBoundary] Component:', info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
          <div className="max-w-lg rounded-xl border border-red-800 bg-red-950/50 p-6">
            <h2 className="text-lg font-bold text-red-400">Rendering Error</h2>
            <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-red-300">
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 rounded bg-red-800 px-4 py-2 text-sm text-white hover:bg-red-700"
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

function App() {
  return (
    <ErrorBoundary>
      <AppLayout />
    </ErrorBoundary>
  )
}

export default App
