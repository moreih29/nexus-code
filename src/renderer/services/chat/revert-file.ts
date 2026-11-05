// Putting one file a Claude session changed back as it was before the
// session. The file is replaced through its editor model and saved, so an
// open editor follows and can undo it; a file the session wrote new is
// deleted the way the file tree deletes one.

import i18next from "i18next";
import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
import { showConfirmDialog } from "../../components/ui/confirm-dialog";
import { showToast } from "../../components/ui/toast";
import { fileErrorMessage } from "../../utils/file-error";
import { acquireModel, releaseModel } from "../editor/model";
import { reportSaveFailure, saveModelInteractive } from "../editor/save/service";
import { confirmAndDeletePath } from "../fs-mutations/confirm-delete";
import { baseName } from "./links";

/**
 * Asks, then reverts `path` in the workspace at `root` to `before` (null:
 * the session wrote it new, so it goes). Resolves whether it was reverted.
 */
export async function revertChangedFile(
  workspaceId: string,
  root: string,
  path: string,
  before: string | null,
): Promise<boolean> {
  const name = baseName(path);
  if (before === null) return confirmAndDeletePath(workspaceId, root, path, "file", name);
  const confirmed = await showConfirmDialog({
    title: i18next.t("chat.look.revert_title", { name }),
    description: i18next.t("chat.look.revert_description"),
    confirmLabel: i18next.t("chat.look.revert_confirm"),
    variant: "destructive",
  });
  if (!confirmed) return false;
  const input = { workspaceId, filePath: path };
  const failed = (error: string) => {
    showToast({ kind: "error", message: i18next.t("chat.look.revert_failed", { name, error }) });
    return false;
  };
  let state: Awaited<ReturnType<typeof acquireModel>>;
  try {
    state = await acquireModel(input);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  try {
    const model = state.model;
    if (!model) {
      return failed(
        fileErrorMessage(state.errorCode ?? "OTHER", MAX_READABLE_FILE_SIZE / 1024 ** 2),
      );
    }
    if (state.readOnly) return failed(i18next.t("errors:save.read_only"));
    if (model.getValue() !== before) {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: before }],
        () => null,
      );
    }
    const result = await saveModelInteractive(input);
    if (result.kind !== "saved" && result.kind !== "not-dirty") {
      reportSaveFailure(result);
      return false;
    }
    showToast({ kind: "info", message: i18next.t("chat.look.reverted", { name }) });
    return true;
  } finally {
    releaseModel(input);
  }
}
