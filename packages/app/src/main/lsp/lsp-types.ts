import type { EditorBridgeEvent } from "../../../../shared/src/contracts/editor/editor-bridge";
import type {
  LspSidecarClient,
  LspWorkspaceRegistryStore,
} from "./lsp-server-supervisor";

export type {
  EditorBridgeEvent,
  LspCodeActionRequest,
  LspCodeActionResult,
  LspCompletionRequest,
  LspCompletionResult,
  LspDefinitionRequest,
  LspDefinitionResult,
  LspDiagnosticsReadRequest,
  LspDiagnosticsReadResult,
  LspDocumentChangeRequest,
  LspDocumentChangeResult,
  LspDocumentCloseRequest,
  LspDocumentCloseResult,
  LspDocumentFormattingRequest,
  LspDocumentFormattingResult,
  LspDocumentOpenRequest,
  LspDocumentOpenResult,
  LspDocumentSymbolsRequest,
  LspDocumentSymbolsResult,
  LspHoverRequest,
  LspHoverResult,
  LspPrepareRenameRequest,
  LspPrepareRenameResult,
  LspRangeFormattingRequest,
  LspRangeFormattingResult,
  LspReferencesRequest,
  LspReferencesResult,
  LspRenameRequest,
  LspRenameResult,
  LspSignatureHelpRequest,
  LspSignatureHelpResult,
  LspStatusReadRequest,
  LspStatusReadResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
export type {
  LspProcessInput,
  LspSidecarClient,
  LspWorkspaceRegistryStore,
} from "./lsp-server-supervisor";

export interface LspDisposable {
  dispose(): void;
}

export interface LspFileSystem {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
}

export type LspServiceEventListener = (event: EditorBridgeEvent) => void;

export interface LspServiceOptions {
  workspacePersistenceStore: LspWorkspaceRegistryStore;
  sidecarClient?: LspSidecarClient;
  now?: () => Date;
  fs?: Partial<LspFileSystem>;
  initializeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
