import type { ReactNode } from "react";
import { useWorkspace } from "../../../state/stores/workspaces";
import { DocxPreview } from "../../editor/preview/docx-preview";
import { PreviewFindScope } from "../../editor/preview/preview-find";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";

interface DocxEditorViewProps {
  filePath: string;
  workspaceId: string;
  breadcrumbs?: ReactNode;
}

export function DocxEditorView({ filePath, workspaceId, breadcrumbs }: DocxEditorViewProps) {
  const workspaceRootAbsPath = useWorkspace(workspaceId, (w) => w?.rootPath ?? "");
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 overflow-hidden px-2 py-1 border-b border-[var(--surface-island-border)]">
        {breadcrumbs ?? (
          <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
        )}
      </div>
      <PreviewFindScope className="flex-1 min-h-0">
        <DocxPreview workspaceId={workspaceId} filePath={filePath} />
      </PreviewFindScope>
    </div>
  );
}
