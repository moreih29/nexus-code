import { AlertTriangle, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { toNativeDrivePath } from "../../../shared/fs/drive-path";
import { relativeTo } from "../../../shared/fs/relative-path";
import type { WorkspaceLocation } from "../../../shared/types/workspace";
import { rootPathFromLocation } from "../../../shared/types/workspace";
import { getEntryMetadata } from "../../services/editor/model";
import { requireMonaco } from "../../services/editor/runtime/monaco-singleton";
import { revealEditorAt } from "../../services/editor/tabs/reveal-editor-at";
import { useWorkspace } from "../../state/stores/workspaces";

export type DiagnosticKind = "error" | "warning";

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
  items.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine ||
      a.startColumn - b.startColumn,
  );
  return items;
}

function useWorkspaceMarkers(workspaceId: string, kind: DiagnosticKind): MarkerItem[] {
  const [markers, setMarkers] = useState<MarkerItem[]>(() => readMarkers(workspaceId, kind));
  useEffect(() => {
    setMarkers(readMarkers(workspaceId, kind));
    const monaco = requireMonaco();
    const sub = monaco.editor.onDidChangeMarkers(() => {
      setMarkers(readMarkers(workspaceId, kind));
    });
    return () => sub.dispose();
  }, [workspaceId, kind]);
  return markers;
}

interface FileGroup {
  filePath: string;
  basename: string;
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
  return workspaceRoot ? relativeTo(dir, workspaceRoot) : dir;
}

interface DiagnosticListProps {
  workspaceId: string;
  kind: DiagnosticKind;
  onClose: () => void;
}

export function DiagnosticList({
  workspaceId,
  kind,
  onClose,
}: DiagnosticListProps): React.ReactNode {
  const { t } = useTranslation();
  const markers = useWorkspaceMarkers(workspaceId, kind);
  const location: WorkspaceLocation | null = useWorkspace(workspaceId, (w) => w?.location ?? null);
  const workspaceRoot = location ? rootPathFromLocation(location) : null;

  const groups = useMemo(() => buildGroups(markers, workspaceRoot), [markers, workspaceRoot]);

  useEffect(() => {
    if (markers.length === 0) onClose();
  }, [markers.length, onClose]);

  if (groups.length === 0) {
    return (
      <p className="px-2 py-1 text-app-ui-sm text-muted-foreground">
        {kind === "error" ? t("diagnostics.no_errors") : t("diagnostics.no_warnings")}
      </p>
    );
  }
  return groups.map((group) => (
    <DiagnosticFileGroup
      key={group.filePath}
      group={group}
      kind={kind}
      workspaceId={workspaceId}
      onJump={onClose}
    />
  ));
}

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
      <header
        className="flex items-baseline gap-1.5 px-2 py-0.5"
        title={toNativeDrivePath(group.filePath)}
      >
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
        title={`${toNativeDrivePath(item.filePath)}:${item.startLine}:${item.startColumn} — ${item.message}`}
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
