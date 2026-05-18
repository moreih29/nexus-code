/**
 * Single-line commit row for the History list.
 */

import { MoreHorizontal } from "lucide-react";
import type React from "react";
import type { LogEntry } from "../../../../../shared/git/types";
import { relativeTime } from "../utils/relative-time";
import type { HistoryListBreakpoint } from "./list";

const HISTORY_ROW_GRID_CLASS_BY_BREAKPOINT: Record<HistoryListBreakpoint, string> = {
  narrow: "grid h-6 grid-cols-[var(--graph-w)_minmax(0,1fr)_5ch_24px] items-center gap-2",
  medium:
    "grid h-6 grid-cols-[var(--graph-w)_minmax(0,auto)_minmax(0,1fr)_5ch_7ch_24px] items-center gap-2",
  wide: "grid h-6 grid-cols-[var(--graph-w)_minmax(0,auto)_minmax(0,1fr)_12ch_5ch_7ch_24px] items-center gap-2",
};
const HISTORY_ROW_INTERACTION_CLASS =
  "group border-l-2 pl-1 pr-1 text-app-ui-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

export interface HistoryRowMenuRequest {
  entry: LogEntry;
  point: { x: number; y: number };
}

interface HistoryRowProps {
  entry: LogEntry;
  selected: boolean;
  tabIndex: 0 | -1;
  ariaSetSize: number;
  ariaPosInSet: number;
  breakpoint: HistoryListBreakpoint;
  rowRef?: (element: HTMLDivElement | null) => void;
  graphSlot?: React.ReactNode;
  refSlot?: React.ReactNode;
  onFocus: () => void;
  onSelect: (entry: LogEntry) => void;
  onOpen: (entry: LogEntry) => void;
  onOpenMenu: (request: HistoryRowMenuRequest) => void;
}

/** Renders one focusable commit row with hover, selected, and focus states. */
export function HistoryRow({
  entry,
  selected,
  tabIndex,
  ariaSetSize,
  ariaPosInSet,
  breakpoint,
  rowRef,
  graphSlot,
  refSlot,
  onFocus,
  onSelect,
  onOpen,
  onOpenMenu,
}: HistoryRowProps) {
  const shortSha = entry.shortSha ?? entry.sha.slice(0, 7);
  const subject = entry.subject || "(no subject)";
  const showRefs = breakpoint !== "narrow";
  const showAuthor = breakpoint === "wide";
  const showSha = breakpoint !== "narrow";
  const rowTitle = `${subject}\nAuthor: ${entry.authorName}\nSHA: ${entry.sha}`;

  /** Opens the commit action menu aligned to the row or action trigger. */
  function openMenuFromElement(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    onOpenMenu({
      entry,
      point: { x: Math.max(4, rect.right - 188), y: rect.bottom + 2 },
    });
  }

  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={selected}
      aria-setsize={ariaSetSize}
      aria-posinset={ariaPosInSet}
      tabIndex={tabIndex}
      title={rowTitle}
      className={
        selected
          ? `${HISTORY_ROW_GRID_CLASS_BY_BREAKPOINT[breakpoint]} ${HISTORY_ROW_INTERACTION_CLASS} border-ring bg-[var(--state-active-bg)]`
          : `${HISTORY_ROW_GRID_CLASS_BY_BREAKPOINT[breakpoint]} ${HISTORY_ROW_INTERACTION_CLASS} border-transparent hover:bg-[var(--state-hover-bg)]`
      }
      onFocus={onFocus}
      onClick={() => {
        onSelect(entry);
        onOpen(entry);
      }}
      onDoubleClick={() => {
        onSelect(entry);
        onOpen(entry);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          onSelect(entry);
          onOpen(entry);
        }
        if (event.key === "." && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          openMenuFromElement(event.currentTarget);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu({ entry, point: { x: event.clientX, y: event.clientY } });
      }}
    >
      <span
        className="flex min-w-0 items-center justify-center"
        aria-hidden={graphSlot ? undefined : true}
      >
        {graphSlot ?? <span className="size-1.5 rounded-full bg-muted-foreground/70" />}
      </span>
      {showRefs ? (
        <span className="min-w-0 overflow-hidden" aria-hidden={refSlot ? undefined : true}>
          {refSlot}
        </span>
      ) : null}
      <span className="truncate leading-6" title={rowTitle}>
        {subject}
      </span>
      {showAuthor ? (
        <span className="truncate text-muted-foreground" title={entry.authorName}>
          {entry.authorName}
        </span>
      ) : null}
      <span className="truncate text-right text-muted-foreground" title={entry.authoredAt}>
        {relativeTime(entry.authoredAt)}
      </span>
      {showSha ? (
        <span className="truncate font-mono text-muted-foreground" title={entry.sha}>
          {shortSha}
        </span>
      ) : null}
      <button
        type="button"
        className="size-6 rounded p-1 text-muted-foreground opacity-0 hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100"
        aria-label={`Open commit actions for ${shortSha}`}
        onClick={(event) => {
          event.stopPropagation();
          openMenuFromElement(event.currentTarget);
        }}
      >
        <MoreHorizontal className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export { relativeTime };
