import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const NoteEditor = lazy(() =>
  import("./note-editor").then(({ NoteEditor }) => ({ default: NoteEditor })),
);

export function NoteTab({
  workspaceId,
  tabId,
  noteId,
  isVisible,
}: {
  workspaceId: string;
  tabId: string;
  noteId: string;
  isVisible: boolean;
}) {
  const { t } = useTranslation("notes");
  const loading = (
    <div className="flex h-full items-center justify-center p-6 text-app-ui-sm text-muted-foreground">
      {t("editor.loading")}
    </div>
  );

  return (
    <Suspense fallback={loading}>
      <NoteEditor
        workspaceId={workspaceId}
        tabId={tabId}
        noteId={noteId}
        isVisible={isVisible}
        loading={loading}
      />
    </Suspense>
  );
}
