import i18next from "i18next";
import { useEffect } from "react";
import { notesApi } from "../../services/notes/api";
import { openOrRevealNoteTab } from "../../state/operations/tabs";
import { activateWorkspace } from "../../state/operations/workspace-selection";
import { showToast } from "../ui/toast";

export function NoteSummaryNotifications(): null {
  useEffect(
    () =>
      notesApi.onSummaryCompleted(({ workspaceId, noteId, title, todos, runId }) => {
        const name = title.trim() || i18next.t("notes:panel.untitled");
        showToast({
          kind: "info",
          message: i18next.t("notes:summary.toast", {
            title: name,
            summary: i18next.t("notes:summary.complete", { count: todos }),
          }),
          actions: [
            {
              label: i18next.t("notes:summary.open"),
              dedupeKey: runId,
              onAction: () => {
                activateWorkspace(workspaceId);
                openOrRevealNoteTab(workspaceId, noteId, title);
              },
            },
          ],
        });
      }),
    [],
  );
  return null;
}
