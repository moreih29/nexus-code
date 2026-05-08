export {
  closeEditor,
  findEditorTab,
  findEditorTabInGroup,
  findPreviewTabInGroup,
  openExternalEditor,
  openOrRevealEditor,
  PREVIEW_ENABLED,
} from "./open-editor";
export {
  requestEditorReveal,
  subscribePendingEditorReveal,
  takePendingEditorReveal,
  __resetPendingEditorRevealsForTests,
  type PendingEditorReveal,
} from "./pending-reveal";
export {
  promoteAllPreviewTabsForFile,
  startPromoteOnDirtyPolicy,
  stopPromoteOnDirtyPolicyForTests,
} from "./promote-policy";
export { createCrossFileOpenCodeEditorOpener } from "./cross-file-opener";
export type {
  CrossFileOpenCodeEditorOpener,
  CreateCrossFileOpenCodeEditorOpenerInput,
  ResourceUriLike,
} from "./cross-file-opener";
export { revealRange, applyPendingReveal } from "./reveal";
