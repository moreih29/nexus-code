export type * from "../workspace/workspace-files";
export type * from "../workspace/workspace-git-badges";
export type * from "../lsp/lsp-diagnostics";

import type {
  LspDiagnosticsEvent,
  LspDiagnosticsReadRequest,
  LspDiagnosticsReadResult,
  LspDocumentChangeRequest,
  LspDocumentChangeResult,
  LspDocumentCloseRequest,
  LspDocumentCloseResult,
  LspDocumentOpenRequest,
  LspDocumentOpenResult,
  LspStatusEvent,
  LspStatusReadRequest,
  LspStatusReadResult,
} from "../lsp/lsp-diagnostics";
import type {
  WorkspaceFileCreateRequest,
  WorkspaceFileCreateResult,
  WorkspaceFileDeleteRequest,
  WorkspaceFileDeleteResult,
  WorkspaceFileReadRequest,
  WorkspaceFileReadResult,
  WorkspaceFileRenameRequest,
  WorkspaceFileRenameResult,
  WorkspaceFileTreeReadRequest,
  WorkspaceFileTreeReadResult,
  WorkspaceFileWatchEvent,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
} from "../workspace/workspace-files";
import type {
  WorkspaceGitBadgesChangedEvent,
  WorkspaceGitBadgesReadRequest,
  WorkspaceGitBadgesReadResult,
} from "../workspace/workspace-git-badges";

export type EditorBridgeRequest =
  | WorkspaceFileTreeReadRequest
  | WorkspaceFileCreateRequest
  | WorkspaceFileDeleteRequest
  | WorkspaceFileRenameRequest
  | WorkspaceFileReadRequest
  | WorkspaceFileWriteRequest
  | WorkspaceGitBadgesReadRequest
  | LspDiagnosticsReadRequest
  | LspStatusReadRequest
  | LspDocumentOpenRequest
  | LspDocumentChangeRequest
  | LspDocumentCloseRequest;

export type EditorBridgeResult =
  | WorkspaceFileTreeReadResult
  | WorkspaceFileCreateResult
  | WorkspaceFileDeleteResult
  | WorkspaceFileRenameResult
  | WorkspaceFileReadResult
  | WorkspaceFileWriteResult
  | WorkspaceGitBadgesReadResult
  | LspDiagnosticsReadResult
  | LspStatusReadResult
  | LspDocumentOpenResult
  | LspDocumentChangeResult
  | LspDocumentCloseResult;

export type EditorBridgeEvent =
  | WorkspaceFileWatchEvent
  | WorkspaceGitBadgesChangedEvent
  | LspDiagnosticsEvent
  | LspStatusEvent;

export type EditorBridgeResultFor<TRequest extends EditorBridgeRequest> =
  TRequest extends WorkspaceFileTreeReadRequest
    ? WorkspaceFileTreeReadResult
    : TRequest extends WorkspaceFileCreateRequest
      ? WorkspaceFileCreateResult
      : TRequest extends WorkspaceFileDeleteRequest
        ? WorkspaceFileDeleteResult
        : TRequest extends WorkspaceFileRenameRequest
          ? WorkspaceFileRenameResult
          : TRequest extends WorkspaceFileReadRequest
            ? WorkspaceFileReadResult
            : TRequest extends WorkspaceFileWriteRequest
              ? WorkspaceFileWriteResult
              : TRequest extends WorkspaceGitBadgesReadRequest
                ? WorkspaceGitBadgesReadResult
                : TRequest extends LspDiagnosticsReadRequest
                  ? LspDiagnosticsReadResult
                  : TRequest extends LspStatusReadRequest
                    ? LspStatusReadResult
                    : TRequest extends LspDocumentOpenRequest
                      ? LspDocumentOpenResult
                      : TRequest extends LspDocumentChangeRequest
                        ? LspDocumentChangeResult
                        : TRequest extends LspDocumentCloseRequest
                          ? LspDocumentCloseResult
                          : never;
