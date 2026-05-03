// Side-effect import: registers the fs.changed subscription on module load.
// Must be retained even if no symbol is referenced from this module.
import "./subscriber";

export { parentOf, selectFlat } from "./helpers";
export { useFilesStore } from "./store";
export { handleFsChanged } from "./subscriber";
export type { FilesState, FlatItem, TreeNode, WorkspaceTree } from "./types";
