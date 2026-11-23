import type { ReactNode } from "react";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { PreviewFindScope } from "../../editor/preview/preview-find";
import { SpreadsheetPreview } from "../../editor/preview/spreadsheet-preview";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";

interface SpreadsheetEditorViewProps {
  filePath: string;
  workspaceId: string;
  breadcrumbs?: ReactNode;
}

export function SpreadsheetEditorView({
  filePath,
  workspaceId,
  breadcrumbs,
}: SpreadsheetEditorViewProps) {
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 overflow-hidden px-2 py-1 border-b border-[var(--surface-island-border)]">
        {breadcrumbs ?? (
          <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
        )}
      </div>
      <PreviewFindScope className="flex-1 min-h-0">
        <SpreadsheetPreview workspaceId={workspaceId} filePath={filePath} />
      </PreviewFindScope>
    </div>
  );
}
