export type Direction = "up" | "down" | "left" | "right";

export type IdFactory = () => string;

export interface SplitLeaf {
  kind: "leaf";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SplitBranch {
  kind: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  ratio: number;
  first: SplitNode;
  second: SplitNode;
}

export type SplitNode = SplitLeaf | SplitBranch;

export type SerializedNode = SplitNode;
