// Side-effect import: registers the workspace:removed subscription on module load.
import "./subscriber";

export { useLayoutStore } from "./store";
export type { LayoutLeaf, LayoutNode, LayoutSplit, WorkspaceLayout } from "./types";
