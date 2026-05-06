import type * as Monaco from "monaco-editor";
import { initializeLspServerUxRouter } from "../lsp/server-ux-router";
import { initializeLspBridge } from "./lsp-bridge";
import { initializeModelCache } from "./model-cache";
import { initializeMonacoTheme } from "./monaco-theme";
import { startPromoteOnDirtyPolicy } from "./promote-policy";

export type { CloseTabOutcome } from "./close-handler";
export { closeEditorWithConfirm } from "./close-handler";
export { isDirty, subscribeFile as subscribeDirty } from "./dirty-tracker";
export { cacheUriToFilePath, filePathToModelUri } from "./model-cache";
export {
  closeEditor,
  findEditorTab,
  findEditorTabInGroup,
  findPreviewTabInGroup,
  openOrRevealEditor,
  PREVIEW_ENABLED,
} from "./open-editor";
export type { SaveResult } from "./save-service";
export { saveModel } from "./save-service";
export type { EditorInput, EditorTabLocation, EditorTabProps, OpenEditorOptions } from "./types";
export { useSharedModel } from "./use-shared-model";

export function initializeEditorServices(monaco: typeof Monaco): void {
  initializeMonacoTheme(monaco);
  initializeModelCache(monaco);
  initializeLspBridge(monaco);
  initializeLspServerUxRouter();
  startPromoteOnDirtyPolicy();
}
