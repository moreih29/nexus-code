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

export interface ClaudeTranscriptReadRequest {
  transcriptPath: string;
  limit?: number | null;
}

export interface ClaudeTranscriptEntry {
  lineNumber: number;
  role: string;
  kind: string;
  summary: string;
  timestamp?: string;
}

export type ClaudeTranscriptReadResult =
  | {
      available: true;
      transcriptPath: string;
      entries: ClaudeTranscriptEntry[];
      readAt: string;
    }
  | {
      available: false;
      transcriptPath?: string;
      reason: string;
      readAt: string;
    };
