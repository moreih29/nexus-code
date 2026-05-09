// Production barrel for the tabs module group. Test-only helpers
// (__resetXxxForTests, stopXxxForTests) live in `./testing.ts` so the
// surface here stays free of internals app code shouldn't reach for.

export {
  closeEditor,
  findEditorTab,
  findEditorTabInGroup,
  findPreviewTabInGroup,
  openExternalEditor,
  openOrRevealEditor,
  PREVIEW_ENABLED,
} from "./open-editor";
export { revealEditorAt, type RevealEditorAtOptions } from "./reveal-editor-at";
export { registerRevealTarget, type PendingEditorReveal } from "./pending-reveal";
export { promoteAllPreviewTabsForFile, startPromoteOnDirtyPolicy } from "./promote-policy";
export { createCrossFileOpenCodeEditorOpener } from "./cross-file-opener";
export type {
  CrossFileOpenCodeEditorOpener,
  CreateCrossFileOpenCodeEditorOpenerInput,
  ResourceUriLike,
} from "./cross-file-opener";
export { revealRange } from "./reveal";
