/**
 * Virtualized commit list for the History panel. Paging stays explicit via a
 * button so keyboard and screen-reader position remain stable across chunks.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LogEntry } from "../../../../../shared/git/types";
import { GraphCanvas } from "./graph/canvas";
import type { LaneState } from "./graph/lane-assign";
import { HISTORY_ROW_SELECTION_BAR_PX, HistoryRow, type HistoryRowMenuRequest } from "./row";

const GRAPH_CANVAS_STYLE: React.CSSProperties = { left: HISTORY_ROW_SELECTION_BAR_PX };

const HISTORY_ROW_HEIGHT_PX = 24;
const HISTORY_LIST_OVERSCAN = 10;
const HISTORY_GRAPH_LANE_WIDTH_PX = 16;
const DEFAULT_GRAPH_WIDTH_PX = HISTORY_GRAPH_LANE_WIDTH_PX;
/**
 * The most of the list's width the graph takes, so a narrow panel keeps room
 * for the other columns; lanes past it are cut off.
 */
const HISTORY_GRAPH_MAX_WIDTH_FRACTION = 0.4;
const HISTORY_LIST_BREAKPOINT_DEBOUNCE_MS = 100;

/** Widths of the room beside the graph; below each one the rows drop to that density. */
export const HISTORY_LIST_BREAKPOINT_COMPACT = 220;
export const HISTORY_LIST_BREAKPOINT_NARROW = 320;
export const HISTORY_LIST_BREAKPOINT_MEDIUM = 480;

export type HistoryListBreakpoint = "compact" | "narrow" | "medium" | "wide";

interface HistoryListProps {
  entries: readonly LogEntry[];
  selectedSha: string | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  searchQuery: string;
  errorMessage?: string | null;
  laneState?: LaneState;
  graphWidthPx?: number;
  renderGraphSlot?: (entry: LogEntry, index: number) => React.ReactNode;
  renderRefSlot?: (
    entry: LogEntry,
    index: number,
    breakpoint: HistoryListBreakpoint,
  ) => React.ReactNode;
  onSelect: (entry: LogEntry) => void;
  onOpen: (entry: LogEntry) => void;
  onLoadMore: () => void;
  onOpenMenu: (request: HistoryRowMenuRequest) => void;
  onClearSearch: () => void;
}

type HistoryListCssVars = React.CSSProperties & {
  "--graph-w": string;
};

/** Renders current search/log entries and the explicit Load 50 more control. */
export function HistoryList({
  entries,
  selectedSha,
  loading,
  loadingMore,
  hasMore,
  searchQuery,
  errorMessage,
  laneState,
  graphWidthPx = DEFAULT_GRAPH_WIDTH_PX,
  renderGraphSlot,
  renderRefSlot,
  onSelect,
  onOpen,
  onLoadMore,
  onOpenMenu,
  onClearSearch,
}: HistoryListProps) {
  const { t } = useTranslation("files");
  const trimmedQuery = searchQuery.trim();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const pendingFocusIndexRef = useRef<number | null>(null);
  const syncedSelectedShaRef = useRef<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const listWidthPx = useListWidth(scrollRef);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => HISTORY_ROW_HEIGHT_PX,
    overscan: HISTORY_LIST_OVERSCAN,
  });
  const fullGraphWidthPx = useMemo(
    () => (laneState ? graphWidthFromLaneState(laneState) : graphWidthPx),
    [graphWidthPx, laneState],
  );
  const resolvedGraphWidthPx = capGraphWidth(fullGraphWidthPx, listWidthPx);
  const breakpoint = useHistoryListBreakpoint(scrollRef, resolvedGraphWidthPx);
  const graphStyle = useMemo<HistoryListCssVars>(
    () => ({ "--graph-w": `${Math.max(0, resolvedGraphWidthPx)}px` }),
    [resolvedGraphWidthPx],
  );

  useEffect(() => {
    setFocusedIndex((current) => clampHistoryIndex(current, entries.length));
  }, [entries.length]);

  useEffect(() => {
    if (!selectedSha) {
      syncedSelectedShaRef.current = null;
      return;
    }
    if (syncedSelectedShaRef.current === selectedSha) return;
    const selectedIndex = entries.findIndex((entry) => entry.sha === selectedSha);
    if (selectedIndex < 0) return;
    syncedSelectedShaRef.current = selectedSha;
    setFocusedIndex(selectedIndex);
  }, [entries, selectedSha]);

  useEffect(() => {
    const pendingIndex = pendingFocusIndexRef.current;
    if (pendingIndex === null) return;
    const pendingRow = rowRefs.current.get(pendingIndex);
    if (!pendingRow) return;
    pendingRow.focus();
    pendingFocusIndexRef.current = null;
  });

  const focusHistoryRow = useCallback(
    (index: number) => {
      if (entries.length === 0) return;
      const nextIndex = clampHistoryIndex(index, entries.length);
      pendingFocusIndexRef.current = nextIndex;
      virtualizer.scrollToIndex(nextIndex);
      const row = rowRefs.current.get(nextIndex);
      if (row) {
        row.focus();
        pendingFocusIndexRef.current = null;
        return;
      }
      window.requestAnimationFrame(() => {
        if (pendingFocusIndexRef.current !== nextIndex) return;
        const nextRow = rowRefs.current.get(nextIndex);
        if (!nextRow) return;
        nextRow.focus();
        pendingFocusIndexRef.current = null;
      });
    },
    [entries.length, virtualizer],
  );

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (entries.length === 0 || isEditableKeyTarget(event.target)) return;
      const currentIndex = clampHistoryIndex(focusedIndex, entries.length);
      const pageJump = getPageJumpSize(scrollRef.current, HISTORY_ROW_HEIGHT_PX);
      let nextIndex: number | null = null;

      if (event.key === "ArrowDown") {
        nextIndex = Math.min(entries.length - 1, currentIndex + 1);
      } else if (event.key === "ArrowUp") {
        nextIndex = Math.max(0, currentIndex - 1);
      } else if (event.key === "PageDown") {
        nextIndex = Math.min(entries.length - 1, currentIndex + pageJump);
      } else if (event.key === "PageUp") {
        nextIndex = Math.max(0, currentIndex - pageJump);
      }

      if (nextIndex === null) return;
      event.preventDefault();
      event.stopPropagation();
      setFocusedIndex(nextIndex);
      const nextEntry = entries[nextIndex];
      if (nextEntry) onSelect(nextEntry);
      focusHistoryRow(nextIndex);
    },
    [entries, focusHistoryRow, focusedIndex, onSelect],
  );

  const registerRow = useCallback((index: number, element: HTMLDivElement | null) => {
    if (!element) {
      rowRefs.current.delete(index);
      return;
    }
    rowRefs.current.set(index, element);
    if (pendingFocusIndexRef.current !== index) return;
    element.focus();
    pendingFocusIndexRef.current = null;
  }, []);

  if (loading && entries.length === 0) {
    return <HistoryListMessage>{t("git.history.list.loading")}</HistoryListMessage>;
  }

  if (errorMessage) {
    return <HistoryListMessage>{errorMessage}</HistoryListMessage>;
  }

  if (entries.length === 0) {
    return trimmedQuery.length > 0 ? (
      <div className="p-4 text-app-ui-sm text-muted-foreground">
        {t("git.history.list.noCommitsMatch", { query: trimmedQuery })}{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={onClearSearch}
        >
          {t("git.history.list.clearSearch")}
        </button>
      </div>
    ) : (
      <HistoryListMessage>{t("git.history.list.noCommitsYet")}</HistoryListMessage>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="relative h-full min-h-0 overflow-y-auto overflow-x-hidden app-scrollbar"
      style={graphStyle}
    >
      {laneState ? (
        <GraphCanvas
          entries={entries}
          laneState={laneState}
          scrollElementRef={scrollRef}
          virtualizer={virtualizer}
          rowHeight={HISTORY_ROW_HEIGHT_PX}
          laneWidth={HISTORY_GRAPH_LANE_WIDTH_PX}
          width={resolvedGraphWidthPx}
          fadeRightEdge={resolvedGraphWidthPx < fullGraphWidthPx}
          className="z-0"
          // Past the selected row's bar, which would cover the HEAD ring's edge;
          // the row's padding leaves the room.
          style={GRAPH_CANVAS_STYLE}
        />
      ) : null}
      <div
        role="listbox"
        aria-label={t("git.history.list.ariaLabel")}
        tabIndex={0}
        className="relative z-10 focus:outline-none"
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          focusHistoryRow(focusedIndex);
        }}
        onKeyDown={handleListKeyDown}
        style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index];
          if (!entry) return null;
          const wrapperStyle: React.CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: HISTORY_ROW_HEIGHT_PX,
            transform: `translateY(${virtualRow.start}px)`,
          };
          return (
            <div key={entry.sha} style={wrapperStyle}>
              <HistoryRow
                rowRef={(element) => registerRow(virtualRow.index, element)}
                entry={entry}
                selected={entry.sha === selectedSha}
                tabIndex={focusedIndex === virtualRow.index ? 0 : -1}
                ariaSetSize={entries.length}
                ariaPosInSet={virtualRow.index + 1}
                breakpoint={breakpoint}
                graphSlot={renderGraphSlot?.(entry, virtualRow.index) ?? graphFallback(laneState)}
                refSlot={renderRefSlot?.(entry, virtualRow.index, breakpoint)}
                onFocus={() => setFocusedIndex(virtualRow.index)}
                onSelect={(selectedEntry) => {
                  setFocusedIndex(virtualRow.index);
                  onSelect(selectedEntry);
                }}
                onOpen={onOpen}
                onOpenMenu={onOpenMenu}
              />
            </div>
          );
        })}
      </div>
      {trimmedQuery.length === 0 && hasMore ? (
        <div className="p-2">
          <button
            type="button"
            disabled={loadingMore}
            className="w-full rounded border border-border px-3 py-2 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            onClick={onLoadMore}
          >
            {loadingMore ? t("git.history.list.loading2") : t("git.history.list.loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Observes the scroll container and returns the density breakpoint for history
 * rows, from the room they have beside a graph `graphWidthPx` wide.
 */
export function useHistoryListBreakpoint(
  scrollRef: React.RefObject<HTMLElement | null>,
  graphWidthPx = 0,
): HistoryListBreakpoint {
  const [listWidthPx, setListWidthPx] = useState<number | null>(null);
  const observerStateRef = useRef<HistoryListBreakpointObserver | null>(null);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (observerStateRef.current?.element === scrollElement) return;
    observerStateRef.current?.cleanup();
    observerStateRef.current = null;
    if (!scrollElement || typeof ResizeObserver === "undefined") return;

    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    /** Debounces non-zero width measurements so hidden panels keep their last density. */
    function scheduleBreakpointUpdate(widthPx: number): void {
      if (widthPx <= 0) return;
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        setListWidthPx(widthPx);
      }, HISTORY_LIST_BREAKPOINT_DEBOUNCE_MS);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      scheduleBreakpointUpdate(resizeEntryWidth(entry));
    });

    observer.observe(scrollElement);
    observerStateRef.current = {
      element: scrollElement,
      cleanup: () => {
        if (pendingTimer !== null) clearTimeout(pendingTimer);
        observer.disconnect();
      },
    };
    scheduleBreakpointUpdate(scrollElement.getBoundingClientRect().width);
  });

  useEffect(() => {
    return () => {
      observerStateRef.current?.cleanup();
      observerStateRef.current = null;
    };
  }, []);

  return listWidthPx === null ? "medium" : widthToHistoryListBreakpoint(listWidthPx - graphWidthPx);
}

/** Tracks the list's width, keeping the last one while the panel is hidden. */
function useListWidth(scrollRef: React.RefObject<HTMLElement | null>): number {
  const [widthPx, setWidthPx] = useState(0);
  const observedRef = useRef<{ element: HTMLElement; observer: ResizeObserver } | null>(null);

  // Runs after every render: the list mounts its scroll element only once it has rows.
  useEffect(() => {
    const element = scrollRef.current;
    if (observedRef.current?.element === element) return;
    observedRef.current?.observer.disconnect();
    observedRef.current = null;
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const nextWidthPx = entry ? Math.round(resizeEntryWidth(entry)) : 0;
      if (nextWidthPx > 0) setWidthPx(nextWidthPx);
    });
    observer.observe(element);
    observedRef.current = { element, observer };
  });

  useEffect(() => {
    return () => {
      observedRef.current?.observer.disconnect();
      observedRef.current = null;
    };
  }, []);

  return widthPx;
}

/** Limits the graph to its share of the list, never below one lane. */
export function capGraphWidth(graphWidthPx: number, listWidthPx: number): number {
  if (listWidthPx <= 0) return graphWidthPx;
  const maxWidthPx = Math.max(
    HISTORY_GRAPH_LANE_WIDTH_PX,
    Math.floor(listWidthPx * HISTORY_GRAPH_MAX_WIDTH_FRACTION),
  );
  return Math.min(graphWidthPx, maxWidthPx);
}

interface HistoryListBreakpointObserver {
  readonly element: HTMLElement | null;
  readonly cleanup: () => void;
}

/** Converts the room beside the graph into the row density bucket. */
function widthToHistoryListBreakpoint(widthPx: number): HistoryListBreakpoint {
  if (widthPx < HISTORY_LIST_BREAKPOINT_COMPACT) return "compact";
  if (widthPx < HISTORY_LIST_BREAKPOINT_NARROW) return "narrow";
  if (widthPx < HISTORY_LIST_BREAKPOINT_MEDIUM) return "medium";
  return "wide";
}

/** Reads ResizeObserver width while tolerating older contentRect-only implementations. */
function resizeEntryWidth(entry: ResizeObserverEntry): number {
  const borderBoxSize = Array.isArray(entry.borderBoxSize)
    ? entry.borderBoxSize[0]
    : entry.borderBoxSize;
  return borderBoxSize?.inlineSize ?? entry.contentRect.width;
}

/** Computes the graph column width from every lane currently known by the reducer. */
function graphWidthFromLaneState(laneState: LaneState): number {
  return Math.max(1, getRightmostLane(laneState) + 1) * HISTORY_GRAPH_LANE_WIDTH_PX;
}

/** Finds the largest lane index present in nodes, edges, or open streaming lanes. */
function getRightmostLane(laneState: LaneState): number {
  let rightmostLane = laneState.openLanes.length - 1;
  for (const lane of laneState.laneByCommit.values()) rightmostLane = Math.max(rightmostLane, lane);
  for (const edge of laneState.edges) {
    rightmostLane = Math.max(rightmostLane, edge.fromLane, edge.toLane);
  }
  for (const spill of laneState.spills) rightmostLane = Math.max(rightmostLane, spill.lane);
  return rightmostLane;
}

/** Suppresses the legacy row dot once Canvas owns graph visuals. */
function graphFallback(laneState: LaneState | undefined): React.ReactNode {
  return laneState ? false : undefined;
}

/** Renders a muted empty/loading list state. */
function HistoryListMessage({ children }: { children: React.ReactNode }) {
  return <div className="p-4 text-app-ui-sm text-muted-foreground">{children}</div>;
}

/** Keeps a row index valid as pages are replaced or appended. */
function clampHistoryIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index));
}

/** Converts the visible scroll height into the number of fixed-height rows per page jump. */
function getPageJumpSize(scrollElement: HTMLElement | null, rowHeightPx: number): number {
  if (!scrollElement) return 1;
  return Math.max(1, Math.floor(scrollElement.clientHeight / rowHeightPx));
}

/** Detects editable descendants so list navigation never steals typing keys. */
function isEditableKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}
