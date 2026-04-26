import { Wrench } from "lucide-react";

import type { ToolCallStatus } from "../../../../shared/src/contracts/harness-observer";
import { cn } from "@/lib/utils";
import { EmptyState } from "./EmptyState";
import { ScrollArea } from "./ui/scroll-area";
import type { HarnessToolFeedEntry } from "../stores/harnessToolFeedStore";

interface ToolFeedPanelProps {
  entries: readonly HarnessToolFeedEntry[];
  activeWorkspaceName?: string | null;
}

const STATUS_COPY: Record<ToolCallStatus, { label: string; dotClassName: string }> = {
  started: {
    label: "Running",
    dotClassName: "bg-status-running",
  },
  completed: {
    label: "Completed",
    dotClassName: "bg-muted-foreground",
  },
  "awaiting-approval": {
    label: "Approval",
    dotClassName: "bg-status-attention",
  },
  error: {
    label: "Error",
    dotClassName: "bg-destructive",
  },
};

export function ToolFeedPanel({ entries, activeWorkspaceName }: ToolFeedPanelProps): JSX.Element {
  if (entries.length === 0) {
    return (
      <div data-component="tool-feed-panel" className="h-full">
        <EmptyState
          icon={Wrench}
          title="No tool calls yet"
          description={
            activeWorkspaceName
              ? `Run Claude Code tool calls in ${activeWorkspaceName}; live events will appear here.`
              : "Open a workspace and run Claude Code tool calls; live events will appear here."
          }
        />
      </div>
    );
  }

  return (
    <section data-component="tool-feed-panel" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-foreground">
            Live tool feed
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {activeWorkspaceName ?? "Active workspace"}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {entries.length} events
        </span>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <ol className="space-y-2 p-3" aria-label="Live Claude Code tool calls">
          {[...entries].reverse().map((entry) => renderToolFeedRow(entry))}
        </ol>
      </ScrollArea>
    </section>
  );
}

function renderToolFeedRow(entry: HarnessToolFeedEntry): JSX.Element {
  const status = STATUS_COPY[entry.status];
  const summaryLines = [
    entry.message,
    entry.inputSummary ? `Input: ${entry.inputSummary}` : null,
    entry.resultSummary ? `Result: ${entry.resultSummary}` : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <li
      key={`${entry.sessionId}:${entry.receivedSequence}`}
      data-tool-call-status={entry.status}
      className="rounded-md border border-border bg-background/70 px-3 py-2"
      aria-label={`${entry.toolName}: ${status.label}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          aria-hidden="true"
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", status.dotClassName)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{entry.toolName}</span>
            <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {status.label}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <time dateTime={entry.timestamp}>{formatToolTimestamp(entry.timestamp)}</time>
            <span aria-hidden="true">·</span>
            <span className="truncate font-mono">session {sessionTail(entry.sessionId)}</span>
          </div>
          {summaryLines.length > 0 && (
            <div className="mt-2 space-y-1">
              {summaryLines.map((line) => (
                <p key={line} className="break-words text-xs leading-normal text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function formatToolTimestamp(timestamp: string): string {
  const timePart = timestamp.split("T")[1]?.slice(0, 8);
  return timePart && /^\d\d:\d\d:\d\d$/.test(timePart) ? timePart : timestamp;
}

function sessionTail(sessionId: string): string {
  return sessionId.length > 8 ? `…${sessionId.slice(-8)}` : sessionId;
}
