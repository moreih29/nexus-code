/**
 * Reusable React ErrorBoundary that catches render and lifecycle errors
 * within a component subtree.
 *
 * Design notes:
 *   • Accepts a `logSource` prop so each boundary tags its log lines with the
 *     subsystem name ("renderer", "git-panel", "search-panel", etc.).
 *   • Accepts a `fallback` prop for custom recovery UI; defaults to a minimal
 *     inline error card that shows the stack in development builds.
 *   • Scope: catches synchronous React render errors and `componentDidCatch`
 *     lifecycle errors ONLY. Window event-handler async errors and promise
 *     rejections are NOT caught here — those are handled by the unified
 *     window 'error' / 'unhandledrejection' listeners installed in
 *     window-error-handler.ts (see comment in componentDidCatch below).
 *
 * Usage:
 *   <ErrorBoundary logSource="git-panel" fallback={<p>Git panel crashed.</p>}>
 *     <GitPanel ... />
 *   </ErrorBoundary>
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createLogger } from "../../../shared/log/renderer";

// ---------------------------------------------------------------------------
// Props / State
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  /** Log source tag used for facade.error() calls from this boundary. */
  logSource: string;
  /** Custom fallback rendered when the boundary catches an error. */
  fallback?: ReactNode;
  /** Child subtree to protect. */
  children: ReactNode;
}

interface ErrorBoundaryState {
  caught: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { caught: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { caught: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log through the shared facade so the main-process log file receives the
    // record. We pass no extra meta here because the component stack is in
    // info.componentStack but LogMeta only accepts correlationId — structured
    // stack tracing is a separate concern for the log transport.
    //
    // NOTE: This handler is reached for React render/lifecycle errors only.
    // Async errors from window event handlers are NOT caught here; the unified
    // window 'error' / 'unhandledrejection' listener in window-error-handler.ts
    // handles those separately. Both layers together give complete coverage.
    const log = createLogger(this.props.logSource);
    log.error(`React render error caught by ErrorBoundary: ${error.message}`);

    // Also log the component stack in dev so developers can see the trace
    // without opening DevTools.
    if (import.meta.env?.DEV && info.componentStack) {
      log.error(`Component stack: ${info.componentStack}`);
    }
  }

  render(): ReactNode {
    if (!this.state.caught) {
      return this.props.children;
    }

    // Custom fallback takes precedence.
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    // Default fallback — dev-friendly with stack, minimal in production.
    const { error } = this.state;
    return (
      <div
        role="alert"
        style={{
          padding: "12px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          color: "var(--color-destructive, #ef4444)",
          fontSize: "12px",
          fontFamily: "monospace",
          overflow: "auto",
        }}
      >
        <strong>Unexpected error in {this.props.logSource}</strong>
        {error && <span>{error.message}</span>}
        {import.meta.env?.DEV && error?.stack && (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", opacity: 0.75 }}>{error.stack}</pre>
        )}
      </div>
    );
  }
}
