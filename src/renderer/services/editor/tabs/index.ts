// Production barrel for the tabs module group. Test-only helpers
// (__resetXxxForTests, stopXxxForTests) live in `./testing.ts` so the
// surface here stays free of internals app code shouldn't reach for.

export { closeEditor } from "./close-editor";
export type {
  CreateCrossFileOpenCodeEditorOpenerInput,
  CrossFileOpenCodeEditorOpener,
  ResourceUriLike,
} from "./cross-file-opener";
export { createCrossFileOpenCodeEditorOpener } from "./cross-file-opener";
export { openOrRevealEditor, PREVIEW_ENABLED } from "./open-editor";
export { openExternalEditor } from "./open-external-editor";
export { type PendingEditorReveal, registerRevealTarget } from "./pending-reveal";
export { promoteAllPreviewTabsForFile, startPromoteOnDirtyPolicy } from "./promote-policy";
export { revealRange } from "./reveal";
export { type RevealEditorAtOptions, revealEditorAt } from "./reveal-editor-at";
export { findEditorTab, findEditorTabInGroup, findPreviewTabInGroup } from "./tab-lookup";
