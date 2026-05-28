// Side-effect import: registers the fs.changed subscription on module load.
// Must be retained even if no symbol is referenced from this module.
import "./subscriber";

export { parentOf, selectFlat } from "./helpers";
export {
  emptySelection,
  extendSelection,
  getOperablePaths,
  isFocused,
  isSelected,
  selectAll,
  singleSelection,
  toggleInSelection,
} from "./selection";
export {
  selectFocus,
  selectFocusedPaths,
  selectIsFocused,
  selectIsSelected,
  selectOperablePaths,
} from "./selectors";
export { useFilesStore } from "./store";
export { handleFsChanged } from "./subscriber";
export type {
  FileSelection,
  FilesState,
  FlatItem,
  PendingRenameRequest,
  TreeNode,
  WorkspaceTree,
} from "./types";
