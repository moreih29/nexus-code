export interface WorkspaceDiffRequest {
  workspacePath: string;
  filePath?: string | null;
}

export type WorkspaceDiffFileKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "staged"
  | "unknown";

export interface WorkspaceDiffFile {
  path: string;
  status: string;
  kind: WorkspaceDiffFileKind;
}

export type WorkspaceDiffResult =
  | {
      available: true;
      workspacePath: string;
      files: WorkspaceDiffFile[];
      selectedFilePath: string | null;
      diff: string;
      generatedAt: string;
    }
  | {
      available: false;
      workspacePath?: string;
      reason: string;
      generatedAt: string;
    };
