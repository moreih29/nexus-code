/**
 * Single-line commit row for the History list.
 */
import { MoreHorizontal } from "lucide-react";
import type { LogEntry } from "../../../../../shared/types/git";

export interface HistoryRowMenuRequest {
  entry: LogEntry;
  point: { x: number; y: number };
}

interface HistoryRowProps {
  entry: LogEntry;
  selected: boolean;
  onSelect: (entry: LogEntry) => void;
  onOpenMenu: (request: HistoryRowMenuRequest) => void;
}

/** Renders one focusable commit row with hover, selected, and focus states. */
export function HistoryRow({ entry, selected, onSelect, onOpenMenu }: HistoryRowProps) {
  const shortSha = entry.shortSha ?? entry.sha.slice(0, 7);
  const subject = entry.subject || "(no subject)";

  function openMenuFromElement(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    onOpenMenu({
      entry,
      point: { x: Math.max(4, rect.right - 188), y: rect.bottom + 2 },
    });
  }

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className={
        selected
          ? "group grid h-8 grid-cols-[10px_minmax(0,1fr)_8ch_5ch_7ch_24px] items-center gap-2 border-l-2 border-ring bg-frosted-veil-strong pl-1 pr-1 text-app-ui-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          : "group grid h-8 grid-cols-[10px_minmax(0,1fr)_8ch_5ch_7ch_24px] items-center gap-2 border-l-2 border-transparent pl-1 pr-1 text-app-ui-sm text-foreground hover:bg-frosted-veil focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      }
      onClick={() => onSelect(entry)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect(entry);
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
      <span className="size-1.5 rounded-full bg-muted-foreground/70" aria-hidden="true" />
      <span className="truncate" title={subject}>
        {subject}
      </span>
      <span className="truncate text-muted-foreground" title={entry.authorName}>
        {entry.authorName}
      </span>
      <span className="truncate text-right text-muted-foreground" title={entry.authoredAt}>
        {relativeTime(entry.authoredAt)}
      </span>
      <span className="truncate font-mono text-muted-foreground">{shortSha}</span>
      <button
        type="button"
        className="rounded p-1 text-muted-foreground opacity-0 hover:bg-frosted-veil-strong hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100"
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

/** Formats a compact relative timestamp for fixed-width history rows. */
export function relativeTime(isoDate: string): string {
  const then = Date.parse(isoDate);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
