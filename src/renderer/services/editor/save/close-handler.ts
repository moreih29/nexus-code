import { showSaveConfirm } from "@/components/editor/save-confirm-dialog";
import { releaseModel } from "@/services/editor/model";
import { closeTab } from "@/state/operations/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import { basename } from "@/utils/path";
import { untitledCacheUriFor } from "../../../../shared/fs/workspace-uri";
import { cacheUriFor } from "../model/cache";
import { isDirty } from "../model/dirty-tracker";
import { closeEditor, workingFileOfDiff } from "../tabs";
import { saveUntitledModel } from "./save-untitled-handler";
import { reportSaveFailure, saveModelInteractive } from "./service";

export type CloseTabOutcome = "closed" | "cancelled" | "save-failed";

function findTab(workspaceId: string, tabId: string) {
  return useTabsStore.getState().byWorkspace[workspaceId]?.[tabId] ?? null;
}

export async function closeEditorWithConfirm(
  workspaceId: string,
  tabId: string,
): Promise<CloseTabOutcome> {
  const tab = findTab(workspaceId, tabId);
  if (!tab || tab.type !== "editor") {
    return "closed";
  }

  const filePath = tab.props.filePath;
  const cacheUri = cacheUriFor(workspaceId, filePath);
  if (!isDirty(cacheUri)) {
    closeEditor(tabId);
    return "closed";
  }

  const choice = await showSaveConfirm(basename(filePath));

  if (choice === "cancel") return "cancelled";

  if (choice === "save") {
    const result = await saveModelInteractive({ workspaceId, filePath });
    if (result.kind !== "saved" && result.kind !== "not-dirty") {
      reportSaveFailure(result);
      return "save-failed";
    }
    if (isDirty(cacheUri)) return "cancelled";
  }

  closeEditor(tabId);
  return "closed";
}

export async function closeDiffWithConfirm(
  workspaceId: string,
  tabId: string,
): Promise<CloseTabOutcome> {
  const tab = findTab(workspaceId, tabId);
  if (!tab || tab.type !== "editor.diff") return "closed";

  const filePath = workingFileOfDiff(tab.props);
  const cacheUri = filePath === null ? null : cacheUriFor(workspaceId, filePath);
  if (
    filePath === null ||
    cacheUri === null ||
    !isDirty(cacheUri) ||
    otherTabShowsFile(workspaceId, tabId, filePath)
  ) {
    closeTab(workspaceId, tabId);
    return "closed";
  }

  const choice = await showSaveConfirm(basename(filePath));

  if (choice === "cancel") return "cancelled";

  if (choice === "save") {
    const result = await saveModelInteractive({ workspaceId, filePath });
    if (result.kind !== "saved" && result.kind !== "not-dirty") {
      reportSaveFailure(result);
      return "save-failed";
    }
    if (isDirty(cacheUri)) return "cancelled";
  }

  closeTab(workspaceId, tabId);
  return "closed";
}

function otherTabShowsFile(workspaceId: string, tabId: string, filePath: string): boolean {
  const tabs = Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
  return tabs.some(
    (other) =>
      other.id !== tabId &&
      ((other.type === "editor" && other.props.filePath === filePath) ||
        (other.type === "editor.diff" && workingFileOfDiff(other.props) === filePath)),
  );
}

export async function closeUntitledWithConfirm(
  workspaceId: string,
  tabId: string,
): Promise<CloseTabOutcome> {
  const tab = findTab(workspaceId, tabId);
  if (!tab || tab.type !== "untitled") return "closed";

  const untitledFilePath = `Untitled-${tab.props.untitledIndex}`;

  const discard = () => {
    releaseModel({ workspaceId, filePath: untitledFilePath, origin: "untitled" });
    closeTab(workspaceId, tabId);
  };

  if (!isDirty(untitledCacheUriFor(workspaceId, tab.props.untitledIndex))) {
    discard();
    return "closed";
  }

  const choice = await showSaveConfirm(tab.title);

  if (choice === "cancel") return "cancelled";

  if (choice === "dont-save") {
    discard();
    return "closed";
  }

  const saveOutcome = await saveUntitledModel(workspaceId, tabId);

  if (saveOutcome === "saved") {
    const converted = findTab(workspaceId, tabId);
    if (!converted) return "closed";
    if (
      converted.type !== "editor" ||
      isDirty(cacheUriFor(workspaceId, converted.props.filePath))
    ) {
      return "cancelled";
    }
    closeEditor(tabId);
    return "closed";
  }

  if (saveOutcome === "cancelled") return "cancelled";

  return "save-failed";
}
