import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

import type {
  EditorBridgeEvent,
  LspCompletionRequest,
  LspCompletionResult,
  LspCodeActionRequest,
  LspCodeActionResult,
  LspDefinitionRequest,
  LspDefinitionResult,
  LspDocumentChangeRequest,
  LspDocumentChangeResult,
  LspDocumentCloseRequest,
  LspDocumentFormattingRequest,
  LspDocumentFormattingResult,
  LspDocumentCloseResult,
  LspDocumentOpenRequest,
  LspDocumentOpenResult,
  LspDocumentSymbolsRequest,
  LspDocumentSymbolsResult,
  LspHoverRequest,
  LspHoverResult,
  LspLanguage,
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
  LspStatus,
  LspStatusReadRequest,
  LspStatusReadResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type {
  LspClientPayloadMessage,
  LspHealthCheckCommand,
  LspRestartServerCommand,
  LspServerHealthReply,
  LspServerPayloadMessage,
  LspServerStartedReply,
  LspServerStartFailedReply,
  LspServerStoppedEvent,
  LspServerStopReason,
  LspStartServerCommand,
  LspStopAllServersCommand,
  LspStopAllServersReply,
  LspStopServerCommand,
} from "../../../../shared/src/contracts/lsp/lsp-sidecar";
import type {
  WorkspaceId,
  WorkspaceRegistry,
} from "../../../../shared/src/contracts/workspace/workspace";
import { resolveWorkspaceFilePath } from "../workspace/files/workspace-files-paths";
import { normalizeWorkspaceAbsolutePath } from "../workspace/persistence/workspace-persistence";
import { LspCodeActionCapability } from "./capabilities/code-action";
import { LspCompletionCapability } from "./capabilities/completion";
import { LspDefinitionCapability } from "./capabilities/definition";
import type { PublishDiagnosticsParams } from "./capabilities/diagnostics";
import { LspDocumentSymbolsCapability } from "./capabilities/document-symbols";
import { LspFormattingCapability } from "./capabilities/formatting";
import { LspHoverCapability } from "./capabilities/hover";
import { LspReferencesCapability } from "./capabilities/references";
import { LspRenameCapability } from "./capabilities/rename";
import { LspSignatureHelpCapability } from "./capabilities/signature-help";
import { languageIdFor, normalizeRequestedLanguages } from "./lsp-languages";
import {
  LspProtocolClient,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./lsp-protocol-client";

export interface LspWorkspaceRegistryStore {
  getWorkspaceRegistry(): Promise<WorkspaceRegistry>;
}

export interface LspDisposable {
  dispose(): void;
}

export interface LspSidecarClient {
  startServer(
    command: LspStartServerCommand,
  ): Promise<LspServerStartedReply | LspServerStartFailedReply>;
  stopServer(command: LspStopServerCommand): Promise<LspServerStoppedEvent>;
  restartServer?(
    command: LspRestartServerCommand,
  ): Promise<LspServerStartedReply | LspServerStartFailedReply>;
  healthCheck?(command: LspHealthCheckCommand): Promise<LspServerHealthReply>;
  stopAllServers?(command: LspStopAllServersCommand): Promise<LspStopAllServersReply>;
  stopAllLspServers?(reason?: LspServerStopReason): Promise<void>;
  sendClientPayload(message: LspClientPayloadMessage): void | Promise<void>;
  onServerPayload(listener: (message: LspServerPayloadMessage) => void): LspDisposable;
  onServerStopped(listener: (event: LspServerStoppedEvent) => void): LspDisposable;
}

export interface LspProcessInput {
  write(chunk: string | Buffer): boolean;
  end?(): void;
  destroy?(): void;
}

export interface LspDiagnosticsReceiverPublication {
  workspaceId: WorkspaceId;
  workspaceRoot: string;
  language: LspLanguage;
  params?: PublishDiagnosticsParams;
}

export interface LspServerSupervisorOptions {
  workspacePersistenceStore: LspWorkspaceRegistryStore;
  sidecarClient?: LspSidecarClient;
  now?: () => Date;
  initializeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  emitEvent(event: EditorBridgeEvent): void;
  onPublishDiagnostics(publication: LspDiagnosticsReceiverPublication): void;
  onClearDiagnostics(
    workspaceId: WorkspaceId,
    language: LspLanguage,
    relativePath: string,
  ): void;
}

export interface ServerCommand {
  command: string;
  args: readonly string[];
  serverName: string;
}

interface OpenDocumentRecord {
  path: string;
  uri: string;
  language: LspLanguage;
  version: number;
}

export interface LspSession {
  key: string;
  serverId: string;
  workspaceId: WorkspaceId;
  workspaceRoot: string;
  language: LspLanguage;
  command: ServerCommand;
  process: SidecarLspProcess;
  protocol: LspProtocolClient;
  openDocuments: Map<string, OpenDocumentRecord>;
  state: LspStatus["state"];
  disposed: boolean;
}

interface StartFailure {
  kind: "unavailable" | "error";
  message: string;
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;

const SERVER_COMMANDS: Record<LspLanguage, readonly ServerCommand[]> = {
  typescript: [
    {
      command: "typescript-language-server",
      args: ["--stdio"],
      serverName: "typescript-language-server",
    },
  ],
  python: [
    {
      command: "pyright-langserver",
      args: ["--stdio"],
      serverName: "pyright-langserver",
    },
  ],
  go: [
    {
      command: "gopls",
      args: ["serve"],
      serverName: "gopls",
    },
    {
      command: "gopls",
      args: [],
      serverName: "gopls",
    },
  ],
};

export class LspServerSupervisor {
  private readonly workspacePersistenceStore: LspWorkspaceRegistryStore;
  private readonly sidecarClient: LspSidecarClient;
  private readonly now: () => Date;
  private readonly initializeTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly sessions = new Map<string, LspSession>();
  private readonly startingSessions = new Map<string, Promise<LspSession>>();
  private readonly statuses = new Map<string, LspStatus>();
  private readonly completion: LspCompletionCapability;
  private readonly hoverCapability: LspHoverCapability;
  private readonly definitionCapability: LspDefinitionCapability;
  private readonly referencesCapability: LspReferencesCapability;
  private readonly documentSymbolsCapability: LspDocumentSymbolsCapability;
  private readonly rename: LspRenameCapability;
  private readonly formatting: LspFormattingCapability;
  private readonly signatureHelp: LspSignatureHelpCapability;
  private readonly codeAction: LspCodeActionCapability;
  private requestSeq = 1;
  private relaySeq = 1;
  private disposed = false;

  public constructor(private readonly options: LspServerSupervisorOptions) {
    this.workspacePersistenceStore = options.workspacePersistenceStore;
    this.sidecarClient = options.sidecarClient ?? new UnavailableLspSidecarClient();
    this.now = options.now ?? (() => new Date());
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.completion = new LspCompletionCapability({ now: this.now });
    this.hoverCapability = new LspHoverCapability({ now: this.now });
    this.definitionCapability = new LspDefinitionCapability({ now: this.now });
    this.referencesCapability = new LspReferencesCapability({ now: this.now });
    this.documentSymbolsCapability = new LspDocumentSymbolsCapability({ now: this.now });
    this.rename = new LspRenameCapability({ now: this.now });
    this.formatting = new LspFormattingCapability({ now: this.now });
    this.signatureHelp = new LspSignatureHelpCapability({ now: this.now });
    this.codeAction = new LspCodeActionCapability({ now: this.now });
  }

  public async readStatus(
    request: LspStatusReadRequest,
  ): Promise<LspStatusReadResult> {
    const languages = normalizeRequestedLanguages(request.languages);

    await Promise.all(
      languages.map((language) => {
        const cached = this.statuses.get(statusKey(request.workspaceId, language));
        if (cached && cached.state !== "starting") {
          return Promise.resolve(null);
        }

        return this.ensureSession(request.workspaceId, language).catch(() => null);
      }),
    );

    return {
      type: "lsp-status/read/result",
      workspaceId: request.workspaceId,
      statuses: languages.map((language) =>
        this.readCachedStatus(request.workspaceId, language),
      ),
      readAt: this.timestamp(),
    };
  }

  public async openDocument(
    request: LspDocumentOpenRequest,
  ): Promise<LspDocumentOpenResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");
    const status = await this.withAvailableSession(
      request.workspaceId,
      request.language,
      async (session) => {
        const version = normalizeDocumentVersion(request.version, 1);
        const uri = pathToFileURL(target.absolutePath).href;
        session.openDocuments.set(target.relativePath, {
          path: target.relativePath,
          uri,
          language: request.language,
          version,
        });
        this.sendNotification(session, "textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: languageIdFor(request.language),
            version,
            text: request.content,
          },
        });
      },
    );

    return {
      type: "lsp-document/open/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      language: request.language,
      status,
      openedAt: this.timestamp(),
    };
  }

  public async changeDocument(
    request: LspDocumentChangeRequest,
  ): Promise<LspDocumentChangeResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");
    const status = await this.withAvailableSession(
      request.workspaceId,
      request.language,
      async (session) => {
        const existing = session.openDocuments.get(target.relativePath);
        const version = normalizeDocumentVersion(
          request.version,
          existing ? existing.version + 1 : 1,
        );
        const uri = existing?.uri ?? pathToFileURL(target.absolutePath).href;

        if (!existing) {
          session.openDocuments.set(target.relativePath, {
            path: target.relativePath,
            uri,
            language: request.language,
            version,
          });
          this.sendNotification(session, "textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: languageIdFor(request.language),
              version,
              text: request.content,
            },
          });
          return;
        }

        existing.version = version;
        this.sendNotification(session, "textDocument/didChange", {
          textDocument: {
            uri,
            version,
          },
          contentChanges: [
            {
              text: request.content,
            },
          ],
        });
      },
    );

    return {
      type: "lsp-document/change/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      language: request.language,
      status,
      changedAt: this.timestamp(),
    };
  }

  public async closeDocument(
    request: LspDocumentCloseRequest,
  ): Promise<LspDocumentCloseResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");
    const session = await this.getStartedSession(request.workspaceId, request.language);

    if (session && session.state === "ready" && !session.disposed) {
      const existing = session.openDocuments.get(target.relativePath);
      if (existing) {
        this.sendNotification(session, "textDocument/didClose", {
          textDocument: {
            uri: existing.uri,
          },
        });
        session.openDocuments.delete(target.relativePath);
      }
    }

    this.options.onClearDiagnostics(request.workspaceId, request.language, target.relativePath);

    if (session && session.openDocuments.size === 0) {
      await this.shutdownSession(session, "stopped", "document-close");
    }

    return {
      type: "lsp-document/close/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      language: request.language,
      closedAt: this.timestamp(),
    };
  }

  public async complete(request: LspCompletionRequest): Promise<LspCompletionResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.completion.emptyResult(request, target.relativePath);
      }

      return await this.completion.complete({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/completion", params),
      });
    } catch {
      return this.completion.emptyResult(request, target.relativePath);
    }
  }

  public async hover(request: LspHoverRequest): Promise<LspHoverResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.hoverCapability.emptyResult(request, target.relativePath);
      }

      return await this.hoverCapability.hover({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        sendRequest: (params) => this.sendRequest(session, "textDocument/hover", params),
      });
    } catch {
      return this.hoverCapability.emptyResult(request, target.relativePath);
    }
  }

  public async definition(
    request: LspDefinitionRequest,
  ): Promise<LspDefinitionResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.definitionCapability.emptyResult(request, target.relativePath);
      }

      return await this.definitionCapability.definition({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        workspaceRoot: session.workspaceRoot,
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/definition", params),
      });
    } catch {
      return this.definitionCapability.emptyResult(request, target.relativePath);
    }
  }

  public async references(
    request: LspReferencesRequest,
  ): Promise<LspReferencesResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.referencesCapability.emptyResult(request, target.relativePath);
      }

      return await this.referencesCapability.references({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        workspaceRoot: session.workspaceRoot,
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/references", params),
      });
    } catch {
      return this.referencesCapability.emptyResult(request, target.relativePath);
    }
  }

  public async documentSymbols(
    request: LspDocumentSymbolsRequest,
  ): Promise<LspDocumentSymbolsResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.documentSymbolsCapability.emptyResult(request, target.relativePath);
      }

      return await this.documentSymbolsCapability.documentSymbols({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        workspaceRoot: session.workspaceRoot,
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/documentSymbol", params),
      });
    } catch {
      return this.documentSymbolsCapability.emptyResult(request, target.relativePath);
    }
  }

  public async prepareRename(
    request: LspPrepareRenameRequest,
  ): Promise<LspPrepareRenameResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.rename.prepareRejectedResult(request, target.relativePath);
      }

      return await this.rename.prepareRename({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/prepareRename", params),
      });
    } catch {
      return this.rename.prepareDefaultResult(request, target.relativePath);
    }
  }

  public async renameSymbol(request: LspRenameRequest): Promise<LspRenameResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.rename.emptyRenameResult(request, target.relativePath);
      }

      return await this.rename.rename({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        workspaceRoot: session.workspaceRoot,
        sendRequest: (params) => this.sendRequest(session, "textDocument/rename", params),
      });
    } catch {
      return this.rename.emptyRenameResult(request, target.relativePath);
    }
  }

  public async formatDocument(
    request: LspDocumentFormattingRequest,
  ): Promise<LspDocumentFormattingResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.formatting.emptyDocumentResult(request, target.relativePath);
      }

      return await this.formatting.documentFormatting({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/formatting", params),
      });
    } catch {
      return this.formatting.emptyDocumentResult(request, target.relativePath);
    }
  }

  public async formatRange(
    request: LspRangeFormattingRequest,
  ): Promise<LspRangeFormattingResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.formatting.emptyRangeResult(request, target.relativePath);
      }

      return await this.formatting.rangeFormatting({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/rangeFormatting", params),
      });
    } catch {
      return this.formatting.emptyRangeResult(request, target.relativePath);
    }
  }

  public async getSignatureHelp(
    request: LspSignatureHelpRequest,
  ): Promise<LspSignatureHelpResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.signatureHelp.emptyResult(request, target.relativePath);
      }

      return await this.signatureHelp.signatureHelp({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/signatureHelp", params),
      });
    } catch {
      return this.signatureHelp.emptyResult(request, target.relativePath);
    }
  }

  public async codeActions(request: LspCodeActionRequest): Promise<LspCodeActionResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");

    try {
      const session = await this.ensureSession(request.workspaceId, request.language);
      if (session.state !== "ready") {
        return this.codeAction.emptyResult(request, target.relativePath);
      }

      return await this.codeAction.codeActions({
        request,
        path: target.relativePath,
        uri: uriForRequestTarget(session, target.absolutePath, target.relativePath),
        workspaceRoot: session.workspaceRoot,
        sendRequest: (params) =>
          this.sendRequest(session, "textDocument/codeAction", params),
      });
    } catch {
      return this.codeAction.emptyResult(request, target.relativePath);
    }
  }

  public async closeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const sessions = Array.from(this.sessions.values()).filter(
      (session) => session.workspaceId === workspaceId,
    );
    await Promise.all(
      sessions.map((session) => this.shutdownSession(session, "stopped", "workspace-close")),
    );
    await this.stopAllSidecarServersForWorkspace(workspaceId, "workspace-close");
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const sessions = Array.from(this.sessions.values());
    await Promise.all(
      sessions.map((session) => this.shutdownSession(session, "stopped", "app-shutdown")),
    );
    await this.sidecarClient.stopAllLspServers?.("app-shutdown").catch(() => null);
  }

  public readHealth(workspaceId: WorkspaceId, language: LspLanguage): LspStatus {
    return this.readCachedStatus(workspaceId, language);
  }

  public async restartSessionPlaceholder(
    workspaceId: WorkspaceId,
    language: LspLanguage,
  ): Promise<LspStatus> {
    const session = await this.getStartedSession(workspaceId, language);
    if (!session) {
      return this.readCachedStatus(workspaceId, language);
    }

    const reply = await this.sidecarClient.restartServer?.({
      type: "lsp/lifecycle",
      action: "restart_server",
      requestId: this.nextRequestId("restart", workspaceId, language),
      workspaceId,
      serverId: session.serverId,
      language,
      command: session.command.command,
      args: [...session.command.args],
      cwd: session.workspaceRoot,
      serverName: session.command.serverName,
    });
    if (reply?.action === "server_start_failed") {
      this.setStatus(workspaceId, language, reply.state, {
        serverName: session.command.serverName,
        message: reply.message,
      });
    }
    return this.readCachedStatus(workspaceId, language);
  }

  private async withAvailableSession(
    workspaceId: WorkspaceId,
    language: LspLanguage,
    run: (session: LspSession) => void | Promise<void>,
  ): Promise<LspStatus> {
    try {
      const session = await this.ensureSession(workspaceId, language);
      if (session.state !== "ready") {
        return this.readCachedStatus(workspaceId, language);
      }

      await run(session);
      return this.readCachedStatus(workspaceId, language);
    } catch {
      return this.readCachedStatus(workspaceId, language);
    }
  }

  private async getStartedSession(
    workspaceId: WorkspaceId,
    language: LspLanguage,
  ): Promise<LspSession | null> {
    const key = sessionKey(workspaceId, language);
    const session = this.sessions.get(key);
    if (session) {
      return session;
    }

    const starting = this.startingSessions.get(key);
    if (!starting) {
      return null;
    }

    try {
      return await starting;
    } catch {
      return this.sessions.get(key) ?? null;
    }
  }

  private async ensureSession(
    workspaceId: WorkspaceId,
    language: LspLanguage,
  ): Promise<LspSession> {
    if (this.disposed) {
      throw new Error("LSP service has been disposed.");
    }

    const key = sessionKey(workspaceId, language);
    const existing = this.sessions.get(key);
    if (existing && (existing.state === "ready" || existing.state === "starting")) {
      return existing;
    }

    const starting = this.startingSessions.get(key);
    if (starting) {
      return starting;
    }

    const nextStarting = this.startSession(workspaceId, language).finally(() => {
      this.startingSessions.delete(key);
    });
    this.startingSessions.set(key, nextStarting);
    return nextStarting;
  }

  private async startSession(
    workspaceId: WorkspaceId,
    language: LspLanguage,
  ): Promise<LspSession> {
    const workspaceRoot = await this.resolveWorkspaceRoot(workspaceId);
    this.setStatus(workspaceId, language, "starting", {
      serverName: SERVER_COMMANDS[language][0]?.serverName ?? null,
      message: `Starting ${language} language server.`,
    });

    const failures: StartFailure[] = [];
    for (const command of SERVER_COMMANDS[language]) {
      let session: LspSession | null = null;
      try {
        session = await this.createSession(workspaceId, workspaceRoot, language, command);
        this.sessions.set(session.key, session);
        await this.initializeSession(session);
        return session;
      } catch (error) {
        if (session) {
          this.sessions.delete(session.key);
          await this.shutdownSession(session, "error", "restart", { emitStatus: false });
        }
        failures.push(normalizeStartFailure(error));
      }
    }

    const unavailable = failures.find((failure) => failure.kind === "unavailable");
    const failure = unavailable ?? failures.at(-1) ?? {
      kind: "error" as const,
      message: `No ${language} language server command is configured.`,
    };
    this.setStatus(workspaceId, language, failure.kind, {
      serverName: SERVER_COMMANDS[language][0]?.serverName ?? null,
      message: failure.message,
    });
    throw new Error(failure.message);
  }

  private async createSession(
    workspaceId: WorkspaceId,
    workspaceRoot: string,
    language: LspLanguage,
    command: ServerCommand,
  ): Promise<LspSession> {
    const serverId = sessionKey(workspaceId, language);
    const reply = await this.sidecarClient.startServer({
      type: "lsp/lifecycle",
      action: "start_server",
      requestId: this.nextRequestId("start", workspaceId, language),
      workspaceId,
      serverId,
      language,
      command: command.command,
      args: [...command.args],
      cwd: workspaceRoot,
      serverName: command.serverName,
    });

    if (reply.action === "server_start_failed") {
      throw {
        kind: reply.state,
        message: reply.message,
      } satisfies StartFailure;
    }

    const process = new SidecarLspProcess({
      workspaceId,
      serverId,
      language,
      serverName: command.serverName,
      pid: reply.pid,
      sidecarClient: this.sidecarClient,
      nextSeq: () => this.relaySeq++,
    });
    let session: LspSession;
    const protocol = new LspProtocolClient({
      serverName: command.serverName,
      onServerMessage: (payload) => this.handleServerMessage(session, payload),
    });
    session = createStartingSession(
      workspaceId,
      workspaceRoot,
      language,
      command,
      serverId,
      process,
      protocol,
    );

    process.addSubscription(
      this.sidecarClient.onServerPayload((message) => {
        if (message.workspaceId !== workspaceId || message.serverId !== serverId) {
          return;
        }
        protocol.messageParser.push(message.payload);
      }),
    );
    process.addSubscription(
      this.sidecarClient.onServerStopped((event) => {
        if (event.workspaceId !== workspaceId || event.serverId !== serverId) {
          return;
        }
        process.emitExit(event.exitCode, event.signal, event.reason);
      }),
    );

    return session;
  }

  private initializeSession(session: LspSession): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject({
          kind: "error",
          message: `${session.command.serverName} did not initialize within ${this.initializeTimeoutMs}ms.`,
        } satisfies StartFailure);
      }, this.initializeTimeoutMs);

      session.process.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject({
          kind: "error",
          message:
            `${session.command.serverName} exited before initialize completed` +
            ` (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        } satisfies StartFailure);
      });

      this.sendRequest(session, "initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(session.workspaceRoot).href,
        rootPath: session.workspaceRoot,
        capabilities: {
          textDocument: {
            synchronization: {
              didSave: false,
              dynamicRegistration: false,
            },
            publishDiagnostics: {
              relatedInformation: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ["markdown", "plaintext"],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: {
              dynamicRegistration: false,
            },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
              symbolKind: {
                valueSet: [
                  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
                  17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
                ],
              },
              tagSupport: {
                valueSet: [1],
              },
            },
            rename: {
              dynamicRegistration: false,
              prepareSupport: true,
            },
            formatting: {
              dynamicRegistration: false,
            },
            rangeFormatting: {
              dynamicRegistration: false,
            },
            signatureHelp: {
              dynamicRegistration: false,
              signatureInformation: {
                documentationFormat: ["markdown", "plaintext"],
                parameterInformation: {
                  labelOffsetSupport: true,
                },
              },
              contextSupport: true,
            },
            codeAction: {
              dynamicRegistration: false,
              isPreferredSupport: true,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    "",
                    "quickfix",
                    "refactor",
                    "refactor.extract",
                    "refactor.inline",
                    "refactor.rewrite",
                    "source",
                    "source.organizeImports",
                    "source.fixAll",
                  ],
                },
              },
              resolveSupport: {
                properties: ["edit"],
              },
            },
            completion: {
              dynamicRegistration: false,
              contextSupport: true,
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: true,
                deprecatedSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                insertReplaceSupport: true,
              },
              completionList: {
                itemDefaults: [
                  "commitCharacters",
                  "editRange",
                  "insertTextFormat",
                  "insertTextMode",
                  "data",
                ],
              },
            },
          },
          workspace: {
            workspaceFolders: false,
            configuration: false,
          },
        },
        initializationOptions: {},
        workspaceFolders: null,
      }).then(
        () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          session.state = "ready";
          this.setStatus(session.workspaceId, session.language, "ready", {
            serverName: session.command.serverName,
            message: `${session.command.serverName} is ready.`,
          });
          this.sendNotification(session, "initialized", {});
          session.process.on("exit", (code, signal, reason) => {
            this.handleProcessExit(session, code, signal, reason);
          });
          resolve();
        },
        (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          reject({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          } satisfies StartFailure);
        },
      );
    });
  }

  private handleServerMessage(
    session: LspSession,
    payload: JsonRpcRequest | JsonRpcNotification,
  ): void {
    if (payload.method === "textDocument/publishDiagnostics") {
      this.options.onPublishDiagnostics({
        workspaceId: session.workspaceId,
        workspaceRoot: session.workspaceRoot,
        language: session.language,
        params: payload.params as PublishDiagnosticsParams | undefined,
      });
    }
  }

  private handleProcessExit(
    session: LspSession,
    code: number | null,
    signal: string | null,
    reason?: LspServerStopReason,
  ): void {
    if (session.disposed || this.disposed) {
      return;
    }

    this.sessions.delete(session.key);
    session.state = "error";
    session.process.dispose();
    const message =
      `${session.command.serverName} exited` +
      ` (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
    this.setStatus(session.workspaceId, session.language, "error", {
      serverName: session.command.serverName,
      message,
    });

    if (shouldAutoRestartAfterExit(reason)) {
      void this.restartAfterUnexpectedExit(session, message);
    }
  }

  private async restartAfterUnexpectedExit(
    session: LspSession,
    exitMessage: string,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.setStatus(session.workspaceId, session.language, "starting", {
      serverName: session.command.serverName,
      message: `Restarting ${session.command.serverName} after unexpected exit. ${exitMessage}`,
    });

    try {
      await this.ensureSession(session.workspaceId, session.language);
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.setStatus(session.workspaceId, session.language, "error", {
        serverName: session.command.serverName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendRequest(
    session: LspSession,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    return session.protocol.sendRequest(session.process, method, params);
  }

  private sendNotification(
    session: LspSession,
    method: string,
    params?: unknown,
  ): void {
    session.protocol.sendNotification(session.process, method, params);
  }

  private async shutdownSession(
    session: LspSession,
    finalState: "stopped" | "error",
    reason: LspServerStopReason,
    options: { emitStatus?: boolean } = {},
  ): Promise<void> {
    if (session.disposed) {
      return;
    }

    session.disposed = true;
    this.sessions.delete(session.key);
    session.openDocuments.clear();

    if (session.state === "ready") {
      await Promise.race([
        this.sendRequest(session, "shutdown", undefined).catch(() => null),
        delay(this.shutdownTimeoutMs),
      ]);
      try {
        this.sendNotification(session, "exit", undefined);
      } catch {
        // Process is already gone.
      }
    }

    await this.destroyProcess(session, reason);
    session.process.dispose();
    if (options.emitStatus !== false) {
      this.setStatus(session.workspaceId, session.language, finalState, {
        serverName: session.command.serverName,
        message: `${session.command.serverName} stopped.`,
      });
    }
  }

  private async destroyProcess(
    session: LspSession,
    reason: LspServerStopReason,
  ): Promise<void> {
    try {
      session.process.stdin.end?.();
    } catch {
      session.process.stdin.destroy?.();
    }

    const stopPromise = this.sidecarClient.stopServer({
      type: "lsp/lifecycle",
      action: "stop_server",
      requestId: this.nextRequestId("stop", session.workspaceId, session.language),
      workspaceId: session.workspaceId,
      serverId: session.serverId,
      language: session.language,
      serverName: session.command.serverName,
      reason,
    });

    await Promise.race([stopPromise.catch(() => null), delay(this.shutdownTimeoutMs + 5_000)]);
    session.process.markKilled();
  }

  private async stopAllSidecarServersForWorkspace(
    workspaceId: WorkspaceId,
    reason: LspServerStopReason,
  ): Promise<void> {
    if (!this.sidecarClient.stopAllServers) {
      return;
    }

    await this.sidecarClient
      .stopAllServers({
        type: "lsp/lifecycle",
        action: "stop_all",
        requestId: this.nextRequestId("stop-all", workspaceId, "all"),
        workspaceId,
        reason,
      })
      .catch(() => null);
  }

  private setStatus(
    workspaceId: WorkspaceId,
    language: LspLanguage,
    state: LspStatus["state"],
    options: {
      serverName?: string | null;
      message?: string | null;
    } = {},
  ): LspStatus {
    const status: LspStatus = {
      language,
      state,
      serverName: options.serverName ?? SERVER_COMMANDS[language][0]?.serverName ?? null,
      message: options.message ?? null,
      updatedAt: this.timestamp(),
    };
    this.statuses.set(statusKey(workspaceId, language), status);
    this.options.emitEvent({
      type: "lsp-status/changed",
      workspaceId,
      status,
    });
    return status;
  }

  private readCachedStatus(workspaceId: WorkspaceId, language: LspLanguage): LspStatus {
    return this.statuses.get(statusKey(workspaceId, language)) ?? {
      language,
      state: "stopped",
      serverName: SERVER_COMMANDS[language][0]?.serverName ?? null,
      message: null,
      updatedAt: this.timestamp(),
    };
  }

  private async resolveRequestPath(
    workspaceId: WorkspaceId,
    requestPath: string,
    fieldName: string,
  ) {
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

  private nextRequestId(action: string, workspaceId: WorkspaceId, language: LspLanguage | "all"): string {
    return `${workspaceId}:${language}:${action}:${this.requestSeq++}`;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

interface SidecarLspProcessOptions {
  workspaceId: WorkspaceId;
  serverId: string;
  language: LspLanguage;
  serverName: string;
  pid: number;
  sidecarClient: LspSidecarClient;
  nextSeq(): number;
}

class SidecarLspProcess extends EventEmitter {
  public readonly stdin: LspProcessInput;
  public readonly pid: number;
  public killed = false;
  private readonly subscriptions: LspDisposable[] = [];
  private disposed = false;

  public constructor(private readonly options: SidecarLspProcessOptions) {
    super();
    this.pid = options.pid;
    this.stdin = {
      write: (chunk) => {
        if (this.disposed) {
          return false;
        }

        const payload = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
        this.options.sidecarClient.sendClientPayload({
          type: "lsp/relay",
          direction: "client_to_server",
          workspaceId: this.options.workspaceId,
          serverId: this.options.serverId,
          seq: this.options.nextSeq(),
          payload,
        });
        return true;
      },
      end: () => undefined,
      destroy: () => undefined,
    };
  }

  public addSubscription(subscription: LspDisposable): void {
    this.subscriptions.push(subscription);
  }

  public markKilled(): void {
    this.killed = true;
  }

  public emitExit(
    exitCode: number | null,
    signal: string | null,
    reason?: LspServerStopReason,
  ): void {
    this.emit("exit", exitCode, signal, reason);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.removeAllListeners();
  }
}

class UnavailableLspSidecarClient implements LspSidecarClient {
  public async startServer(
    command: LspStartServerCommand,
  ): Promise<LspServerStartFailedReply> {
    return {
      type: "lsp/lifecycle",
      action: "server_start_failed",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      language: command.language,
      serverName: command.serverName,
      state: "unavailable",
      message: "LSP sidecar supervisor is unavailable.",
    };
  }

  public async stopServer(command: LspStopServerCommand): Promise<LspServerStoppedEvent> {
    return {
      type: "lsp/lifecycle",
      action: "server_stopped",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      language: command.language,
      serverName: command.serverName,
      reason: command.reason,
      exitCode: null,
      signal: null,
      stoppedAt: new Date().toISOString(),
      message: "LSP sidecar supervisor is unavailable.",
    };
  }

  public sendClientPayload(): void {
    throw new Error("LSP sidecar supervisor is unavailable.");
  }

  public onServerPayload(): LspDisposable {
    return { dispose: () => undefined };
  }

  public onServerStopped(): LspDisposable {
    return { dispose: () => undefined };
  }
}

function createStartingSession(
  workspaceId: WorkspaceId,
  workspaceRoot: string,
  language: LspLanguage,
  command: ServerCommand,
  serverId: string,
  process: SidecarLspProcess,
  protocol: LspProtocolClient,
): LspSession {
  return {
    key: sessionKey(workspaceId, language),
    serverId,
    workspaceId,
    workspaceRoot,
    language,
    command,
    process,
    protocol,
    openDocuments: new Map(),
    state: "starting",
    disposed: false,
  };
}

function normalizeDocumentVersion(
  version: number | null | undefined,
  fallback: number,
): number {
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : fallback;
}

function uriForRequestTarget(
  session: LspSession,
  absolutePath: string,
  relativePath: string,
): string {
  return session.openDocuments.get(relativePath)?.uri ?? pathToFileURL(absolutePath).href;
}

function sessionKey(workspaceId: WorkspaceId, language: LspLanguage): string {
  return `${workspaceId}:${language}`;
}

function statusKey(workspaceId: WorkspaceId, language: LspLanguage): string {
  return `${workspaceId}:${language}`;
}

function normalizeStartFailure(error: unknown): StartFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "unavailable" || error.kind === "error") &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return {
      kind: error.kind,
      message: error.message,
    };
  }

  return {
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function shouldAutoRestartAfterExit(reason: LspServerStopReason | undefined): boolean {
  return reason === undefined || reason === "restart";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
