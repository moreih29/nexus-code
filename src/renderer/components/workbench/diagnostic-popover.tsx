// diagnostic-popover.tsx — status-bar popover listing the workspace's
// errors or warnings, grouped by file. Clicking an item opens the file at
// the diagnostic's range and dismisses the popover.
//
// Why not pre-store the marker details in the diagnostics store?
//   The store tracks counts only — keeping the full marker arrays in
//   Zustand would re-render every status bar on every keystroke as an LSP
//   streams diagnostics. The popover is a transient surface, so it reads
//   markers directly from Monaco on mount and subscribes to
//   onDidChangeMarkers while it is open. Closing the popover unhooks the
//   subscription.
//
// The trigger button + open state lives in status-bar.tsx; this file owns
// the panel surface and the data-shape used inside it.

import { AlertTriangle, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { WorkspaceLocation } from "../../../shared/types/workspace";
import { rootPathFromLocation } from "../../../shared/types/workspace";
import { getEntryMetadata } from "../../services/editor/model";
import { requireMonaco } from "../../services/editor/runtime/monaco-singleton";
import { revealEditorAt } from "../../services/editor/tabs/reveal-editor-at";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { useDismissOnOutsideClick } from "../ui/use-dismiss-on-outside-click";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DiagnosticKind = "error" | "warning";

// ---------------------------------------------------------------------------
// Marker reader — pulls markers directly from Monaco
// ---------------------------------------------------------------------------

interface MarkerItem {
  filePath: string;
  origin: "workspace" | "external" | "untitled";
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
  source?: string;
}

function readMarkers(workspaceId: string, kind: DiagnosticKind): MarkerItem[] {
  const monaco = requireMonaco();
  const wanted = kind === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning;
  const items: MarkerItem[] = [];
  for (const m of monaco.editor.getModelMarkers({})) {
    if (m.severity !== wanted) continue;
    const meta = getEntryMetadata(m.resource.toString());
    if (!meta || meta.workspaceId !== workspaceId) continue;
    items.push({
      filePath: meta.filePath,
      origin: meta.origin,
      startLine: m.startLineNumber,
      startColumn: m.startColumn,
      endLine: m.endLineNumber,
      endColumn: m.endColumn,
      message: typeof m.message === "string" ? m.message : String(m.message),
      source: m.source,
    });
  }
  // Sort: file path A→Z, then by line, then by column. Stable grouping for
  // the rendered list below.
  items.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine ||
      a.startColumn - b.startColumn,
  );
  return items;
}

/**
 * Reads markers for the workspace + kind, and re-reads whenever Monaco
 * emits onDidChangeMarkers. The subscription is only installed while this
 * hook is mounted — the popover unmounts on close, so the listener is
 * scoped to the popover's lifetime.
 */
function useWorkspaceMarkers(workspaceId: string, kind: DiagnosticKind): MarkerItem[] {
  const [markers, setMarkers] = useState<MarkerItem[]>(() => readMarkers(workspaceId, kind));
  useEffect(() => {
    // Read once on (re-)mount in case markers changed between render and effect.
    setMarkers(readMarkers(workspaceId, kind));
    const monaco = requireMonaco();
    const sub = monaco.editor.onDidChangeMarkers(() => {
      setMarkers(readMarkers(workspaceId, kind));
    });
    return () => sub.dispose();
  }, [workspaceId, kind]);
  return markers;
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

interface FileGroup {
  filePath: string;
  basename: string;
  /** Path relative to workspace root, without the basename. "" when at root. */
  relativeDir: string;
  items: MarkerItem[];
}

function buildGroups(markers: MarkerItem[], workspaceRoot: string | null): FileGroup[] {
  const groups: FileGroup[] = [];
  let current: FileGroup | null = null;
  for (const m of markers) {
    if (!current || current.filePath !== m.filePath) {
      current = {
        filePath: m.filePath,
        basename: basenameOf(m.filePath),
        relativeDir: relativeDirOf(m.filePath, workspaceRoot),
        items: [],
      };
      groups.push(current);
    }
    current.items.push(m);
  }
  return groups;
}

function basenameOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

function relativeDirOf(filePath: string, workspaceRoot: string | null): string {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash < 0) return "";
  const dir = filePath.slice(0, lastSlash);
  if (!workspaceRoot) return dir;
  // Normalize trailing slash so "/root" matches "/root/foo".
  const root = workspaceRoot.endsWith("/") ? workspaceRoot.slice(0, -1) : workspaceRoot;
  if (dir === root) return "";
  if (dir.startsWith(`${root}/`)) return dir.slice(root.length + 1);
  return dir; // outside the workspace — show absolute
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DiagnosticPopoverProps {
  workspaceId: string;
  kind: DiagnosticKind;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

export function DiagnosticPopover({
  workspaceId,
  kind,
  wrapperRef,
  onClose,
}: DiagnosticPopoverProps): React.JSX.Element {
  const { t } = useTranslation();
  const markers = useWorkspaceMarkers(workspaceId, kind);
  const location: WorkspaceLocation | null = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location ?? null,
  );
  const workspaceRoot = location ? rootPathFromLocation(location) : null;

  const groups = useMemo(() => buildGroups(markers, workspaceRoot), [markers, workspaceRoot]);

  // Auto-dismiss when the underlying list goes empty (e.g. the LSP cleared
  // all diagnostics while the popover was open). The trigger button itself
  // becomes disabled when count drops to zero in the status bar.
  useEffect(() => {
    if (markers.length === 0) onClose();
  }, [markers.length, onClose]);

  useDismissOnOutsideClick(wrapperRef, true, onClose);

  const listRef = useRef<HTMLDivElement>(null);

  return (
    <div
      role="dialog"
      aria-label={kind === "error" ? t("diagnostics.errors_dialog") : t("diagnostics.warnings_dialog")}
      className={cn(
        // Anchored above the status bar segment. Wide enough for messages,
        // capped so long workspaces still leave breathing room on the right.
        "absolute bottom-full left-0 z-40 mb-1",
        "w-[480px] max-w-[min(480px,calc(100vw-2rem))]",
        "max-h-[min(360px,60vh)] overflow-y-auto",
        "floating-panel p-1",
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      ref={listRef}
    >
      {groups.length === 0 ? (
        <p className="px-2 py-1 text-app-ui-sm text-muted-foreground">
          {kind === "error" ? t("diagnostics.no_errors") : t("diagnostics.no_warnings")}
        </p>
      ) : (
        groups.map((group) => (
          <DiagnosticFileGroup
            key={group.filePath}
            group={group}
            kind={kind}
            workspaceId={workspaceId}
            onJump={onClose}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File group + row
// ---------------------------------------------------------------------------

function DiagnosticFileGroup({
  group,
  kind,
  workspaceId,
  onJump,
}: {
  group: FileGroup;
  kind: DiagnosticKind;
  workspaceId: string;
  onJump: () => void;
}): React.JSX.Element {
  return (
    <div className="mb-1 last:mb-0">
      <header className="flex items-baseline gap-1.5 px-2 py-0.5" title={group.filePath}>
        <span className="truncate text-app-ui-sm text-foreground font-medium">
          {group.basename}
        </span>
        {group.relativeDir ? (
          <span className="truncate text-app-ui-sm text-muted-foreground">{group.relativeDir}</span>
        ) : null}
      </header>
      <ul className="flex flex-col">
        {group.items.map((item) => (
          <DiagnosticRow
            key={`${item.startLine}:${item.startColumn}:${item.message}`}
            item={item}
            kind={kind}
            onClick={() => {
              revealEditorAt(
                { workspaceId, filePath: item.filePath, origin: item.origin },
                {
                  selection: {
                    startLineNumber: item.startLine,
                    startColumn: item.startColumn,
                    endLineNumber: item.endLine,
                    endColumn: item.endColumn,
                  },
                },
              );
              onJump();
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function DiagnosticRow({
  item,
  kind,
  onClick,
}: {
  item: MarkerItem;
  kind: DiagnosticKind;
  onClick: () => void;
}): React.JSX.Element {
  const Icon = kind === "error" ? XCircle : AlertTriangle;
  const glyphColor =
    kind === "error" ? "var(--status-bar-error-bg)" : "var(--status-bar-warning-bg)";

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-2 rounded-(--radius-control) px-2 py-1 text-left",
          "text-app-ui-sm text-foreground",
          "hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none",
        )}
        title={`${item.filePath}:${item.startLine}:${item.startColumn} — ${item.message}`}
      >
        <Icon
          className="size-3 shrink-0 mt-[3px]"
          style={{ color: glyphColor }}
          aria-hidden="true"
        />
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {item.startLine}:{item.startColumn}
        </span>
        <span className="min-w-0 flex-1 truncate">{item.message}</span>
        {item.source ? <span className="shrink-0 text-muted-foreground">{item.source}</span> : null}
      </button>
    </li>
  );
}
