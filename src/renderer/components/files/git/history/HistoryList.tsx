/**
 * Commit list for the History panel. Paging is explicit via a button so
 * keyboard and screen-reader position stay stable across chunks.
 */
import type { LogEntry } from "../../../../../shared/types/git";
import type React from "react";
import { HistoryRow, type HistoryRowMenuRequest } from "./HistoryRow";

interface HistoryListProps {
  entries: readonly LogEntry[];
  selectedSha: string | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  searchQuery: string;
  errorMessage?: string | null;
  onSelect: (entry: LogEntry) => void;
  onLoadMore: () => void;
  onOpenMenu: (request: HistoryRowMenuRequest) => void;
  onClearSearch: () => void;
}

/** Renders current search/log entries and the explicit Load 50 more control. */
export function HistoryList({
  entries,
  selectedSha,
  loading,
  loadingMore,
  hasMore,
  searchQuery,
  errorMessage,
  onSelect,
  onLoadMore,
  onOpenMenu,
  onClearSearch,
}: HistoryListProps) {
  const trimmedQuery = searchQuery.trim();

  if (loading && entries.length === 0) {
    return <HistoryListMessage>Loading history…</HistoryListMessage>;
  }

  if (errorMessage) {
    return <HistoryListMessage>{errorMessage}</HistoryListMessage>;
  }

  if (entries.length === 0) {
    return trimmedQuery.length > 0 ? (
      <div className="p-4 text-app-ui-sm text-muted-foreground">
        No commits match &apos;{trimmedQuery}&apos;.{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={onClearSearch}
        >
          Clear search
        </button>
      </div>
    ) : (
      <HistoryListMessage>No commits yet.</HistoryListMessage>
    );
  }

  return (
    <div className="min-h-0" role="listbox" aria-label="Commit history">
      {entries.map((entry) => (
        <HistoryRow
          key={entry.sha}
          entry={entry}
          selected={entry.sha === selectedSha}
          onSelect={onSelect}
          onOpenMenu={onOpenMenu}
        />
      ))}
      {trimmedQuery.length === 0 && hasMore ? (
        <div className="p-2">
          <button
            type="button"
            disabled={loadingMore}
            className="w-full rounded border border-mist-border px-3 py-1.5 text-app-ui-sm text-muted-foreground hover:bg-frosted-veil hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            onClick={onLoadMore}
          >
            {loadingMore ? "Loading…" : "Load 50 more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Renders a muted empty/loading list state. */
function HistoryListMessage({ children }: { children: React.ReactNode }) {
  return <div className="p-4 text-app-ui-sm text-muted-foreground">{children}</div>;
}
