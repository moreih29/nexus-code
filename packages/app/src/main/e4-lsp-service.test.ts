import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { SpawnOptions } from "node:child_process";
import { pathToFileURL } from "node:url";

import type {
  E4EditorEvent,
  E4LspLanguage,
} from "../../../shared/src/contracts/e4-editor";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  E4LspService,
  type E4LspChildProcess,
  type E4LspProcessInput,
  type E4LspSpawnProcess,
} from "./e4-lsp-service";

const tempDirs: string[] = [];
const workspaceId = "ws_e4_lsp" as WorkspaceId;
const now = () => new Date("2026-04-27T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
});

describe("E4LspService", () => {
  test("reports unavailable status when a language server command is missing", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const service = new E4LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      spawnProcess: () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      },
      now,
      initializeTimeoutMs: 10,
    });

    const result = await service.readStatus({
      type: "e4/lsp-status/read",
      workspaceId,
      languages: ["typescript"],
    });

    expect(result).toEqual({
      type: "e4/lsp-status/read/result",
      workspaceId,
      statuses: [
        {
          language: "typescript",
          state: "unavailable",
          serverName: "typescript-language-server",
          message: "typescript-language-server is not available on PATH.",
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      readAt: "2026-04-27T00:00:00.000Z",
    });
  });

  test("uses stdio JSON-RPC framing and propagates diagnostics by workspace-relative path", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    const spawned: FakeLanguageServerProcess[] = [];
    const spawnProcess: E4LspSpawnProcess = (command, args, options) => {
      const child = new FakeLanguageServerProcess({
        language: "typescript",
        diagnosticsByMethod: {
          "textDocument/didOpen": "Cannot find name 'missing'.",
          "textDocument/didChange": "Cannot find name 'changedMissing'.",
        },
      });
      child.spawn = { command, args: [...args], cwd: options.cwd };
      spawned.push(child);
      return child;
    };
    const service = new E4LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      spawnProcess,
      now,
      initializeTimeoutMs: 50,
      shutdownTimeoutMs: 50,
    });
    const observedEvents: E4EditorEvent[] = [];
    service.onEvent((event) => observedEvents.push(event));
    const absoluteFilePath = path.join(workspaceRoot, "src", "index.ts");
    const expectedUri = pathToFileURL(absoluteFilePath).href;

    const openResult = await service.openDocument({
      type: "e4/lsp-document/open",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      content: "const value = missing;\n",
      version: 7,
    });

    expect(openResult.status.state).toBe("ready");
    expect(spawned[0]?.spawn).toEqual({
      command: "typescript-language-server",
      args: ["--stdio"],
      cwd: workspaceRoot,
    });
    expect(spawned[0]?.rawClientInput()).toContain("Content-Length:");
    expect(spawned[0]?.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
    ]);
    expect(spawned[0]?.receivedMessages.at(2)?.params).toEqual({
      textDocument: {
        uri: expectedUri,
        languageId: "typescript",
        version: 7,
        text: "const value = missing;\n",
      },
    });

    await waitFor(() => {
      expect(
        observedEvents.some(
          (event) =>
            event.type === "e4/lsp-diagnostics/changed" &&
            event.path === "src/index.ts" &&
            event.diagnostics[0]?.message === "Cannot find name 'missing'.",
        ),
      ).toBe(true);
    });

    await service.changeDocument({
      type: "e4/lsp-document/change",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      content: "const value = changedMissing;\n",
      version: 8,
    });

    await waitFor(async () => {
      const diagnostics = await service.readDiagnostics({
        type: "e4/lsp-diagnostics/read",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
      });
      expect(diagnostics.diagnostics).toEqual([
        {
          path: "src/index.ts",
          language: "typescript",
          range: {
            start: { line: 0, character: 14 },
            end: { line: 0, character: 21 },
          },
          severity: "error",
          message: "Cannot find name 'changedMissing'.",
          source: "fake-typescript",
          code: "fake-code",
        },
      ]);
    });

    await service.closeDocument({
      type: "e4/lsp-document/close",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
    });

    expect(spawned[0]?.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didClose",
      "shutdown",
      "exit",
    ]);
    expect(spawned[0]?.killCalls).toEqual(["SIGTERM"]);
  });

  test("falls back from `gopls serve` to bare `gopls` when serve exits before initialize", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const spawnProcess: E4LspSpawnProcess = (command, args) => {
      spawnCalls.push({ command, args: [...args] });
      if (args[0] === "serve") {
        return new ExitingLanguageServerProcess();
      }

      return new FakeLanguageServerProcess({ language: "go" });
    };
    const service = new E4LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      spawnProcess,
      now,
      initializeTimeoutMs: 50,
    });

    const status = await service.readStatus({
      type: "e4/lsp-status/read",
      workspaceId,
      languages: ["go"],
    });

    expect(spawnCalls).toEqual([
      { command: "gopls", args: ["serve"] },
      { command: "gopls", args: [] },
    ]);
    expect(status.statuses[0]).toMatchObject({
      language: "go",
      state: "ready",
      serverName: "gopls",
    });
  });

  test("disposes running language servers on workspace close", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const spawned: FakeLanguageServerProcess[] = [];
    const service = new E4LspService({
      workspacePersistenceStore: createWorkspaceStore(workspaceRoot),
      spawnProcess: () => {
        const child = new FakeLanguageServerProcess({ language: "python" });
        spawned.push(child);
        return child;
      },
      now,
      initializeTimeoutMs: 50,
      shutdownTimeoutMs: 50,
    });
    const observedEvents: E4EditorEvent[] = [];
    service.onEvent((event) => observedEvents.push(event));

    await service.openDocument({
      type: "e4/lsp-document/open",
      workspaceId,
      path: "main.py",
      language: "python",
      content: "print('hello')\n",
      version: 1,
    });
    await service.closeWorkspace(workspaceId);

    expect(spawned[0]?.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "shutdown",
      "exit",
    ]);
    expect(spawned[0]?.killCalls).toEqual(["SIGTERM"]);
    expect(
      observedEvents
        .filter((event) => event.type === "e4/lsp-status/changed")
        .at(-1),
    ).toMatchObject({
      type: "e4/lsp-status/changed",
      workspaceId,
      status: {
        language: "python",
        state: "stopped",
      },
    });
    const status = await service.readStatus({
      type: "e4/lsp-status/read",
      workspaceId,
      languages: ["python"],
    });
    expect(status.statuses[0]?.state).toBe("stopped");
    expect(spawned).toHaveLength(1);
    await service.dispose();
  });
});

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

class FakeLanguageServerProcess extends EventEmitter implements E4LspChildProcess {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly receivedMessages: JsonRpcMessage[] = [];
  public readonly killCalls: NodeJS.Signals[] = [];
  public readonly clientChunks: Buffer[] = [];
  public readonly stdin: E4LspProcessInput;
  public spawn: { command: string; args: string[]; cwd: unknown } | null = null;
  public killed = false;
  private readonly parser = new TestJsonRpcParser((message) => {
    this.receivedMessages.push(message);
    this.handleClientMessage(message);
  });

  public constructor(
    private readonly options: {
      language: E4LspLanguage;
      diagnosticsByMethod?: Partial<Record<string, string>>;
    },
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.clientChunks.push(buffer);
        this.parser.push(buffer);
        callback();
      },
    });
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    this.emit("exit", 0, signal);
    return true;
  }

  public rawClientInput(): string {
    return Buffer.concat(this.clientChunks).toString("utf8");
  }

  private handleClientMessage(message: JsonRpcMessage): void {
    if (message.method === "initialize" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
          },
        },
      });
      return;
    }

    const diagnosticMessage = message.method
      ? this.options.diagnosticsByMethod?.[message.method]
      : null;
    if (diagnosticMessage) {
      const textDocument = (message.params?.textDocument ?? {}) as { uri?: string; version?: number };
      this.publishDiagnostics(textDocument.uri, textDocument.version, diagnosticMessage);
      return;
    }

    if (message.method === "shutdown" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: null,
      });
      return;
    }

    if (message.method === "exit") {
      this.emit("exit", 0, null);
    }
  }

  private publishDiagnostics(
    uri: string | undefined,
    version: number | undefined,
    message: string,
  ): void {
    this.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 14 },
              end: { line: 0, character: 21 },
            },
            severity: 1,
            message,
            source: `fake-${this.options.language}`,
            code: "fake-code",
          },
        ],
      },
    });
  }

  private send(message: JsonRpcMessage): void {
    this.stdout.write(frameJsonRpcMessage(message));
  }
}

class ExitingLanguageServerProcess extends EventEmitter implements E4LspChildProcess {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killCalls: NodeJS.Signals[] = [];
  public readonly stdin: E4LspProcessInput;
  public killed = false;

  public constructor() {
    super();
    this.stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        queueMicrotask(() => this.emit("exit", 1, null));
        callback();
      },
    });
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }
}

class TestJsonRpcParser {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly onMessage: (message: JsonRpcMessage) => void) {}

  public push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const contentLengthMatch = /^Content-Length:\s*(\d+)/im.exec(header);
      if (!contentLengthMatch) {
        throw new Error(`Missing Content-Length header: ${header}`);
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
  }
}

function frameJsonRpcMessage(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

async function createWorkspaceRoot(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "nexus-e4-lsp-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createWorkspaceStore(workspaceRoot: string) {
  return {
    async getWorkspaceRegistry() {
      return {
        version: 1 as const,
        workspaces: [
          {
            id: workspaceId,
            absolutePath: workspaceRoot,
            displayName: "E4 LSP Workspace",
            createdAt: "2026-04-27T00:00:00.000Z",
            lastOpenedAt: "2026-04-27T00:00:00.000Z",
          },
        ],
      };
    },
  };
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 250,
): Promise<void> {
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
