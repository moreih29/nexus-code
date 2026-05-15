import type * as Monaco from "monaco-editor";
import { initializeLspServerUxRouter } from "../lsp/server-ux-router";
import { initializeLspBridge } from "./lsp/bridge";
import { initializeModelCache } from "./model/cache";
import { installMonacoCompensations } from "./runtime/monaco-compensations";
import { initializeMonacoTheme } from "./runtime/monaco-theme";
import { startPromoteOnDirtyPolicy } from "./tabs/promote-policy";

export { useSharedModel } from "./model/use-shared-model";
export { closeEditorWithConfirm } from "./save/close-handler";
export { saveModel } from "./save/service";
export { openOrRevealEditor } from "./tabs/open-editor";
export type { EditorInput, EditorTabLocation, OpenEditorOptions } from "./types";

export function initializeEditorServices(monaco: typeof Monaco): void {
  initializeMonacoTheme(monaco);
  initializeModelCache(monaco);
  initializeLspBridge(monaco);
  installMonacoCompensations(monaco);
  initializeLspServerUxRouter();
  startPromoteOnDirtyPolicy();
}
