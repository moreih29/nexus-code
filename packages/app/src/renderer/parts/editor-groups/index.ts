export {
  EDITOR_GROUP_DOCKABLE_TAB_KINDS,
  EDITOR_GROUP_GRID_SLOT_COUNT,
  EditorGroupsGridShell,
  EditorGroupsPart,
  createEditorGroupGridSlots,
  createEditorGroupsPartFactory,
} from "./EditorGroupsPart";
export type {
  EditorGroupGridSlot,
  EditorGroupsGridShellProps,
  EditorGroupsPartFactoryOptions,
  EditorGroupsPartProps,
} from "./EditorGroupsPart";
export { TerminalPaneAdapter, attachTerminalPaneAdapterHost } from "./TerminalPaneAdapter";
export type { AttachTerminalPaneAdapterHostInput, TerminalPaneAdapterProps } from "./TerminalPaneAdapter";
export { resolveEditorDropEdge } from "./edge-resolver";
export type { EditorDropEdgeResolverRect, ResolveEditorDropEdgeInput } from "./edge-resolver";
