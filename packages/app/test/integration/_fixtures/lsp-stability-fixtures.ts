import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LspLanguage } from "../../../../shared/src/contracts/editor/editor-bridge";
import type {
  LspClientPayloadMessage,
  LspServerPayloadMessage,
  LspServerStartedReply,
  LspServerStartFailedReply,
  LspServerStoppedEvent,
  LspStartServerCommand,
  LspStopAllServersCommand,
  LspStopAllServersReply,
  LspStopServerCommand,
} from "../../../../shared/src/contracts/lsp/lsp-sidecar";
import type { WorkspaceId, WorkspaceRegistry } from "../../../../shared/src/contracts/workspace/workspace";
import type { LspSidecarClient } from "../../../src/main/lsp/lsp-service";

import { stableNow } from "./stability-common";

const tempDirs: string[] = [];

export const languageScenarios: Array<{
  workspaceId: WorkspaceId;
  language: LspLanguage;
  harness: "claude-code" | "codex" | "opencode";
  relativePath: string;
  content: string;
}> = [
  {
    workspaceId: "ws_m6_ts" as WorkspaceId,
    language: "typescript",
    harness: "claude-code",
    relativePath: "src/index.ts",
    content: "export function greet(name: string) { return name; }\n",
  },
  {
    workspaceId: "ws_m6_py" as WorkspaceId,
    language: "python",
    harness: "codex",
    relativePath: "src/main.py",
    content: "def greet(name: str) -> str:\n    return name\n",
  },
  {
    workspaceId: "ws_m6_go" as WorkspaceId,
    language: "go",
    harness: "opencode",
    relativePath: "src/main.go",
    content: "package main\nfunc greet(name string) string { return name }\n",
  },
];

export async function cleanupStabilityTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

export class StabilityLspSidecarClient implements LspSidecarClient {
  public readonly startCommands: LspStartServerCommand[] = [];
  public readonly stopCommands: LspStopServerCommand[] = [];
  public readonly stopAllCommands: LspStopAllServersCommand[] = [];
  public readonly startedServers: StabilityLanguageServerSession[] = [];
  public readonly relayServerSeqs: number[] = [];
  public droppedClientPayloads = 0;
  public malformedPayloads = 0;
  private readonly servers = new Map<string, StabilityLanguageServerSession>();
  private readonly payloadListeners = new Set<(message: LspServerPayloadMessage) => void>();
  private readonly stoppedListeners = new Set<(event: LspServerStoppedEvent) => void>();
  private serverPayloadSeq = 1;

  public async startServer(command: LspStartServerCommand): Promise<LspServerStartedReply | LspServerStartFailedReply> {
    this.startCommands.push(command);
    const session = new StabilityLanguageServerSession(this, command);
    this.servers.set(command.serverId, session);
    this.startedServers.push(session);
    return {
      type: "lsp/lifecycle",
      action: "server_started",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      language: command.language,
      serverName: command.serverName,
      pid: 7000 + this.startedServers.length,
    };
  }

  public async stopServer(command: LspStopServerCommand): Promise<LspServerStoppedEvent> {
    this.stopCommands.push(command);
    this.servers.delete(command.serverId);
    const event: LspServerStoppedEvent = {
      type: "lsp/lifecycle",
      action: "server_stopped",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      language: command.language,
      serverName: command.serverName,
      reason: command.reason,
      exitCode: 0,
      signal: null,
      stoppedAt: stableNow().toISOString(),
    };
    this.emitStopped(event);
    return event;
  }

  public async stopAllServers(command: LspStopAllServersCommand): Promise<LspStopAllServersReply> {
    this.stopAllCommands.push(command);
    const stoppedServerIds = Array.from(this.servers.values())
      .filter((server) => !command.workspaceId || server.command.workspaceId === command.workspaceId)
      .map((server) => server.command.serverId);
    for (const serverId of stoppedServerIds) {
      this.servers.delete(serverId);
    }
    return {
      type: "lsp/lifecycle",
      action: "stop_all_stopped",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      stoppedServerIds,
    };
  }

  public async stopAllLspServers(reason = "app-shutdown" as const): Promise<void> {
    await this.stopAllServers({
      type: "lsp/lifecycle",
      action: "stop_all",
      requestId: `m6-stop-all-${this.stopAllCommands.length + 1}`,
      workspaceId: null,
      reason,
    });
  }

  public sendClientPayload(message: LspClientPayloadMessage): void {
    const server = this.servers.get(message.serverId);
    if (!server) {
      this.droppedClientPayloads += 1;
      return;
    }
    server.receive(message.payload);
  }

  public onServerPayload(listener: (message: LspServerPayloadMessage) => void) {
    this.payloadListeners.add(listener);
    return { dispose: () => this.payloadListeners.delete(listener) };
  }

  public onServerStopped(listener: (event: LspServerStoppedEvent) => void) {
    this.stoppedListeners.add(listener);
    return { dispose: () => this.stoppedListeners.delete(listener) };
  }

  public emitServerPayload(command: LspStartServerCommand, payload: string): void {
    const seq = this.serverPayloadSeq++;
    this.relayServerSeqs.push(seq);
    const message: LspServerPayloadMessage = {
      type: "lsp/relay",
      direction: "server_to_client",
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      seq,
      payload,
    };
    for (const listener of [...this.payloadListeners]) {
      listener(message);
    }
  }

  public crashServer(workspaceId: WorkspaceId, language: LspLanguage): void {
    const serverId = `${workspaceId}:${language}`;
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`No active fake server for ${serverId}`);
    }
    this.servers.delete(serverId);
    this.emitStopped({
      type: "lsp/lifecycle",
      action: "server_stopped",
      workspaceId,
      serverId,
      language,
      serverName: server.command.serverName,
      reason: "restart",
      exitCode: null,
      signal: "SIGKILL",
      stoppedAt: stableNow().toISOString(),
    });
  }

  public startCommandsFor(workspaceId: WorkspaceId, language: LspLanguage): LspStartServerCommand[] {
    return this.startCommands.filter((command) => command.workspaceId === workspaceId && command.language === language);
  }

  public activeServerCount(): number {
    return this.servers.size;
  }

  private emitStopped(event: LspServerStoppedEvent): void {
    for (const listener of [...this.stoppedListeners]) {
      listener(event);
    }
  }
}

export class StabilityLanguageServerSession {
  public readonly receivedMessages: JsonRpcMessage[] = [];
  private readonly parser = new TestJsonRpcParser(
    (message) => {
      this.receivedMessages.push(message);
      this.handleClientMessage(message);
    },
    () => {
      this.client.malformedPayloads += 1;
    },
  );

  public constructor(
    private readonly client: StabilityLspSidecarClient,
    public readonly command: LspStartServerCommand,
  ) {}

  public receive(payload: string): void {
    this.parser.push(Buffer.from(payload, "utf8"));
  }

  private handleClientMessage(message: JsonRpcMessage): void {
    if (message.method === "initialize" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            completionProvider: { triggerCharacters: ["."] },
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: { prepareProvider: true },
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
            signatureHelpProvider: { triggerCharacters: ["(", ","] },
            codeActionProvider: { codeActionKinds: ["quickfix", "source.organizeImports"] },
            documentSymbolProvider: true,
          },
        },
      });
      return;
    }

    if (message.method === "textDocument/completion" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { isIncomplete: false, items: [{ label: `${this.command.language}-completion`, kind: 3, insertText: `${this.command.language}($0)`, insertTextFormat: 2 }] } });
      return;
    }
    if (message.method === "textDocument/hover" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: `${this.command.language} hover 한글` }, range: protocolRange(0, 0, 0, 5) } });
      return;
    }
    if (message.method === "textDocument/definition" && message.id !== undefined) {
      const uri = textDocumentUri(message);
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ targetUri: uri, targetRange: protocolRange(0, 0, 0, 5), targetSelectionRange: protocolRange(0, 0, 0, 5) }] });
      return;
    }
    if (message.method === "textDocument/references" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ uri: textDocumentUri(message), range: protocolRange(0, 0, 0, 5) }] });
      return;
    }
    if (message.method === "textDocument/prepareRename" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { range: protocolRange(0, 0, 0, 5), placeholder: "value" } });
      return;
    }
    if (message.method === "textDocument/rename" && message.id !== undefined) {
      const newName = typeof message.params?.newName === "string" ? message.params.newName : `${this.command.language}_renamed`;
      this.send({ jsonrpc: "2.0", id: message.id, result: { changes: { [textDocumentUri(message)]: [{ range: protocolRange(0, 0, 0, 5), newText: newName }] } } });
      return;
    }
    if (message.method === "textDocument/formatting" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ range: protocolRange(0, 0, 0, 5), newText: `${this.command.language}-formatted` }] });
      return;
    }
    if (message.method === "textDocument/rangeFormatting" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ range: protocolRange(0, 0, 0, 5), newText: `${this.command.language}-range-formatted` }] });
      return;
    }
    if (message.method === "textDocument/signatureHelp" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { signatures: [{ label: `${this.command.language}Fn(value)`, parameters: [{ label: "value" }] }], activeSignature: 0, activeParameter: 0 } });
      return;
    }
    if (message.method === "textDocument/codeAction" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ title: `${this.command.language} quick fix`, kind: "quickfix", isPreferred: true, edit: { changes: { [textDocumentUri(message)]: [{ range: protocolRange(0, 0, 0, 0), newText: "// fixed\n" }] } } }] });
      return;
    }
    if (message.method === "textDocument/documentSymbol" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ name: `${this.command.language}Symbol`, detail: "", kind: 12, range: protocolRange(0, 0, 0, 5), selectionRange: protocolRange(0, 0, 0, 5), children: [] }] });
      return;
    }
    if (message.method === "shutdown" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }

  private send(message: JsonRpcMessage): void {
    this.client.emitServerPayload(this.command, frameJsonRpcMessage(message));
  }
}

class TestJsonRpcParser {
  private buffer = Buffer.alloc(0);

  public constructor(
    private readonly onMessage: (message: JsonRpcMessage) => void,
    private readonly onMalformed: () => void,
  ) {}

  public push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const contentLengthMatch = /^Content-Length:\s*(\d+)/im.exec(header);
        if (!contentLengthMatch) {
          this.onMalformed();
          this.buffer = Buffer.alloc(0);
          return;
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(contentLengthMatch[1]);
        if (this.buffer.length < bodyEnd) {
          return;
        }

        const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
        this.buffer = this.buffer.subarray(bodyEnd);
        this.onMessage(JSON.parse(body) as JsonRpcMessage);
      }
    } catch {
      this.onMalformed();
    }
  }
}

export async function createWorkspaceRegistry(): Promise<WorkspaceRegistry> {
  const workspaces = [];
  for (const scenario of languageScenarios) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `nexus-m6-${scenario.language}-`));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    workspaces.push({
      id: scenario.workspaceId,
      absolutePath: tempDir,
      displayName: `M6 ${scenario.language}`,
      createdAt: stableNow().toISOString(),
      lastOpenedAt: stableNow().toISOString(),
    });
  }
  return { version: 1, workspaces };
}

function frameJsonRpcMessage(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

export function protocolRange(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function textDocumentUri(message: JsonRpcMessage): string {
  const textDocument = message.params?.textDocument;
  if (typeof textDocument === "object" && textDocument !== null && "uri" in textDocument && typeof textDocument.uri === "string") {
    return textDocument.uri;
  }
  return pathToFileURL("/tmp/fallback.ts").href;
}

export function sequenceFromOne(length: number): number[] {
  return Array.from({ length }, (_, index) => index + 1);
}

export async function waitFor(assertion: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Timed out waiting for assertion.");
}
