import type { WorkspaceId } from "../workspace/workspace";

export type LspLanguage = "typescript" | "python" | "go";
export type LspDiagnosticSeverity = "error" | "warning" | "information" | "hint";
export type LspState = "starting" | "ready" | "stopped" | "unavailable" | "error";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  path: string;
  language: LspLanguage;
  range: LspRange;
  severity: LspDiagnosticSeverity;
  message: string;
  source?: string | null;
  code?: string | number | null;
}

export interface LspStatus {
  language: LspLanguage;
  state: LspState;
  serverName?: string | null;
  message?: string | null;
  updatedAt: string;
}

export interface LspDiagnosticsReadRequest {
  type: "lsp-diagnostics/read";
  workspaceId: WorkspaceId;
  path?: string | null;
  language?: LspLanguage | null;
}

export interface LspDiagnosticsReadResult {
  type: "lsp-diagnostics/read/result";
  workspaceId: WorkspaceId;
  diagnostics: LspDiagnostic[];
  readAt: string;
}

export interface LspStatusReadRequest {
  type: "lsp-status/read";
  workspaceId: WorkspaceId;
  languages?: LspLanguage[] | null;
}

export interface LspStatusReadResult {
  type: "lsp-status/read/result";
  workspaceId: WorkspaceId;
  statuses: LspStatus[];
  readAt: string;
}

export interface LspDocumentOpenRequest {
  type: "lsp-document/open";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  content: string;
  version?: number | null;
}

export interface LspDocumentOpenResult {
  type: "lsp-document/open/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  status: LspStatus;
  openedAt: string;
}

export interface LspDocumentChangeRequest {
  type: "lsp-document/change";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  content: string;
  version?: number | null;
}

export interface LspDocumentChangeResult {
  type: "lsp-document/change/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  status: LspStatus;
  changedAt: string;
}

export interface LspDocumentCloseRequest {
  type: "lsp-document/close";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
}

export interface LspDocumentCloseResult {
  type: "lsp-document/close/result";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  closedAt: string;
}

export interface LspDiagnosticsEvent {
  type: "lsp-diagnostics/changed";
  workspaceId: WorkspaceId;
  path: string;
  language: LspLanguage;
  diagnostics: LspDiagnostic[];
  version?: string | null;
  publishedAt: string;
}

export interface LspStatusEvent {
  type: "lsp-status/changed";
  workspaceId: WorkspaceId;
  status: LspStatus;
}
