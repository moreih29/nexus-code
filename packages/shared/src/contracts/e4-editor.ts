import type { WorkspaceId } from "./workspace";

export type E4FileKind = "file" | "directory";
export type E4FileEncoding = "utf8";
export type E4GitBadgeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "staged"
  | "ignored"
  | "conflicted"
  | "clean";
export type E4LspLanguage = "typescript" | "python" | "go";
export type E4DiagnosticSeverity = "error" | "warning" | "information" | "hint";
export type E4LspState = "starting" | "ready" | "stopped" | "unavailable" | "error";

export interface E4FileTreeNode {
  name: string;
  path: string;
  kind: E4FileKind;
  children?: E4FileTreeNode[];
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  gitBadge?: E4GitBadgeStatus | null;
}

export interface E4FileTreeReadRequest {
  type: "e4/file-tree/read";
  workspaceId: WorkspaceId;
  rootPath?: string | null;
}

export interface E4FileTreeReadResult {
  type: "e4/file-tree/read/result";
  workspaceId: WorkspaceId;
  rootPath: string;
  nodes: E4FileTreeNode[];
  readAt: string;
}

export interface E4FileCreateRequest {
  type: "e4/file/create";
  workspaceId: WorkspaceId;
  path: string;
  kind: E4FileKind;
  content?: string;
  overwrite?: boolean;
}

export interface E4FileCreateResult {
  type: "e4/file/create/result";
  workspaceId: WorkspaceId;
  path: string;
  kind: E4FileKind;
  createdAt: string;
}

export interface E4FileDeleteRequest {
  type: "e4/file/delete";
  workspaceId: WorkspaceId;
  path: string;
  recursive?: boolean;
}

export interface E4FileDeleteResult {
  type: "e4/file/delete/result";
  workspaceId: WorkspaceId;
  path: string;
  deletedAt: string;
}

export interface E4FileRenameRequest {
  type: "e4/file/rename";
  workspaceId: WorkspaceId;
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
}

export interface E4FileRenameResult {
  type: "e4/file/rename/result";
  workspaceId: WorkspaceId;
  oldPath: string;
  newPath: string;
  renamedAt: string;
}

export interface E4FileReadRequest {
  type: "e4/file/read";
  workspaceId: WorkspaceId;
  path: string;
}

export interface E4FileReadResult {
  type: "e4/file/read/result";
  workspaceId: WorkspaceId;
  path: string;
  content: string;
  encoding: E4FileEncoding;
  version: string;
  readAt: string;
}

export interface E4FileWriteRequest {
  type: "e4/file/write";
  workspaceId: WorkspaceId;
  path: string;
  content: string;
  encoding?: E4FileEncoding;
  expectedVersion?: string | null;
}

export interface E4FileWriteResult {
  type: "e4/file/write/result";
  workspaceId: WorkspaceId;
  path: string;
  encoding: E4FileEncoding;
  version: string;
  writtenAt: string;
}

export type E4FileWatchChangeKind = "created" | "changed" | "deleted" | "renamed";

export interface E4FileWatchEvent {
  type: "e4/file/watch";
  workspaceId: WorkspaceId;
  path: string;
  kind: E4FileKind;
  change: E4FileWatchChangeKind;
  oldPath?: string | null;
  occurredAt: string;
}

export interface E4GitBadge {
  path: string;
  status: E4GitBadgeStatus;
}

export interface E4GitBadgesReadRequest {
  type: "e4/git-badges/read";
  workspaceId: WorkspaceId;
  paths?: string[] | null;
}

export interface E4GitBadgesReadResult {
  type: "e4/git-badges/read/result";
  workspaceId: WorkspaceId;
  badges: E4GitBadge[];
  readAt: string;
}

export interface E4GitBadgesChangedEvent {
  type: "e4/git-badges/changed";
  workspaceId: WorkspaceId;
  badges: E4GitBadge[];
  changedAt: string;
}

export interface E4LspPosition {
  line: number;
  character: number;
}

export interface E4LspRange {
  start: E4LspPosition;
  end: E4LspPosition;
}

export interface E4Diagnostic {
  path: string;
  language: E4LspLanguage;
  range: E4LspRange;
  severity: E4DiagnosticSeverity;
  message: string;
  source?: string | null;
  code?: string | number | null;
}

export interface E4LspStatus {
  language: E4LspLanguage;
  state: E4LspState;
  serverName?: string | null;
  message?: string | null;
  updatedAt: string;
}

export interface E4LspDiagnosticsReadRequest {
  type: "e4/lsp-diagnostics/read";
  workspaceId: WorkspaceId;
  path?: string | null;
  language?: E4LspLanguage | null;
}

export interface E4LspDiagnosticsReadResult {
  type: "e4/lsp-diagnostics/read/result";
  workspaceId: WorkspaceId;
  diagnostics: E4Diagnostic[];
  readAt: string;
}

export interface E4LspStatusReadRequest {
  type: "e4/lsp-status/read";
  workspaceId: WorkspaceId;
  languages?: E4LspLanguage[] | null;
}

export interface E4LspStatusReadResult {
  type: "e4/lsp-status/read/result";
  workspaceId: WorkspaceId;
  statuses: E4LspStatus[];
  readAt: string;
}

export interface E4LspDocumentOpenRequest {
  type: "e4/lsp-document/open";
  workspaceId: WorkspaceId;
  path: string;
  language: E4LspLanguage;
  content: string;
  version?: number | null;
}

export interface E4LspDocumentOpenResult {
  type: "e4/lsp-document/open/result";
  workspaceId: WorkspaceId;
  path: string;
  language: E4LspLanguage;
  status: E4LspStatus;
  openedAt: string;
}

export interface E4LspDocumentChangeRequest {
  type: "e4/lsp-document/change";
  workspaceId: WorkspaceId;
  path: string;
  language: E4LspLanguage;
  content: string;
  version?: number | null;
}

export interface E4LspDocumentChangeResult {
  type: "e4/lsp-document/change/result";
  workspaceId: WorkspaceId;
  path: string;
  language: E4LspLanguage;
  status: E4LspStatus;
  changedAt: string;
}

export interface E4LspDocumentCloseRequest {
  type: "e4/lsp-document/close";
  workspaceId: WorkspaceId;
  path: string;
  language: E4LspLanguage;
}

export interface E4LspDocumentCloseResult {
  type: "e4/lsp-document/close/result";
  workspaceId: WorkspaceId;
  path: string;
  language: E4LspLanguage;
  closedAt: string;
}

export interface E4LspDiagnosticsEvent {
  type: "e4/lsp-diagnostics/changed";
  workspaceId: WorkspaceId;
  path: string;
  language: E4LspLanguage;
  diagnostics: E4Diagnostic[];
  version?: string | null;
  publishedAt: string;
}

export interface E4LspStatusEvent {
  type: "e4/lsp-status/changed";
  workspaceId: WorkspaceId;
  status: E4LspStatus;
}

export type E4EditorRequest =
  | E4FileTreeReadRequest
  | E4FileCreateRequest
  | E4FileDeleteRequest
  | E4FileRenameRequest
  | E4FileReadRequest
  | E4FileWriteRequest
  | E4GitBadgesReadRequest
  | E4LspDiagnosticsReadRequest
  | E4LspStatusReadRequest
  | E4LspDocumentOpenRequest
  | E4LspDocumentChangeRequest
  | E4LspDocumentCloseRequest;

export type E4EditorResult =
  | E4FileTreeReadResult
  | E4FileCreateResult
  | E4FileDeleteResult
  | E4FileRenameResult
  | E4FileReadResult
  | E4FileWriteResult
  | E4GitBadgesReadResult
  | E4LspDiagnosticsReadResult
  | E4LspStatusReadResult
  | E4LspDocumentOpenResult
  | E4LspDocumentChangeResult
  | E4LspDocumentCloseResult;

export type E4EditorEvent =
  | E4FileWatchEvent
  | E4GitBadgesChangedEvent
  | E4LspDiagnosticsEvent
  | E4LspStatusEvent;

export type E4EditorResultFor<TRequest extends E4EditorRequest> =
  TRequest extends E4FileTreeReadRequest
    ? E4FileTreeReadResult
    : TRequest extends E4FileCreateRequest
      ? E4FileCreateResult
      : TRequest extends E4FileDeleteRequest
        ? E4FileDeleteResult
        : TRequest extends E4FileRenameRequest
          ? E4FileRenameResult
          : TRequest extends E4FileReadRequest
            ? E4FileReadResult
            : TRequest extends E4FileWriteRequest
              ? E4FileWriteResult
              : TRequest extends E4GitBadgesReadRequest
                ? E4GitBadgesReadResult
                : TRequest extends E4LspDiagnosticsReadRequest
                  ? E4LspDiagnosticsReadResult
                  : TRequest extends E4LspStatusReadRequest
                    ? E4LspStatusReadResult
                    : TRequest extends E4LspDocumentOpenRequest
                      ? E4LspDocumentOpenResult
                      : TRequest extends E4LspDocumentChangeRequest
                        ? E4LspDocumentChangeResult
                        : TRequest extends E4LspDocumentCloseRequest
                          ? E4LspDocumentCloseResult
                          : never;
