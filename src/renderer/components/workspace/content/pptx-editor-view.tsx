// The editor surface of a presentation: the breadcrumb toolbar the other
// editors have, and its slides below. Presentations are not editable.

import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { PptxPreview } from "../../editor/preview/pptx-preview";
import { PreviewFindScope } from "../../editor/preview/preview-find";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";

interface PptxEditorViewProps {
  filePath: string;
  workspaceId: string;
}

export function PptxEditorView({ filePath, workspaceId }: PptxEditorViewProps) {
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--surface-island-border)]">
        <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
      </div>
      <PreviewFindScope className="flex-1 min-h-0">
        <PptxPreview workspaceId={workspaceId} filePath={filePath} />
      </PreviewFindScope>
    </div>
  );
}
