import i18next from "i18next";
import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { createLogger } from "../../../shared/log/renderer";
import { errorNameOf } from "../../../shared/remote/bug-report";
import { reportError } from "../../services/recent-errors/report";

interface ErrorBoundaryProps {
  logSource: string;
  fallback?: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  caught: boolean;
  error: Error | null;
}

function boundaryName(logSource: string): string {
  return logSource.split(":")[0] ?? logSource;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { caught: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { caught: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const log = createLogger(this.props.logSource);
    log.error(`React render error caught by ErrorBoundary: ${error.message}`);
    reportError("render", [boundaryName(this.props.logSource), errorNameOf(error)]);

    if (import.meta.env?.DEV && info.componentStack) {
      log.error(`Component stack: ${info.componentStack}`);
    }
  }

  render(): ReactNode {
    if (!this.state.caught) {
      return this.props.children;
    }

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    const { error } = this.state;
    const dev = import.meta.env?.DEV === true;
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
        <strong>{i18next.t("errors:generic.bug")}</strong>
        {dev && (
          <span>
            {this.props.logSource}: {error?.message}
          </span>
        )}
        {dev && error?.stack && (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", opacity: 0.75 }}>{error.stack}</pre>
        )}
      </div>
    );
  }
}
