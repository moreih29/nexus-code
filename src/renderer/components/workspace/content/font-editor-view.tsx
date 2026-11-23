import type { ReactNode } from "react";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { FontPreview } from "../../editor/preview/font-preview";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";

interface FontEditorViewProps {
  filePath: string;
  workspaceId: string;
  breadcrumbs?: ReactNode;
}

export function FontEditorView({ filePath, workspaceId, breadcrumbs }: FontEditorViewProps) {
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
      <div className="flex-1 min-h-0 flex">
        <FontPreview workspaceId={workspaceId} filePath={filePath} />
      </div>
    </div>
  );
}
