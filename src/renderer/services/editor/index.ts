import type * as Monaco from "monaco-editor";
import { initializeDiagnosticsStore } from "../../state/stores/diagnostics";
import { useKeybindingsStore } from "../../state/stores/keybindings";
import { initializeLspServerUxRouter } from "../lsp-ux/server-ux-router";
import { initializeLspBridge } from "./lsp/bridge";
import { initializeModelCache } from "./model/cache";
import { registerExtraLanguages } from "./runtime/extra-languages";
import { installMonacoCompensations } from "./runtime/monaco-compensations";
import { initializeMonacoTheme, subscribeMonacoEditorFontChanges } from "./runtime/monaco-theme";
import { neutralizeBuiltInTypeScriptWorker } from "./runtime/monaco-ts-defaults";
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
  // Neutralize Monaco's built-in TS/JS worker before any model opens — it
  // would otherwise compete with our LSP for diagnostics, hover, completion,
  // etc., and on .tsx it can hang the hover widget on "Loading…" because the
  // worker's parser can't make sense of JSX without an explicit jsx option.
  // See monaco-ts-defaults.ts for the full rationale.
  neutralizeBuiltInTypeScriptWorker(monaco);
  initializeLspBridge(monaco);
  installMonacoCompensations(monaco);
  initializeLspServerUxRouter();
  startPromoteOnDirtyPolicy();
  initializeDiagnosticsStore(monaco);
  // Monaco basic-languages가 커버하지 못하는 TOML / Makefile / .env / Nix /
  // Justfile / go.mod / go.sum 을 보강 등록 (TextMate + Monarch).
  registerExtraLanguages(monaco);

  // Apply persisted editor keybinding overrides now that the Monaco
  // singleton is live. Bootstrap hydration usually runs before Monaco
  // mounts, so the store holds the overrides but the reconcile was a
  // no-op until this point.
  useKeybindingsStore.getState().applyEditorBindings();
}
