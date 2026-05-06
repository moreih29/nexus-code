import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { DocumentSymbol, Position } from "../../../../shared/lsp-types";
import { OutlineTree } from "./outline-tree";

export type OutlineViewPhase = "idle" | "loading" | "empty" | "error" | "ready";

export interface OutlineViewState {
  phase: OutlineViewPhase;
  symbols: DocumentSymbol[];
  errorMessage?: string;
  cursorPosition?: Position | null;
}

function OutlineStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
      {children}
    </div>
  );
}

interface OutlineContentProps {
  state: OutlineViewState;
  onRetry?: () => void;
}

export function OutlineContent({ state, onRetry }: OutlineContentProps) {
  if (state.phase === "idle") {
    return <OutlineStatus>Open an editor tab to view symbols.</OutlineStatus>;
  }

  if (state.phase === "loading") {
    return <OutlineStatus>Loading outline…</OutlineStatus>;
  }

  if (state.phase === "empty") {
    return <OutlineStatus>No symbols found.</OutlineStatus>;
  }

  if (state.phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
        <div>{state.errorMessage ?? "Unable to load outline."}</div>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-[4px] border border-mist-border px-2 py-1 text-app-ui-sm text-muted-foreground hover:bg-frosted-veil-strong hover:text-foreground"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.5} aria-hidden />
          Retry
        </button>
      </div>
    );
  }

  return <OutlineTree symbols={state.symbols} cursorPosition={state.cursorPosition ?? null} />;
}
