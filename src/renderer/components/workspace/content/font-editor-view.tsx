// The editor surface of a font file: the breadcrumb toolbar the other
// editors have, and the font set in sample text below. Fonts are not
// editable.

import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { FontPreview } from "../../editor/preview/font-preview";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";

interface FontEditorViewProps {
  filePath: string;
  workspaceId: string;
}

export function FontEditorView({ filePath, workspaceId }: FontEditorViewProps) {
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--surface-island-border)]">
        <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
      </div>
      <div className="flex-1 min-h-0 flex">
        <FontPreview workspaceId={workspaceId} filePath={filePath} />
      </div>
    </div>
  );
}
