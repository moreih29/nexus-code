/**
 * Commit detail pane for the History split view. Wide layouts render as the
 * draggable right pane; narrow layouts render as a right-side sheet.
 */
import { MoreHorizontal, X } from "lucide-react";
import type React from "react";
import { useRef } from "react";
import type { CommitDetail, LogEntry } from "../../../../../shared/types/git";
import { Button } from "../../../ui/button";
import type { HistoryRowMenuRequest } from "./HistoryRow";

interface HistoryDetailProps {
  detail: CommitDetail | null;
  loading: boolean;
  width: number;
  narrow: boolean;
  selectedEntry: LogEntry | null;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onOpenMenu: (request: HistoryRowMenuRequest) => void;
}

/** Renders commit metadata, body, merge label, and file changes. */
export function HistoryDetail({
  detail,
  loading,
  width,
  narrow,
  selectedEntry,
  onWidthChange,
  onClose,
  onOpenMenu,
}: HistoryDetailProps) {
  const paneRef = useRef<HTMLElement | null>(null);

  if (!detail && !loading) return null;

  const pane = (
    <aside
      ref={paneRef}
      className={
        narrow
          ? "absolute inset-y-0 right-0 z-30 flex w-[min(92vw,460px)] flex-col border-l border-mist-border bg-background shadow-lg"
          : "relative flex min-w-[280px] max-w-[70%] flex-col border-l border-mist-border bg-background"
      }
      style={narrow ? undefined : { flex: `0 0 ${width > 0 ? `${width}px` : "50%"}` }}
      aria-label="Commit detail"
    >
      {!narrow ? (
        <HistoryDetailResizeHandle paneRef={paneRef} onWidthChange={onWidthChange} />
      ) : null}
      <div className="flex items-start justify-between gap-2 border-b border-mist-border p-3">
        <div className="min-w-0">
          <h3 className="truncate text-app-body-emphasis text-foreground">
            {detail?.subject ?? "Loading commit…"}
          </h3>
          {detail ? (
            <p className="mt-1 truncate font-mono text-app-ui-xs text-muted-foreground">
              {detail.sha}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {detail && selectedEntry ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Commit actions"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenMenu({
                  entry: selectedEntry,
                  point: { x: Math.max(4, rect.right - 212), y: rect.bottom + 2 },
                });
              }}
            >
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {narrow ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Close commit detail"
              onClick={onClose}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto app-scrollbar p-3">
        {loading && !detail ? (
          <p className="text-app-ui-sm text-muted-foreground">Loading commit detail…</p>
        ) : detail ? (
          <CommitDetailContent detail={detail} />
        ) : null}
      </div>
    </aside>
  );

  return narrow ? <div className="absolute inset-0 z-20 bg-black/20">{pane}</div> : pane;
}

/** Renders the metadata and changed file list for one commit. */
export function CommitDetailContent({ detail }: { detail: CommitDetail }) {
  const isMerge = detail.parents.length > 1;

  return (
    <div className="flex flex-col gap-4 text-app-ui-sm">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Author</dt>
        <dd className="min-w-0 truncate text-foreground">{detail.author}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd className="min-w-0 truncate text-foreground">{detail.authorEmail}</dd>
        <dt className="text-muted-foreground">Time</dt>
        <dd className="min-w-0 truncate text-foreground">{formatIso(detail.committerTs)}</dd>
      </dl>
      {detail.body.length > 0 ? (
        <pre className="whitespace-pre-wrap rounded border border-mist-border bg-frosted-veil p-2 font-sans text-app-ui-sm text-foreground">
          {detail.body}
        </pre>
      ) : null}
      {isMerge ? (
        <div className="rounded border border-mist-border bg-frosted-veil p-2 text-muted-foreground">
          Merge commit ({detail.parents.length} parents)
        </div>
      ) : (
        <div>
          <h4 className="mb-2 text-app-ui-sm text-muted-foreground">
            Files changed ({detail.files.length})
          </h4>
          {detail.files.length === 0 ? (
            <p className="text-app-ui-sm text-muted-foreground">No file changes.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {detail.files.map((file) => (
                <li
                  key={`${file.status}:${file.oldPath ?? ""}:${file.path}`}
                  className="grid grid-cols-[52px_minmax(0,1fr)] gap-2 rounded bg-frosted-veil px-2 py-1"
                >
                  <span className="font-mono text-muted-foreground">{file.status}</span>
                  <span className="min-w-0 truncate text-foreground" title={file.path}>
                    {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Drag handle that persists the right pane width in GitPanelState. */
function HistoryDetailResizeHandle({
  paneRef,
  onWidthChange,
}: {
  paneRef: React.RefObject<HTMLElement | null>;
  onWidthChange: (width: number) => void;
}) {
  return (
    <button
      type="button"
      aria-label="Resize commit detail"
      className="absolute left-0 top-0 h-full w-1 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-frosted-veil-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onMouseDown={(event) => {
        event.preventDefault();
        const containerRight = paneRef.current?.parentElement?.getBoundingClientRect().right;
        if (!containerRight) return;
        const right = containerRight;

        function handleMove(moveEvent: MouseEvent): void {
          onWidthChange(clamp(right - moveEvent.clientX, 280, 900));
        }

        function handleUp(): void {
          document.removeEventListener("mousemove", handleMove);
          document.removeEventListener("mouseup", handleUp);
        }

        document.addEventListener("mousemove", handleMove);
        document.addEventListener("mouseup", handleUp, { once: true });
      }}
    />
  );
}

/** Formats the ISO timestamp shown in the detail metadata. */
function formatIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/** Clamps the detail width to usable panel bounds. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
