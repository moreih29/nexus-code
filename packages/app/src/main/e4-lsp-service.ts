import { spawn as spawnDefault, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile as readFileDefault } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  E4Diagnostic,
  E4DiagnosticSeverity,
  E4EditorEvent,
  E4LspDiagnosticsEvent,
  E4LspDiagnosticsReadRequest,
  E4LspDiagnosticsReadResult,
  E4LspDocumentChangeRequest,
  E4LspDocumentChangeResult,
  E4LspDocumentCloseRequest,
  E4LspDocumentCloseResult,
  E4LspDocumentOpenRequest,
  E4LspDocumentOpenResult,
  E4LspLanguage,
  E4LspStatus,
  E4LspStatusReadRequest,
  E4LspStatusReadResult,
} from "../../../shared/src/contracts/e4-editor";
import type {
  WorkspaceId,
  WorkspaceRegistry,
} from "../../../shared/src/contracts/workspace";
import {
  resolveE4WorkspacePath,
  toWorkspaceRelativePath,
  type E4ResolvedWorkspacePath,
} from "./e4-editor-paths";
import { normalizeWorkspaceAbsolutePath } from "./workspace-persistence";

export interface E4LspWorkspaceRegistryStore {
  getWorkspaceRegistry(): Promise<WorkspaceRegistry>;
}

export interface E4LspDisposable {
  dispose(): void;
}

export interface E4LspProcessStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
}

export interface E4LspProcessInput {
  write(chunk: string | Buffer): boolean;
  end?(): void;
  destroy?(): void;
}

export interface E4LspChildProcess extends EventEmitter {
  stdout: E4LspProcessStream | null;
  stderr: E4LspProcessStream | null;
  stdin: E4LspProcessInput | null;
  pid?: number;
  killed?: boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

export type E4LspSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => E4LspChildProcess;

export interface E4LspFileSystem {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
}

export interface E4LspServiceOptions {
  workspacePersistenceStore: E4LspWorkspaceRegistryStore;
  spawnProcess?: E4LspSpawnProcess;
  now?: () => Date;
  fs?: Partial<E4LspFileSystem>;
  initializeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

type JsonRpcId = number | string;
type JsonRpcPayload = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface LspDiagnostic {
  range?: {
    start?: {
      line?: number;
      character?: number;
    };
    end?: {
      line?: number;
      character?: number;
    };
  };
  severity?: number;
  message?: string;
  source?: string | null;
  code?: string | number | null;
}

interface PublishDiagnosticsParams {
  uri?: string;
  diagnostics?: LspDiagnostic[];
  version?: number | string | null;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ServerCommand {
  command: string;
  args: readonly string[];
  serverName: string;
}

interface OpenDocumentRecord {
  path: string;
  uri: string;
  language: E4LspLanguage;
  version: number;
}

interface LspSession {
  key: string;
  workspaceId: WorkspaceId;
  workspaceRoot: string;
  language: E4LspLanguage;
  command: ServerCommand;
  process: E4LspChildProcess;
  parser: JsonRpcMessageParser;
  pendingRequests: Map<JsonRpcId, PendingRequest>;
  openDocuments: Map<string, OpenDocumentRecord>;
  nextRequestId: number;
  state: E4LspStatus["state"];
  disposed: boolean;
  startingPromise: Promise<LspSession> | null;
}

interface StartFailure {
  kind: "unavailable" | "error";
  message: string;
}

const LSP_LANGUAGES: readonly E4LspLanguage[] = ["typescript", "python", "go"];
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;

const SERVER_COMMANDS: Record<E4LspLanguage, readonly ServerCommand[]> = {
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

export class E4LspService {
  private readonly workspacePersistenceStore: E4LspWorkspaceRegistryStore;
  private readonly spawnProcess: E4LspSpawnProcess;
  private readonly now: () => Date;
  private readonly fs: E4LspFileSystem;
  private readonly initializeTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly eventListeners = new Set<(event: E4EditorEvent) => void>();
  private readonly sessions = new Map<string, LspSession>();
  private readonly statuses = new Map<string, E4LspStatus>();
  private readonly diagnostics = new Map<string, E4Diagnostic[]>();
  private disposed = false;

  public constructor(options: E4LspServiceOptions) {
    this.workspacePersistenceStore = options.workspacePersistenceStore;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.now = options.now ?? (() => new Date());
    this.fs = {
      readFile: options.fs?.readFile ?? readFileDefault,
    };
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  public onEvent(listener: (event: E4EditorEvent) => void): E4LspDisposable {
    this.eventListeners.add(listener);
    return {
      dispose: () => {
        this.eventListeners.delete(listener);
      },
    };
  }

  public async readStatus(
    request: E4LspStatusReadRequest,
  ): Promise<E4LspStatusReadResult> {
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
      type: "e4/lsp-status/read/result",
      workspaceId: request.workspaceId,
      statuses: languages.map((language) =>
        this.readCachedStatus(request.workspaceId, language),
      ),
      readAt: this.timestamp(),
    };
  }

  public async readDiagnostics(
    request: E4LspDiagnosticsReadRequest,
  ): Promise<E4LspDiagnosticsReadResult> {
    const pathFilter = request.path
      ? await this.resolveRequestPath(request.workspaceId, request.path, "path")
      : null;
    const languages = normalizeRequestedLanguages(
      request.language ? [request.language] : null,
    );

    const diagnostics: E4Diagnostic[] = [];
    for (const language of languages) {
      if (pathFilter) {
        diagnostics.push(
          ...(
            this.diagnostics.get(
              diagnosticsKey(request.workspaceId, language, pathFilter.relativePath),
            ) ?? []
          ),
        );
        continue;
      }

      const prefix = `${request.workspaceId}:${language}:`;
      for (const [key, pathDiagnostics] of this.diagnostics.entries()) {
        if (key.startsWith(prefix)) {
          diagnostics.push(...pathDiagnostics);
        }
      }
    }

    return {
      type: "e4/lsp-diagnostics/read/result",
      workspaceId: request.workspaceId,
      diagnostics,
      readAt: this.timestamp(),
    };
  }

  public async openDocument(
    request: E4LspDocumentOpenRequest,
  ): Promise<E4LspDocumentOpenResult> {
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
      type: "e4/lsp-document/open/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      language: request.language,
      status,
      openedAt: this.timestamp(),
    };
  }

  public async changeDocument(
    request: E4LspDocumentChangeRequest,
  ): Promise<E4LspDocumentChangeResult> {
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
      type: "e4/lsp-document/change/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      language: request.language,
      status,
      changedAt: this.timestamp(),
    };
  }

  public async closeDocument(
    request: E4LspDocumentCloseRequest,
  ): Promise<E4LspDocumentCloseResult> {
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

    this.clearDiagnostics(request.workspaceId, request.language, target.relativePath);

    if (session && session.openDocuments.size === 0) {
      await this.shutdownSession(session, "stopped");
    }

    return {
      type: "e4/lsp-document/close/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      language: request.language,
      closedAt: this.timestamp(),
    };
  }

  public async closeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const sessions = Array.from(this.sessions.values()).filter(
      (session) => session.workspaceId === workspaceId,
    );
    await Promise.all(sessions.map((session) => this.shutdownSession(session, "stopped")));

    for (const key of Array.from(this.diagnostics.keys())) {
      if (key.startsWith(`${workspaceId}:`)) {
        this.diagnostics.delete(key);
      }
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const sessions = Array.from(this.sessions.values());
    await Promise.all(sessions.map((session) => this.shutdownSession(session, "stopped")));
    this.eventListeners.clear();
    this.diagnostics.clear();
  }

  public async readDocumentFromDisk(
    workspaceId: WorkspaceId,
    requestPath: string,
  ): Promise<string> {
    const target = await this.resolveRequestPath(workspaceId, requestPath, "path");
    return this.fs.readFile(target.absolutePath, "utf8");
  }

  private async withAvailableSession(
    workspaceId: WorkspaceId,
    language: E4LspLanguage,
    run: (session: LspSession) => void | Promise<void>,
  ): Promise<E4LspStatus> {
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
    language: E4LspLanguage,
  ): Promise<LspSession | null> {
    const session = this.sessions.get(sessionKey(workspaceId, language));
    if (!session?.startingPromise) {
      return session ?? null;
    }

    try {
      return await session.startingPromise;
    } catch {
      return this.sessions.get(sessionKey(workspaceId, language)) ?? null;
    }
  }

  private async ensureSession(
    workspaceId: WorkspaceId,
    language: E4LspLanguage,
  ): Promise<LspSession> {
    if (this.disposed) {
      throw new Error("E4 LSP service has been disposed.");
    }

    const existing = this.sessions.get(sessionKey(workspaceId, language));
    if (existing) {
      if (existing.startingPromise) {
        return existing.startingPromise;
      }
      if (existing.state === "ready" || existing.state === "starting") {
        return existing;
      }
    }

    return this.startSession(workspaceId, language);
  }

  private async startSession(
    workspaceId: WorkspaceId,
    language: E4LspLanguage,
  ): Promise<LspSession> {
    const workspaceRoot = await this.resolveWorkspaceRoot(workspaceId);
    this.setStatus(workspaceId, language, "starting", {
      serverName: SERVER_COMMANDS[language][0]?.serverName ?? null,
      message: `Starting ${language} language server.`,
    });

    const failures: StartFailure[] = [];
    for (const command of SERVER_COMMANDS[language]) {
      const started = this.tryStartCommand(workspaceId, workspaceRoot, language, command);
      this.sessions.set(sessionKey(workspaceId, language), started.session);

      try {
        const session = await started.ready;
        this.sessions.set(sessionKey(workspaceId, language), session);
        return session;
      } catch (error) {
        this.sessions.delete(sessionKey(workspaceId, language));
        failures.push(normalizeStartFailure(error));
        await this.destroyProcess(started.process);
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

  private tryStartCommand(
    workspaceId: WorkspaceId,
    workspaceRoot: string,
    language: E4LspLanguage,
    command: ServerCommand,
  ): {
    session: LspSession;
    process: E4LspChildProcess;
    parser: JsonRpcMessageParser;
    ready: Promise<LspSession>;
  } {
    let child: E4LspChildProcess;
    try {
      child = this.spawnProcess(command.command, command.args, {
        cwd: workspaceRoot,
        stdio: "pipe",
        env: process.env,
      });
    } catch (error) {
      const failure = processStartFailure(command, error);
      const processStub = createFailedProcessStub(error);
      const parser = new JsonRpcMessageParser(() => undefined);
      const session = createStartingSession(
        workspaceId,
        workspaceRoot,
        language,
        command,
        processStub,
        parser,
      );
      session.startingPromise = Promise.reject(failure);
      return {
        session,
        process: processStub,
        parser,
        ready: session.startingPromise,
      };
    }

    const parser = new JsonRpcMessageParser((payload) => {
      this.handleMessage(session, payload);
    });
    const session = createStartingSession(
      workspaceId,
      workspaceRoot,
      language,
      command,
      child,
      parser,
    );

    child.stdout?.on("data", (chunk) => parser.push(chunk));
    child.stderr?.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.setStatus(workspaceId, language, "starting", {
          serverName: command.serverName,
          message,
        });
      }
    });
    child.on("exit", (code, signal) => {
      this.handleProcessExit(session, code as number | null, signal as NodeJS.Signals | null);
    });

    const ready = new Promise<LspSession>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject({
          kind: "error",
          message: `${command.serverName} did not initialize within ${this.initializeTimeoutMs}ms.`,
        } satisfies StartFailure);
      }, this.initializeTimeoutMs);

      child.once("error", (error) => {
        if (settled) {
          this.setStatus(workspaceId, language, "error", {
            serverName: command.serverName,
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(processStartFailure(command, error));
      });

      child.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject({
          kind: "error",
          message:
            `${command.serverName} exited before initialize completed` +
            ` (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        } satisfies StartFailure);
      });

      this.sendRequest(session, "initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(workspaceRoot).href,
        rootPath: workspaceRoot,
        capabilities: {
          textDocument: {
            synchronization: {
              didSave: false,
              dynamicRegistration: false,
            },
            publishDiagnostics: {
              relatedInformation: false,
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
          session.startingPromise = null;
          this.setStatus(workspaceId, language, "ready", {
            serverName: command.serverName,
            message: `${command.serverName} is ready.`,
          });
          this.sendNotification(session, "initialized", {});
          resolve(session);
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

    session.startingPromise = ready;

    return {
      session,
      process: child,
      parser,
      ready,
    };
  }

  private handleMessage(session: LspSession, payload: JsonRpcPayload): void {
    if (isJsonRpcResponse(payload)) {
      const pending = session.pendingRequests.get(payload.id);
      if (!pending) {
        return;
      }
      session.pendingRequests.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message ?? `${pending.method} failed.`));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }

    if (payload.method === "textDocument/publishDiagnostics") {
      this.handlePublishDiagnostics(
        session,
        payload.params as PublishDiagnosticsParams | undefined,
      );
    }
  }

  private handlePublishDiagnostics(
    session: LspSession,
    params: PublishDiagnosticsParams | undefined,
  ): void {
    if (!params?.uri) {
      return;
    }

    const pathMapping = this.mapUriToWorkspacePath(session.workspaceRoot, params.uri);
    if (!pathMapping) {
      return;
    }

    const diagnostics = (params.diagnostics ?? []).map((diagnostic) =>
      mapDiagnostic(diagnostic, pathMapping.relativePath, session.language),
    );
    this.diagnostics.set(
      diagnosticsKey(session.workspaceId, session.language, pathMapping.relativePath),
      diagnostics,
    );

    const event: E4LspDiagnosticsEvent = {
      type: "e4/lsp-diagnostics/changed",
      workspaceId: session.workspaceId,
      path: pathMapping.relativePath,
      language: session.language,
      diagnostics,
      version: params.version === null || params.version === undefined
        ? null
        : String(params.version),
      publishedAt: this.timestamp(),
    };
    this.emitEvent(event);
  }

  private clearDiagnostics(
    workspaceId: WorkspaceId,
    language: E4LspLanguage,
    relativePath: string,
  ): void {
    this.diagnostics.delete(diagnosticsKey(workspaceId, language, relativePath));
    this.emitEvent({
      type: "e4/lsp-diagnostics/changed",
      workspaceId,
      path: relativePath,
      language,
      diagnostics: [],
      version: null,
      publishedAt: this.timestamp(),
    });
  }

  private handleProcessExit(
    session: LspSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (session.disposed) {
      return;
    }

    this.sessions.delete(session.key);
    session.state = "error";
    const message =
      `${session.command.serverName} exited` +
      ` (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
    this.setStatus(session.workspaceId, session.language, "error", {
      serverName: session.command.serverName,
      message,
    });
  }

  private sendRequest(
    session: LspSession,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    const id = session.nextRequestId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      session.pendingRequests.set(id, {
        method,
        resolve,
        reject,
      });
      try {
        writeJsonRpcPayload(session, payload);
      } catch (error) {
        session.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(
    session: LspSession,
    method: string,
    params?: unknown,
  ): void {
    writeJsonRpcPayload(session, {
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private async shutdownSession(
    session: LspSession,
    finalState: "stopped" | "error",
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

    await this.destroyProcess(session.process);
    this.setStatus(session.workspaceId, session.language, finalState, {
      serverName: session.command.serverName,
      message: `${session.command.serverName} stopped.`,
    });
  }

  private async destroyProcess(child: E4LspChildProcess): Promise<void> {
    try {
      child.stdin?.end?.();
    } catch {
      child.stdin?.destroy?.();
    }

    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process has already exited.
      }
    }

    await delay(0);
  }

  private setStatus(
    workspaceId: WorkspaceId,
    language: E4LspLanguage,
    state: E4LspStatus["state"],
    options: {
      serverName?: string | null;
      message?: string | null;
    } = {},
  ): E4LspStatus {
    const status: E4LspStatus = {
      language,
      state,
      serverName: options.serverName ?? SERVER_COMMANDS[language][0]?.serverName ?? null,
      message: options.message ?? null,
      updatedAt: this.timestamp(),
    };
    this.statuses.set(statusKey(workspaceId, language), status);
    this.emitEvent({
      type: "e4/lsp-status/changed",
      workspaceId,
      status,
    });
    return status;
  }

  private readCachedStatus(workspaceId: WorkspaceId, language: E4LspLanguage): E4LspStatus {
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
  ): Promise<E4ResolvedWorkspacePath> {
    const workspaceRoot = await this.resolveWorkspaceRoot(workspaceId);
    return resolveE4WorkspacePath(workspaceRoot, requestPath, { fieldName });
  }

  private async resolveWorkspaceRoot(workspaceId: WorkspaceId): Promise<string> {
    const registry = await this.workspacePersistenceStore.getWorkspaceRegistry();
    const workspace = registry.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      throw new Error(`Workspace "${workspaceId}" is not registered.`);
    }

    return normalizeWorkspaceAbsolutePath(workspace.absolutePath);
  }

  private mapUriToWorkspacePath(
    workspaceRoot: string,
    uri: string,
  ): { absolutePath: string; relativePath: string } | null {
    if (!uri.startsWith("file:")) {
      return null;
    }

    try {
      const absolutePath = fileURLToPath(uri);
      return {
        absolutePath,
        relativePath: toWorkspaceRelativePath(workspaceRoot, absolutePath),
      };
    } catch {
      return null;
    }
  }

  private emitEvent(event: E4EditorEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("E4 LSP service: event listener failed.", error);
      }
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export class JsonRpcMessageParser {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly onMessage: (payload: JsonRpcPayload) => void) {}

  public push(chunk: Buffer | string): void {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.buffer = Buffer.concat([this.buffer, nextChunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(header);
      if (contentLength === null) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) {
        return;
      }

      const body = this.buffer.subarray(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);
      try {
        this.onMessage(JSON.parse(body) as JsonRpcPayload);
      } catch {
        // Ignore malformed server messages; status updates come from process lifecycle.
      }
    }
  }
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): E4LspChildProcess {
  return spawnDefault(command, [...args], options) as E4LspChildProcess;
}

function createStartingSession(
  workspaceId: WorkspaceId,
  workspaceRoot: string,
  language: E4LspLanguage,
  command: ServerCommand,
  child: E4LspChildProcess,
  parser: JsonRpcMessageParser,
): LspSession {
  return {
    key: sessionKey(workspaceId, language),
    workspaceId,
    workspaceRoot,
    language,
    command,
    process: child,
    parser,
    pendingRequests: new Map(),
    openDocuments: new Map(),
    nextRequestId: 1,
    state: "starting",
    disposed: false,
    startingPromise: null,
  };
}

function createFailedProcessStub(error: unknown): E4LspChildProcess {
  const child = new EventEmitter() as E4LspChildProcess;
  child.stdout = null;
  child.stderr = null;
  child.stdin = null;
  child.killed = true;
  child.kill = () => false;
  void error;
  return child;
}

function writeJsonRpcPayload(session: LspSession, payload: JsonRpcPayload): void {
  if (!session.process.stdin) {
    throw new Error(`${session.command.serverName} stdin is unavailable.`);
  }

  const body = JSON.stringify(payload);
  session.process.stdin.write(
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
  );
}

function parseContentLength(header: string): number | null {
  for (const line of header.split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    if (key !== "content-length") {
      continue;
    }
    const value = Number(line.slice(separatorIndex + 1).trim());
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  return null;
}

function isJsonRpcResponse(payload: JsonRpcPayload): payload is JsonRpcResponse {
  return "id" in payload && !("method" in payload);
}

function mapDiagnostic(
  diagnostic: LspDiagnostic,
  relativePath: string,
  language: E4LspLanguage,
): E4Diagnostic {
  return {
    path: relativePath,
    language,
    range: {
      start: {
        line: diagnostic.range?.start?.line ?? 0,
        character: diagnostic.range?.start?.character ?? 0,
      },
      end: {
        line: diagnostic.range?.end?.line ?? diagnostic.range?.start?.line ?? 0,
        character:
          diagnostic.range?.end?.character ?? diagnostic.range?.start?.character ?? 0,
      },
    },
    severity: severityFromLsp(diagnostic.severity),
    message: diagnostic.message ?? "",
    source: diagnostic.source ?? null,
    code: diagnostic.code ?? null,
  };
}

function severityFromLsp(severity: number | undefined): E4DiagnosticSeverity {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "information";
  }
}

function normalizeRequestedLanguages(
  languages: readonly E4LspLanguage[] | null | undefined,
): readonly E4LspLanguage[] {
  if (!languages || languages.length === 0) {
    return LSP_LANGUAGES;
  }

  return LSP_LANGUAGES.filter((language) => languages.includes(language));
}

function normalizeDocumentVersion(
  version: number | null | undefined,
  fallback: number,
): number {
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : fallback;
}

function languageIdFor(language: E4LspLanguage): string {
  return language;
}

function sessionKey(workspaceId: WorkspaceId, language: E4LspLanguage): string {
  return `${workspaceId}:${language}`;
}

function statusKey(workspaceId: WorkspaceId, language: E4LspLanguage): string {
  return `${workspaceId}:${language}`;
}

function diagnosticsKey(
  workspaceId: WorkspaceId,
  language: E4LspLanguage,
  relativePath: string,
): string {
  return `${workspaceId}:${language}:${relativePath}`;
}

function processStartFailure(command: ServerCommand, error: unknown): StartFailure {
  if (isErrnoException(error) && error.code === "ENOENT") {
    return {
      kind: "unavailable",
      message: `${command.command} is not available on PATH.`,
    };
  }

  return {
    kind: "error",
    message: error instanceof Error
      ? error.message
      : `${command.serverName} failed to start.`,
  };
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
