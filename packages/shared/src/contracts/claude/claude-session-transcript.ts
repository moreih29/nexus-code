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
