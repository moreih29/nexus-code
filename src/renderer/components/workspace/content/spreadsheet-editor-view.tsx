// The editor surface of a spreadsheet file: the breadcrumb toolbar the other
// editors have, and the workbook's sheets below. Spreadsheets are not
// editable.

import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { SpreadsheetPreview } from "../../editor/preview/spreadsheet-preview";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";

interface SpreadsheetEditorViewProps {
  filePath: string;
  workspaceId: string;
}

export function SpreadsheetEditorView({ filePath, workspaceId }: SpreadsheetEditorViewProps) {
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--surface-island-border)]">
        <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <SpreadsheetPreview workspaceId={workspaceId} filePath={filePath} />
      </div>
    </div>
  );
}
