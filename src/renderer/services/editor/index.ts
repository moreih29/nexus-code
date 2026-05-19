import type * as Monaco from "monaco-editor";
import { initializeDiagnosticsStore } from "../../state/stores/diagnostics";
import { initializeLspServerUxRouter } from "../lsp-ux/server-ux-router";
import { initializeLspBridge } from "./lsp/bridge";
import { initializeModelCache } from "./model/cache";
import { installMonacoCompensations } from "./runtime/monaco-compensations";
import { initializeMonacoTheme, subscribeMonacoEditorFontChanges } from "./runtime/monaco-theme";
import { startPromoteOnDirtyPolicy } from "./tabs/promote-policy";

export { useSharedModel } from "./model/use-shared-model";
export { closeEditorWithConfirm } from "./save/close-handler";
export {
  reportSaveFailure,
  runSaveAndReport,
  saveModel,
  saveModelInteractive,
} from "./save/service";
export { openOrRevealEditor } from "./tabs/open-editor";
export type { EditorInput, EditorTabLocation, OpenEditorOptions } from "./types";

export function initializeEditorServices(monaco: typeof Monaco): void {
  initializeMonacoTheme(monaco);
  subscribeMonacoEditorFontChanges(monaco);
  initializeModelCache(monaco);
  initializeLspBridge(monaco);
  installMonacoCompensations(monaco);
  initializeLspServerUxRouter();
  startPromoteOnDirtyPolicy();
  initializeDiagnosticsStore(monaco);
}
