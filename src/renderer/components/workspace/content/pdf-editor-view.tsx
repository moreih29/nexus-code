// The editor surface of a PDF file: the breadcrumb toolbar the other editors
// have, its right slot holding the page number and the zoom, and the pages
// below. PDFs are not editable.

import { Maximize2, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { type PdfControls, PdfPreview } from "../../editor/preview/pdf-preview";
import { PreviewFindScope } from "../../editor/preview/preview-find";
import { IconButton } from "../../ui/icon-button";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";

interface PdfEditorViewProps {
  filePath: string;
  workspaceId: string;
}

export function PdfEditorView({ filePath, workspaceId }: PdfEditorViewProps) {
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const [controls, setControls] = useState<PdfControls | null>(null);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--surface-island-border)]">
        <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
        {controls && <PdfToolbar controls={controls} />}
      </div>
      <PreviewFindScope className="flex-1 min-h-0">
        <PdfPreview workspaceId={workspaceId} filePath={filePath} onControls={setControls} />
      </PreviewFindScope>
    </div>
  );
}

function PdfToolbar({ controls }: { controls: PdfControls }) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-1 text-app-ui-sm tabular-nums text-muted-foreground select-none">
      <span className="px-1">
        {controls.page} / {controls.pages}
      </span>
      <IconButton label={t("pdfPreview.zoom_out")} onClick={() => controls.zoom(-1)}>
        <Minus className="size-3.5" />
      </IconButton>
      <span className="w-10 text-center">{Math.round(controls.scale * 100)}%</span>
      <IconButton label={t("pdfPreview.zoom_in")} onClick={() => controls.zoom(1)}>
        <Plus className="size-3.5" />
      </IconButton>
      <IconButton label={t("pdfPreview.fit_width")} onClick={controls.fitWidth}>
        <Maximize2 className="size-3.5" />
      </IconButton>
    </div>
  );
}
