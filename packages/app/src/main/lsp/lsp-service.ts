import { readFile as readFileDefault } from "node:fs/promises";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  resolveWorkspaceFilePath,
  type ResolvedWorkspaceFilePath,
} from "../workspace/files/workspace-files-paths";
import { normalizeWorkspaceAbsolutePath } from "../workspace/persistence/workspace-persistence";
import { LspDiagnosticsCapability } from "./capabilities/diagnostics";
import { LspServerSupervisor } from "./lsp-server-supervisor";
import type * as Lsp from "./lsp-types";

export type {
  LspDisposable,
  LspFileSystem,
  LspProcessInput,
  LspServiceOptions,
  LspSidecarClient,
  LspWorkspaceRegistryStore,
} from "./lsp-types";
export { JsonRpcMessageParser } from "./lsp-protocol-client";

export class LspService {
  private readonly workspacePersistenceStore: Lsp.LspWorkspaceRegistryStore;
  private readonly supervisor: LspServerSupervisor;
  private readonly diagnostics: LspDiagnosticsCapability;
  private readonly now: () => Date;
  private readonly fs: Lsp.LspFileSystem;
  private readonly eventListeners = new Set<Lsp.LspServiceEventListener>();
  private disposed = false;

  public constructor(options: Lsp.LspServiceOptions) {
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

  public onEvent(listener: Lsp.LspServiceEventListener): Lsp.LspDisposable {
    this.eventListeners.add(listener);
    return {
      dispose: () => {
        this.eventListeners.delete(listener);
      },
    };
  }

  public readStatus(request: Lsp.LspStatusReadRequest) {
    return this.supervisor.readStatus(request);
  }

  public readDiagnostics(request: Lsp.LspDiagnosticsReadRequest) {
    return this.diagnostics.readDiagnostics(request);
  }

  public openDocument(request: Lsp.LspDocumentOpenRequest) {
    return this.supervisor.openDocument(request);
  }

  public changeDocument(request: Lsp.LspDocumentChangeRequest) {
    return this.supervisor.changeDocument(request);
  }

  public closeDocument(request: Lsp.LspDocumentCloseRequest) {
    return this.supervisor.closeDocument(request);
  }

  public complete(request: Lsp.LspCompletionRequest) {
    return this.supervisor.complete(request);
  }

  public hover(request: Lsp.LspHoverRequest) {
    return this.supervisor.hover(request);
  }

  public definition(request: Lsp.LspDefinitionRequest) {
    return this.supervisor.definition(request);
  }

  public references(request: Lsp.LspReferencesRequest) {
    return this.supervisor.references(request);
  }

  public documentSymbols(request: Lsp.LspDocumentSymbolsRequest) {
    return this.supervisor.documentSymbols(request);
  }

  public prepareRename(request: Lsp.LspPrepareRenameRequest) {
    return this.supervisor.prepareRename(request);
  }

  public renameSymbol(request: Lsp.LspRenameRequest) {
    return this.supervisor.renameSymbol(request);
  }

  public formatDocument(request: Lsp.LspDocumentFormattingRequest) {
    return this.supervisor.formatDocument(request);
  }

  public formatRange(request: Lsp.LspRangeFormattingRequest) {
    return this.supervisor.formatRange(request);
  }

  public getSignatureHelp(request: Lsp.LspSignatureHelpRequest) {
    return this.supervisor.getSignatureHelp(request);
  }

  public codeActions(request: Lsp.LspCodeActionRequest) {
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

  private emitEvent(event: Lsp.EditorBridgeEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("LSP service: event listener failed.", error);
      }
    }
  }
}
