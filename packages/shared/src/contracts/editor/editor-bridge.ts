export type * from "../workspace/workspace-files";
export type * from "../workspace/workspace-git-badges";
export type * from "../lsp/lsp-diagnostics";
export type * from "../lsp/lsp-completion";
export type * from "../lsp/lsp-read";
export type * from "../lsp/lsp-edit";

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
  LspCompletionRequest,
  LspCompletionResult,
} from "../lsp/lsp-completion";
import type {
  LspDefinitionRequest,
  LspDefinitionResult,
  LspDocumentSymbolsRequest,
  LspDocumentSymbolsResult,
  LspHoverRequest,
  LspHoverResult,
  LspReferencesRequest,
  LspReferencesResult,
} from "../lsp/lsp-read";
import type {
  LspCodeActionRequest,
  LspCodeActionResult,
  LspDocumentFormattingRequest,
  LspDocumentFormattingResult,
  LspPrepareRenameRequest,
  LspPrepareRenameResult,
  LspRangeFormattingRequest,
  LspRangeFormattingResult,
  LspRenameRequest,
  LspRenameResult,
  LspSignatureHelpRequest,
  LspSignatureHelpResult,
} from "../lsp/lsp-edit";
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
  | LspCompletionRequest
  | LspHoverRequest
  | LspDefinitionRequest
  | LspReferencesRequest
  | LspDocumentSymbolsRequest
  | LspPrepareRenameRequest
  | LspRenameRequest
  | LspDocumentFormattingRequest
  | LspRangeFormattingRequest
  | LspSignatureHelpRequest
  | LspCodeActionRequest
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
  | LspCompletionResult
  | LspHoverResult
  | LspDefinitionResult
  | LspReferencesResult
  | LspDocumentSymbolsResult
  | LspPrepareRenameResult
  | LspRenameResult
  | LspDocumentFormattingResult
  | LspRangeFormattingResult
  | LspSignatureHelpResult
  | LspCodeActionResult
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
                    : TRequest extends LspCompletionRequest
                      ? LspCompletionResult
                      : TRequest extends LspHoverRequest
                        ? LspHoverResult
                        : TRequest extends LspDefinitionRequest
                          ? LspDefinitionResult
                          : TRequest extends LspReferencesRequest
                            ? LspReferencesResult
                            : TRequest extends LspDocumentSymbolsRequest
                              ? LspDocumentSymbolsResult
                              : TRequest extends LspPrepareRenameRequest
                                ? LspPrepareRenameResult
                                : TRequest extends LspRenameRequest
                                  ? LspRenameResult
                                  : TRequest extends LspDocumentFormattingRequest
                                    ? LspDocumentFormattingResult
                                    : TRequest extends LspRangeFormattingRequest
                                      ? LspRangeFormattingResult
                                      : TRequest extends LspSignatureHelpRequest
                                        ? LspSignatureHelpResult
                                        : TRequest extends LspCodeActionRequest
                                          ? LspCodeActionResult
                                          : TRequest extends LspDocumentOpenRequest
                                            ? LspDocumentOpenResult
                                            : TRequest extends LspDocumentChangeRequest
                                              ? LspDocumentChangeResult
                                              : TRequest extends LspDocumentCloseRequest
                                                ? LspDocumentCloseResult
                                                : never;
