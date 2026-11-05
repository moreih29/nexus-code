// NotebookPreview — a Jupyter notebook drawn as its cells and outputs.
//
// The notebook is turned into one Markdown document (see notebook.ts),
// which MarkdownPreview draws: its links, code highlighting, headings and
// sanitizing of HTML apply to the notebook as to any Markdown file.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NotebookError, notebookToMarkdown } from "@/services/editor/preview/notebook";
import { MarkdownPreview } from "./markdown-preview";

interface NotebookPreviewProps {
  source: string;
  workspaceId: string;
  /** Absolute (POSIX) path of the notebook, against which its links resolve. */
  currentFileAbsPath: string;
  workspaceRootAbsPath: string;
}

export function NotebookPreview({
  source,
  workspaceId,
  currentFileAbsPath,
  workspaceRootAbsPath,
}: NotebookPreviewProps) {
  const { t } = useTranslation();
  const notebook = useMemo(() => {
    try {
      return notebookToMarkdown(source);
    } catch (error) {
      if (error instanceof NotebookError) return error;
      throw error;
    }
  }, [source]);

  if (notebook instanceof NotebookError) {
    return (
      <div
        role="status"
        className="h-full p-4 text-app-ui-sm text-muted-foreground bg-[var(--surface-backdrop-bg)]"
      >
        {t(`notebookPreview.${notebook.reason}`)}
      </div>
    );
  }
  return (
    <MarkdownPreview
      source={notebook.markdown}
      images={notebook.images}
      workspaceId={workspaceId}
      currentFileAbsPath={currentFileAbsPath}
      workspaceRootAbsPath={workspaceRootAbsPath}
    />
  );
}
