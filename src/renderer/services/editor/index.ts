import type * as Monaco from "monaco-editor";
import { initializeLspBridge } from "./lsp-bridge";
import { initializeModelCache } from "./model-cache";

export { useSharedModel } from "./model-cache";
export {
  closeEditor,
  findEditorTab,
  findEditorTabInGroup,
  openOrRevealEditor,
} from "./open-editor";
export type { EditorInput, EditorTabLocation, EditorTabProps, OpenEditorOptions } from "./types";

export function initializeEditorServices(monaco: typeof Monaco): void {
  initializeModelCache(monaco);
  initializeLspBridge(monaco);
}
