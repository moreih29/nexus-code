import { useMemo, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search, RefreshCw, X } from "lucide-react";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { shouldIgnoreKeyboardShortcut } from "../stores/keyboard-registry";
import {
  EMPTY_SEARCH_WORKSPACE_STATE,
  getSearchFileGroups,
  type SearchFileResultGroup,
  type SearchMatch,
  type SearchStore,
  type SearchWorkspaceState,
} from "../stores/search-store";

export interface SearchPanelWorkspace {
  id: WorkspaceId;
  absolutePath: string;
  displayName: string;
}

export interface SearchResultOpenRequest {
  workspaceId: WorkspaceId;
  match: SearchMatch;
}

export interface SearchPanelProps {
  activeWorkspace: SearchPanelWorkspace | null;
  searchStore: SearchStore;
  onOpenResult?(request: SearchResultOpenRequest): Promise<void> | void;
}

export interface SearchPanelViewProps {
  activeWorkspaceName?: string | null;
  workspaceState: SearchWorkspaceState;
  fileGroups: SearchFileResultGroup[];
  canSearch: boolean;
  onCancelSearch?(): void;
  onDismiss?(): void;
  onHistoryCycle?(direction: "previous" | "next"): void;
  onHistorySelect?(query: string): void;
  onOpenResult?(match: SearchMatch): void;
  onQueryChange?(query: string): void;
  onReplaceModeChange?(enabled: boolean): void;
  onReplaceTextChange?(value: string): void;
  onSearch?(): void;
  onSetAdvancedOpen?(open: boolean): void;
  onSetExcludeText?(value: string): void;
  onSetIncludeText?(value: string): void;
  onToggleOption?(option: "caseSensitive" | "regex" | "wholeWord"): void;
}

export function SearchPanel({
  activeWorkspace,
  searchStore,
  onOpenResult,
}: SearchPanelProps): JSX.Element {
  const workspaceState = useStore(searchStore, (state) =>
    activeWorkspace ? state.workspaceById[activeWorkspace.id] : null,
  ) ?? EMPTY_SEARCH_WORKSPACE_STATE;
  const fileGroups = useMemo(() => getSearchFileGroups(workspaceState), [workspaceState]);

  if (!activeWorkspace) {
    return (
      <SearchPanelView
        workspaceState={EMPTY_SEARCH_WORKSPACE_STATE}
        fileGroups={[]}
        canSearch={false}
      />
    );
  }

  const workspaceId = activeWorkspace.id;

  return (
    <SearchPanelView
      activeWorkspaceName={activeWorkspace.displayName}
      workspaceState={workspaceState}
      fileGroups={fileGroups}
      canSearch={true}
      onCancelSearch={() => {
        void searchStore.getState().cancelSearch(workspaceId).catch((error) => {
          console.error("Search: failed to cancel search.", error);
        });
      }}
      onDismiss={() => searchStore.getState().dismiss(workspaceId)}
      onHistoryCycle={(direction) => {
        searchStore.getState().cycleHistory(workspaceId, direction);
      }}
      onHistorySelect={(query) => searchStore.getState().setQuery(workspaceId, query)}
      onOpenResult={(match) => {
        searchStore.getState().selectMatch(workspaceId, match);
        void Promise.resolve(onOpenResult?.({ workspaceId, match })).catch((error) => {
          console.error("Search: failed to open result.", error);
        });
      }}
      onQueryChange={(query) => searchStore.getState().setQuery(workspaceId, query)}
      onReplaceModeChange={(enabled) => searchStore.getState().setReplaceMode(workspaceId, enabled)}
      onReplaceTextChange={(value) => searchStore.getState().setReplaceText(workspaceId, value)}
      onSearch={() => {
        void searchStore.getState().startSearch({
          workspaceId,
          cwd: activeWorkspace.absolutePath,
        });
      }}
      onSetAdvancedOpen={(open) => searchStore.getState().setAdvancedOpen(workspaceId, open)}
      onSetExcludeText={(value) => searchStore.getState().setExcludeText(workspaceId, value)}
      onSetIncludeText={(value) => searchStore.getState().setIncludeText(workspaceId, value)}
      onToggleOption={(option) => searchStore.getState().toggleOption(workspaceId, option)}
    />
  );
}

export function SearchPanelView({
  activeWorkspaceName,
  workspaceState,
  fileGroups,
  canSearch,
  onCancelSearch,
  onDismiss,
  onHistoryCycle,
  onHistorySelect,
  onOpenResult,
  onQueryChange,
  onReplaceModeChange,
  onReplaceTextChange,
  onSearch,
  onSetAdvancedOpen,
  onSetExcludeText,
  onSetIncludeText,
  onToggleOption,
}: SearchPanelViewProps): JSX.Element {
  if (!canSearch) {
    return (
      <div data-component="search-panel" className="h-full">
        <EmptyState
          icon={Search}
          title="No workspace selected"
          description="Open a workspace to search across project files."
        />
      </div>
    );
  }

  const resultSummary = resultSummaryLabel(workspaceState);
  const searching = workspaceState.status === "running";

  return (
    <section data-component="search-panel" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-foreground">
            Search
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {activeWorkspaceName ?? "Active workspace"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {resultSummary}
          </span>
          {searching ? (
            <Button
              type="button"
              data-action="search-cancel"
              variant="outline"
              size="xs"
              onClick={onCancelSearch}
            >
              <X aria-hidden="true" className="size-3" />
              Cancel
            </Button>
          ) : null}
        </div>
      </header>

      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <Input
            data-search-input="query"
            aria-label="Search query"
            placeholder="Search"
            value={workspaceState.query}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onQueryChange?.(event.target.value)}
            onKeyDown={(event) => handleSearchInputKeyDown(event, onSearch, onHistoryCycle, onDismiss)}
          />
          <Button
            type="button"
            data-action="search-submit"
            variant="outline"
            size="sm"
            disabled={!workspaceState.query.trim() || searching}
            onClick={onSearch}
          >
            <RefreshCw aria-hidden="true" className={cn("size-3", searching && "animate-spin")} />
            Search
          </Button>
        </div>

        {workspaceState.replaceMode ? (
          <div className="flex items-center gap-2" data-search-replace-mode="true">
            <Input
              aria-label="Replace text"
              placeholder="Replace"
              value={workspaceState.replaceText}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onReplaceTextChange?.(event.target.value)}
            />
            <Button
              type="button"
              data-action="search-replace-all"
              variant="outline"
              size="sm"
              disabled
              title="Replace All is waiting on editor bulk-edit integration."
            >
              Replace All
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {SearchToggle({
            label: "Aa",
            title: "Match case",
            pressed: workspaceState.options.caseSensitive,
            onClick: () => onToggleOption?.("caseSensitive"),
          })}
          {SearchToggle({
            label: ".*",
            title: "Use regular expression",
            pressed: workspaceState.options.regex,
            onClick: () => onToggleOption?.("regex"),
          })}
          {SearchToggle({
            label: "Word",
            title: "Match whole word",
            pressed: workspaceState.options.wholeWord,
            onClick: () => onToggleOption?.("wholeWord"),
          })}
          <Button
            type="button"
            data-action="toggle-replace-mode"
            variant={workspaceState.replaceMode ? "default" : "outline"}
            size="xs"
            aria-pressed={workspaceState.replaceMode}
            onClick={() => onReplaceModeChange?.(!workspaceState.replaceMode)}
          >
            Replace
          </Button>
          <Button
            type="button"
            data-action="search-advanced"
            variant="ghost"
            size="xs"
            aria-expanded={workspaceState.advancedOpen}
            onClick={() => onSetAdvancedOpen?.(!workspaceState.advancedOpen)}
          >
            Advanced
          </Button>
          {workspaceState.history.length > 0 ? (
            <select
              aria-label="Search history"
              value=""
              onChange={(event) => {
                if (event.target.value) {
                  onHistorySelect?.(event.target.value);
                }
              }}
              className="h-6 min-w-24 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="" disabled>History</option>
              {workspaceState.history.map((entry) => (
                <option key={entry} value={entry}>{entry}</option>
              ))}
            </select>
          ) : null}
        </div>

        {workspaceState.advancedOpen ? (
          <div className="grid gap-2 rounded-md border border-border bg-background/60 p-2" data-search-advanced-open="true">
            <Input
              aria-label="Include files"
              placeholder="Include glob, e.g. src/**, *.ts"
              value={workspaceState.options.includeText}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onSetIncludeText?.(event.target.value)}
            />
            <Input
              aria-label="Exclude files"
              placeholder="Exclude glob, e.g. node_modules/**"
              value={workspaceState.options.excludeText}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onSetExcludeText?.(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      {workspaceState.errorMessage ? (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {workspaceState.errorMessage}
        </div>
      ) : null}

      {workspaceState.truncated ? (
        <div className="shrink-0 border-b border-status-attention/40 bg-status-attention/10 px-3 py-2 text-xs text-muted-foreground">
          Showing first 10,000 results. Refine the query to narrow matches.
        </div>
      ) : null}

      {SearchResults({
        workspaceState,
        fileGroups,
        onOpenResult,
      })}
    </section>
  );
}

function SearchToggle({
  label,
  title,
  pressed,
  onClick,
}: {
  label: string;
  title: string;
  pressed: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant={pressed ? "default" : "outline"}
      size="xs"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function SearchResults({
  workspaceState,
  fileGroups,
  onOpenResult,
}: {
  workspaceState: SearchWorkspaceState;
  fileGroups: SearchFileResultGroup[];
  onOpenResult?(match: SearchMatch): void;
}): JSX.Element {
  if (workspaceState.status === "running" && workspaceState.matchCount === 0) {
    return <PanelMessage>Searching project files…</PanelMessage>;
  }

  if (fileGroups.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title={workspaceState.status === "completed" ? "No results" : "Ready to search"}
        description="Type a query and press Enter or ⌘⇧F to search this workspace."
      />
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ol className="space-y-2 p-2" aria-label="Search results">
        {fileGroups.map((group) => (
          <li key={group.path} className="rounded-md border border-border bg-background/70">
            <details open>
              <summary className="flex cursor-default list-none items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs font-medium text-foreground">
                <span className="min-w-0 truncate font-mono">{group.path}</span>
                <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {group.matches.length}
                </span>
              </summary>
              <ol className="space-y-1 p-1">
                {group.matches.map((match) => {
                  const active = workspaceState.activeMatch?.matchId === match.id;
                  return (
                    <li key={match.id}>
                      <button
                        type="button"
                        data-search-result-active={active ? "true" : "false"}
                        className={cn(
                          "flex w-full min-w-0 gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                          active && "bg-accent text-accent-foreground",
                        )}
                        onClick={() => onOpenResult?.(match)}
                      >
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {match.lineNumber}:{match.column}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                          {HighlightedLine({
                            lineText: match.lineText,
                            submatches: match.submatches,
                          })}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </details>
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}

function HighlightedLine({
  lineText,
  submatches,
}: Pick<SearchMatch, "lineText" | "submatches">): JSX.Element {
  if (submatches.length === 0) {
    return <>{lineText}</>;
  }

  const segments: JSX.Element[] = [];
  let cursor = 0;
  submatches.forEach((submatch, index) => {
    const start = byteOffsetToStringIndex(lineText, submatch.start);
    const end = byteOffsetToStringIndex(lineText, submatch.end);
    if (start > cursor) {
      segments.push(<span key={`text-${index}`}>{lineText.slice(cursor, start)}</span>);
    }
    segments.push(
      <mark key={`match-${index}`} className="rounded-sm bg-primary/30 px-0.5 text-foreground">
        {lineText.slice(start, end)}
      </mark>,
    );
    cursor = Math.max(cursor, end);
  });

  if (cursor < lineText.length) {
    segments.push(<span key="tail">{lineText.slice(cursor)}</span>);
  }

  return <>{segments}</>;
}

function handleSearchInputKeyDown(
  event: ReactKeyboardEvent<HTMLInputElement>,
  onSearch?: () => void,
  onHistoryCycle?: (direction: "previous" | "next") => void,
  onDismiss?: () => void,
): void {
  if (shouldIgnoreKeyboardShortcut(event.nativeEvent)) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    onSearch?.();
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    onHistoryCycle?.("previous");
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    onHistoryCycle?.("next");
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    onDismiss?.();
  }
}

function resultSummaryLabel(workspaceState: SearchWorkspaceState): string {
  if (workspaceState.status === "running") {
    return workspaceState.matchCount > 0 ? `${workspaceState.matchCount} found` : "Searching";
  }

  if (workspaceState.status === "failed") {
    return "Failed";
  }

  if (workspaceState.status === "canceled") {
    return `${workspaceState.matchCount} canceled`;
  }

  return `${workspaceState.matchCount} results`;
}

function PanelMessage({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function byteOffsetToStringIndex(value: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }

  const encoder = new TextEncoder();
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      return value.length;
    }

    const character = String.fromCodePoint(codePoint);
    const nextBytes = bytes + encoder.encode(character).length;
    if (nextBytes > byteOffset) {
      return index;
    }

    bytes = nextBytes;
    if (codePoint > 0xffff) {
      index += 1;
    }
  }

  return value.length;
}
