export type DirtyChangeType = "add" | "modify" | "delete";

export interface DirtyChange {
  type: DirtyChangeType;
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}
