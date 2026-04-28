import { readFile as readFileDefault } from "node:fs/promises";

import type {
  EditorBridgeEvent,
  LspCompletionRequest,
  LspCompletionResult,
  LspCodeActionRequest,
  LspCodeActionResult,
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
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  resolveWorkspaceFilePath,
  type ResolvedWorkspaceFilePath,
} from "../workspace/files/workspace-files-paths";
import { normalizeWorkspaceAbsolutePath } from "../workspace/persistence/workspace-persistence";
import { LspDiagnosticsCapability } from "./capabilities/diagnostics";
import {
  LspServerSupervisor,
  type LspSidecarClient,
  type LspWorkspaceRegistryStore,
} from "./lsp-server-supervisor";

export type {
  LspProcessInput,
  LspSidecarClient,
  LspWorkspaceRegistryStore,
} from "./lsp-server-supervisor";
export { JsonRpcMessageParser } from "./lsp-protocol-client";

export interface LspDisposable {
  dispose(): void;
}

export interface LspFileSystem {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
}

export interface LspServiceOptions {
  workspacePersistenceStore: LspWorkspaceRegistryStore;
  sidecarClient?: LspSidecarClient;
  now?: () => Date;
  fs?: Partial<LspFileSystem>;
  initializeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export class LspService {
  private readonly workspacePersistenceStore: LspWorkspaceRegistryStore;
  private readonly supervisor: LspServerSupervisor;
  private readonly diagnostics: LspDiagnosticsCapability;
  private readonly now: () => Date;
  private readonly fs: LspFileSystem;
  private readonly eventListeners = new Set<(event: EditorBridgeEvent) => void>();
  private disposed = false;

  public constructor(options: LspServiceOptions) {
    this.workspacePersistenceStore = options.workspacePersistenceStore;
    this.now = options.now ?? (() => new Date());
    this.fs = {
      readFile: options.fs?.readFile ?? readFileDefault,
    };
    this.diagnostics = new LspDiagnosticsCapability({
      now: this.now,
      emitEvent: (event) => this.emitEvent(event),
      resolveRequestPath: (workspaceId, requestPath, fieldName) =>
        this.resolveRequestPath(workspaceId, requestPath, fieldName),
    });
    this.supervisor = new LspServerSupervisor({
      workspacePersistenceStore: this.workspacePersistenceStore,
      sidecarClient: options.sidecarClient,
      now: this.now,
      initializeTimeoutMs: options.initializeTimeoutMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      emitEvent: (event) => this.emitEvent(event),
      onPublishDiagnostics: (publication) =>
        this.diagnostics.handlePublishDiagnostics(publication),
      onClearDiagnostics: (workspaceId, language, relativePath) =>
        this.diagnostics.clearDiagnostics(workspaceId, language, relativePath),
    });
  }

  public onEvent(listener: (event: EditorBridgeEvent) => void): LspDisposable {
    this.eventListeners.add(listener);
    return {
      dispose: () => {
        this.eventListeners.delete(listener);
      },
    };
  }

  public readStatus(request: LspStatusReadRequest): Promise<LspStatusReadResult> {
    return this.supervisor.readStatus(request);
  }

  public readDiagnostics(
    request: LspDiagnosticsReadRequest,
  ): Promise<LspDiagnosticsReadResult> {
    return this.diagnostics.readDiagnostics(request);
  }

  public openDocument(
    request: LspDocumentOpenRequest,
  ): Promise<LspDocumentOpenResult> {
    return this.supervisor.openDocument(request);
  }

  public changeDocument(
    request: LspDocumentChangeRequest,
  ): Promise<LspDocumentChangeResult> {
    return this.supervisor.changeDocument(request);
  }

  public closeDocument(
    request: LspDocumentCloseRequest,
  ): Promise<LspDocumentCloseResult> {
    return this.supervisor.closeDocument(request);
  }

  public complete(request: LspCompletionRequest): Promise<LspCompletionResult> {
    return this.supervisor.complete(request);
  }

  public hover(request: LspHoverRequest): Promise<LspHoverResult> {
    return this.supervisor.hover(request);
  }

  public definition(request: LspDefinitionRequest): Promise<LspDefinitionResult> {
    return this.supervisor.definition(request);
  }

  public references(request: LspReferencesRequest): Promise<LspReferencesResult> {
    return this.supervisor.references(request);
  }

  public documentSymbols(
    request: LspDocumentSymbolsRequest,
  ): Promise<LspDocumentSymbolsResult> {
    return this.supervisor.documentSymbols(request);
  }

  public prepareRename(
    request: LspPrepareRenameRequest,
  ): Promise<LspPrepareRenameResult> {
    return this.supervisor.prepareRename(request);
  }

  public renameSymbol(request: LspRenameRequest): Promise<LspRenameResult> {
    return this.supervisor.renameSymbol(request);
  }

  public formatDocument(
    request: LspDocumentFormattingRequest,
  ): Promise<LspDocumentFormattingResult> {
    return this.supervisor.formatDocument(request);
  }

  public formatRange(
    request: LspRangeFormattingRequest,
  ): Promise<LspRangeFormattingResult> {
    return this.supervisor.formatRange(request);
  }

  public getSignatureHelp(
    request: LspSignatureHelpRequest,
  ): Promise<LspSignatureHelpResult> {
    return this.supervisor.getSignatureHelp(request);
  }

  public codeActions(request: LspCodeActionRequest): Promise<LspCodeActionResult> {
    return this.supervisor.codeActions(request);
  }

  public async closeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.supervisor.closeWorkspace(workspaceId);
    this.diagnostics.clearWorkspace(workspaceId);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await this.supervisor.dispose();
    this.eventListeners.clear();
    this.diagnostics.dispose();
  }

  public async readDocumentFromDisk(
    workspaceId: WorkspaceId,
    requestPath: string,
  ): Promise<string> {
    const target = await this.resolveRequestPath(workspaceId, requestPath, "path");
    return this.fs.readFile(target.absolutePath, "utf8");
  }

  private async resolveRequestPath(
    workspaceId: WorkspaceId,
    requestPath: string,
    fieldName: string,
  ): Promise<ResolvedWorkspaceFilePath> {
    const workspaceRoot = await this.resolveWorkspaceRoot(workspaceId);
    return resolveWorkspaceFilePath(workspaceRoot, requestPath, { fieldName });
  }

  private async resolveWorkspaceRoot(workspaceId: WorkspaceId): Promise<string> {
    const registry = await this.workspacePersistenceStore.getWorkspaceRegistry();
    const workspace = registry.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      throw new Error(`Workspace "${workspaceId}" is not registered.`);
    }

    return normalizeWorkspaceAbsolutePath(workspace.absolutePath);
  }

  private emitEvent(event: EditorBridgeEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("LSP service: event listener failed.", error);
      }
    }
  }
}
