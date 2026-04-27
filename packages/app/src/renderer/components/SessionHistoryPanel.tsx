import { useCallback, useEffect, useState } from "react";
import { History, RefreshCw } from "lucide-react";

import type {
  ClaudeTranscriptReadRequest,
  ClaudeTranscriptReadResult,
} from "../../../../shared/src/contracts/claude/claude-session-transcript";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { ScrollArea } from "./ui/scroll-area";
import type { HarnessSessionRef } from "../stores/harnessSessionStore";

export interface SessionHistoryPanelProps {
  sessionRef: HarnessSessionRef | null;
  activeWorkspaceName?: string | null;
  readTranscript: (
    request: ClaudeTranscriptReadRequest,
  ) => Promise<ClaudeTranscriptReadResult>;
}

export interface SessionHistoryPanelViewProps {
  sessionRef: HarnessSessionRef | null;
  result: ClaudeTranscriptReadResult | null;
  loading: boolean;
  errorMessage?: string | null;
  activeWorkspaceName?: string | null;
  onRefresh?: () => void;
}

export function SessionHistoryPanel({
  sessionRef,
  activeWorkspaceName,
  readTranscript,
}: SessionHistoryPanelProps): JSX.Element {
  const [result, setResult] = useState<ClaudeTranscriptReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!sessionRef) {
      setResult(null);
      setErrorMessage(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    void readTranscript({ transcriptPath: sessionRef.transcriptPath, limit: 80 })
      .then((nextResult) => {
        setResult(nextResult);
      })
      .catch((error) => {
        setResult(null);
        setErrorMessage(error instanceof Error ? error.message : "Unable to read session history.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [readTranscript, sessionRef]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <SessionHistoryPanelView
      sessionRef={sessionRef}
      result={result}
      loading={loading}
      errorMessage={errorMessage}
      activeWorkspaceName={activeWorkspaceName}
      onRefresh={refresh}
    />
  );
}

export function SessionHistoryPanelView({
  sessionRef,
  result,
  loading,
  errorMessage,
  activeWorkspaceName,
  onRefresh,
}: SessionHistoryPanelViewProps): JSX.Element {
  if (!sessionRef) {
    return (
      <div data-component="session-history-panel" className="h-full">
        <EmptyState
          icon={History}
          title="No session yet"
          description={
            activeWorkspaceName
              ? `Run a supported harness in ${activeWorkspaceName}; transcript history will appear here.`
              : "Open a workspace and run a supported harness; transcript history will appear here."
          }
        />
      </div>
    );
  }

  const header = SessionHeader({
    sessionRef,
    result,
    loading,
    onRefresh,
  });

  if (errorMessage) {
    return (
      <section data-component="session-history-panel" className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState
          icon={History}
          title="Session read failed"
          description={errorMessage}
        />
      </section>
    );
  }

  if (!result && loading) {
    return (
      <section data-component="session-history-panel" className="flex h-full min-h-0 flex-col">
        {header}
        <PanelMessage>Loading session transcript…</PanelMessage>
      </section>
    );
  }

  if (result && !result.available) {
    return (
      <section data-component="session-history-panel" className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState
          icon={History}
          title="Session unavailable"
          description={result.reason}
        />
      </section>
    );
  }

  const entries = result?.available ? result.entries : [];
  if (entries.length === 0) {
    return (
      <section data-component="session-history-panel" className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState
          icon={History}
          title="No transcript entries"
          description="Session reference exists, but no transcript entries were readable yet."
        />
      </section>
    );
  }

  return (
    <section data-component="session-history-panel" className="flex h-full min-h-0 flex-col">
      {header}
      <ScrollArea className="min-h-0 flex-1">
        <ol className="space-y-2 p-3" aria-label="Read-only session history">
          {entries.map((entry) => (
            <li
              key={entry.lineNumber}
              data-session-entry-role={entry.role}
              className="rounded-md border border-border bg-background/70 px-3 py-2"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{entry.role}</span>
                  <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    {entry.kind}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  #{entry.lineNumber}
                </span>
              </div>
              {entry.timestamp && (
                <time className="mt-1 block text-[11px] text-muted-foreground" dateTime={entry.timestamp}>
                  {formatTimestamp(entry.timestamp)}
                </time>
              )}
              <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-normal text-muted-foreground">
                {entry.summary}
              </p>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </section>
  );
}

function SessionHeader({
  sessionRef,
  result,
  loading,
  onRefresh,
}: {
  sessionRef: HarnessSessionRef;
  result: ClaudeTranscriptReadResult | null;
  loading: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  const count = result?.available ? result.entries.length : 0;
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
      <div className="min-w-0">
        <h3 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-foreground">
          Session history
        </h3>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {sessionTail(sessionRef.sessionId)} · {pathTail(sessionRef.transcriptPath)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {loading ? "Loading" : `${count} lines`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh session history"
        >
          <RefreshCw aria-hidden="true" className={cn("size-3", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </header>
  );
}

function PanelMessage({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function formatTimestamp(timestamp: string): string {
  const timePart = timestamp.split("T")[1]?.slice(0, 8);
  return timePart && /^\d\d:\d\d:\d\d$/.test(timePart) ? timePart : timestamp;
}

function sessionTail(sessionId: string): string {
  return sessionId.length > 8 ? `…${sessionId.slice(-8)}` : sessionId;
}

function pathTail(filePath: string): string {
  return filePath.split(/[\\/]/).slice(-2).join("/") || filePath;
}
