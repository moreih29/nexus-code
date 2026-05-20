import fs from "node:fs";
import path from "node:path";
import { describe, expect, mock, test, beforeAll, afterAll } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";

import { LSP_BOOTSTRAP_PROGRESS_EVENT } from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/index";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";
import { startConfiguredLspHost, type LspHostHandle } from "../../../../src/main/features/lsp/host";

// ---------------------------------------------------------------------------
// Manifest neutralization
// ---------------------------------------------------------------------------
// resolveLspCommandFromManifest() in agent-host.ts reads
// path.join(process.cwd(), "dist", "agent", "manifest.json").  If a built
// manifest exists on disk the production path wins and the dev-fallback
// pyright assertion below fails.  We rename the file for the duration of
// this test file and restore it in afterAll, keeping the approach
// non-polluting (no process-global mock.module).
const MANIFEST_PATH = path.join(process.cwd(), "dist", "agent", "manifest.json");
const MANIFEST_BAK_PATH = `${MANIFEST_PATH}.test-bak`;

beforeAll(() => {
  if (fs.existsSync(MANIFEST_PATH)) {
    fs.renameSync(MANIFEST_PATH, MANIFEST_BAK_PATH);
  }
});

afterAll(() => {
  if (fs.existsSync(MANIFEST_BAK_PATH)) {
    fs.renameSync(MANIFEST_BAK_PATH, MANIFEST_PATH);
  }
});

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const URI = "file:///tmp/ws/main.py";

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();
  readonly serverId = "srv-1";
  emitConfigurationRequest = false;

  constructor(
    private readonly capabilities: Record<string, unknown> = {
      textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
      hoverProvider: true,
      definitionProvider: true,
      completionProvider: {},
      workspaceSymbolProvider: true,
    },
  ) {}

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    this.calls.push({ method, params });

    if (method === "lsp.spawn") {
      // Mirror the real agent: serverAssigned is emitted before any
      // server-pushed request so the host can resolve serverId context
      // while initialize is still in flight.
      const correlationId = (params as { correlationId?: string } | undefined)?.correlationId;
      this.emit("lsp.serverAssigned", {
        serverId: this.serverId,
        ...(correlationId ? { correlationId } : {}),
      });
      if (this.emitConfigurationRequest) {
        this.emit("lsp.serverRequest", {
          serverId: this.serverId,
          agentRequestId: "config-1",
          method: "workspace/configuration",
          params: { items: [{ section: "python.analysis" }] },
        });
      }
      return {
        serverId: this.serverId,
        capabilities: this.capabilities,
      } as TResult;
    }

    if (method === "lsp.send") {
      const message = (params as { message?: { id?: unknown; method?: string } }).message;
      if (message?.method === "textDocument/didOpen") {
        queueMicrotask(() => {
          this.emit("lsp.message", {
            serverId: this.serverId,
            message: {
              jsonrpc: "2.0",
              method: "textDocument/publishDiagnostics",
              params: {
                uri: URI,
                diagnostics: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 5 },
                    },
                    message: "agent diagnostic",
                  },
                ],
              },
            },
          });
        });
      }
      if (message?.method === "textDocument/hover" && message.id !== undefined) {
        queueMicrotask(() => {
          this.emit("lsp.message", {
            serverId: this.serverId,
            message: {
              jsonrpc: "2.0",
              id: message.id,
              result: { contents: "agent hover" },
            },
          });
        });
      }
      if (message?.method === "textDocument/definition" && message.id !== undefined) {
        queueMicrotask(() => {
          this.emit("lsp.message", {
            serverId: this.serverId,
            message: {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                uri: URI,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
              },
            },
          });
        });
      }
      if (message?.method === "textDocument/completion" && message.id !== undefined) {
        queueMicrotask(() => {
          this.emit("lsp.message", {
            serverId: this.serverId,
            message: {
              jsonrpc: "2.0",
              id: message.id,
              result: [{ label: "agentCompletion" }],
            },
          });
        });
      }
    }

    return {} as TResult;
  }

  on(event: string, callback: ChannelEventCallback): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  onLifecycle(callback: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(callback);
    return () => this.lifecycleListeners.delete(callback);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) {
      listener(payload);
    }
  }

  dispose(): void {}
}

// SharedAgentChannel models a single workspace channel that hosts multiple
// LSP servers concurrently — the case where the original
// pendingSpawnsByChannel heuristic mis-attributed pre-spawn-resolution
// events. Each lsp.spawn assigns a fresh serverId, emits lsp.serverAssigned
// with the caller's correlationId, then pushes a window/logMessage event
// that the test asserts gets attributed to the matching languageId.
class SharedAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();
  private nextServerSeq = 0;
  // Hold spawn responses until both calls have arrived so the assignment
  // race is realistic — both serverId emissions fire before either spawn
  // promise resolves, so any heuristic that picks "first pending" cannot
  // hide the bug.
  private pendingResolvers: Array<() => void> = [];

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "lsp.spawn") {
      this.nextServerSeq += 1;
      const serverId = `srv-shared-${this.nextServerSeq}`;
      const correlationId = (params as { correlationId?: string } | undefined)?.correlationId;
      this.emit("lsp.serverAssigned", {
        serverId,
        ...(correlationId ? { correlationId } : {}),
      });
      this.emit("lsp.message", {
        serverId,
        message: {
          jsonrpc: "2.0",
          method: "window/logMessage",
          params: { type: 4, message: `boot ${serverId}` },
        },
      });
      return new Promise<TResult>((resolve) => {
        this.pendingResolvers.push(() =>
          resolve({
            serverId,
            capabilities: {
              textDocumentSync: { openClose: true, change: 2 },
              hoverProvider: true,
            },
          } as TResult),
        );
        if (this.pendingResolvers.length === 2) {
          for (const r of this.pendingResolvers) r();
          this.pendingResolvers = [];
        }
      });
    }
    return {} as TResult;
  }

  on(event: string, callback: ChannelEventCallback): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  onLifecycle(callback: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(callback);
    return () => this.lifecycleListeners.delete(callback);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) {
      listener(payload);
    }
  }

  dispose(): void {}
}

function fakeHost(): LspHostHandle {
  return {
    call: () => Promise.resolve(null),
    notify: () => {},
    respondServerRequest: () => {},
    rejectServerRequest: () => {},
    on: () => () => {},
    isAlive: () => true,
    dispose: () => {},
  };
}

describe("AgentLspHostHandle", () => {
  test("spawns through the workspace agent and resolves LSP responses", async () => {
    const channel = new FakeAgentChannel();
    channel.emitConfigurationRequest = true;
    const manager = {
      getAgentChannel: mock(async () => channel),
    };
    const host = startAgentLspHost(manager);

    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI,
      languageId: "python",
      version: 1,
      text: "print(1)\n",
    });

    const spawn = channel.calls.find((call) => call.method === "lsp.spawn");
    expect(spawn?.params).toMatchObject({
      workspaceId: WORKSPACE_ID,
      languageId: "python",
      args: ["--stdio"],
      workspaceRoot: "/tmp/ws",
    });
    expect(
      (spawn?.params as { binaryPath: string }).binaryPath.endsWith(
        "node_modules/.bin/pyright-langserver",
      ),
    ).toBe(true);

    const configResponse = channel.calls.find((call) => call.method === "lsp.respondServerRequest");
    expect(configResponse?.params).toMatchObject({
      serverId: channel.serverId,
      agentRequestId: "config-1",
      result: [
        {
          typeCheckingMode: "standard",
          diagnosticMode: "openFilesOnly",
          autoImportCompletions: true,
          useLibraryCodeForTypes: true,
        },
      ],
    });

    expect(
      channel.calls.some(
        (call) =>
          call.method === "lsp.send" &&
          (call.params as { message?: { method?: string } }).message?.method ===
            "textDocument/didOpen",
      ),
    ).toBe(true);

    const hover = await host.call("hover", { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 1 });
    expect(hover).toEqual({ contents: "agent hover" });
    expect(
      channel.calls.some(
        (call) =>
          call.method === "lsp.send" &&
          (call.params as { message?: { method?: string } }).message?.method ===
            "textDocument/hover",
      ),
    ).toBe(true);
  });

  test("resolves document notifications quietly after dispose, still throws for requests", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentLspHost({ getAgentChannel: async () => channel });
    host.dispose();

    // Fire-and-forget notifications can arrive after dispose() during app
    // shutdown (the renderer is still emitting didClose as editor models
    // close) — they must resolve quietly rather than surfacing a handler error.
    await expect(host.call("didClose", { workspaceId: WORKSPACE_ID, uri: URI })).resolves.toBeNull();

    // Request-style methods still surface the disposed error to their callers.
    await expect(host.call("hover", { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 0 })).rejects.toThrow(
      "LSP host disposed",
    );
  });

  test("normalizes definition, completion, and diagnostics on the agent path", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentLspHost({
      getAgentChannel: async () => channel,
    });
    const diagnostics: unknown[] = [];
    host.on("diagnostics", (args) => diagnostics.push(args));

    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI,
      languageId: "python",
      version: 1,
      text: "print(1)\n",
    });
    await Promise.resolve();

    const definition = await host.call("definition", { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 1 });
    expect(definition).toEqual([
      {
        uri: URI,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
    ]);

    const completion = await host.call("completion", { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 1 });
    expect(completion).toEqual([{ label: "agentCompletion" }]);
    expect(diagnostics).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        languageId: "python",
        uri: URI,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            message: "agent diagnostic",
          },
        ],
      },
    ]);
  });

  test("maps workspace/applyEdit server requests back to agent responses", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentLspHost({
      getAgentChannel: async () => channel,
    });
    const serverRequests: unknown[] = [];
    host.on("serverRequest", (args) => serverRequests.push(args));

    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI,
      languageId: "python",
      version: 1,
      text: "print(1)\n",
    });

    channel.emit("lsp.serverRequest", {
      serverId: channel.serverId,
      agentRequestId: "apply-1",
      method: "workspace/applyEdit",
      params: { edit: { changes: {} } },
    });

    expect(serverRequests).toHaveLength(1);
    const request = serverRequests[0] as { id: string; method: string; params: unknown };
    expect(request).toMatchObject({
      method: "workspace/applyEdit",
      params: { edit: { changes: {} } },
    });

    host.respondServerRequest(request.id, { applied: true });
    expect(channel.calls.at(-1)).toEqual({
      method: "lsp.respondServerRequest",
      params: {
        serverId: channel.serverId,
        agentRequestId: "apply-1",
        result: { applied: true },
      },
    });
  });

  test("ensures a remote LSP launcher before agent spawn and emits bootstrap progress", async () => {
    const channel = new FakeAgentChannel();
    const ensureRemoteLspServer = mock(
      async (
        _workspaceId: string,
        _request: unknown,
        onProgress?: (event: {
          name: string;
          phase: "uploading";
          bytesDone: number;
          bytesTotal: number;
        }) => void,
      ) => {
        onProgress?.({
          name: "pyright-langserver",
          phase: "uploading",
          bytesDone: 4,
          bytesTotal: 8,
        });
        return {
          binaryPath:
            "/home/deploy/.nexus-code/lsp/pyright-langserver-1.1.409/bin/pyright-langserver",
          args: ["--stdio"],
        };
      },
    );
    const host = startAgentLspHost({
      getAgentChannel: async () => channel,
      ensureRemoteLspServer,
    });
    const progressEvents: unknown[] = [];
    host.on(LSP_BOOTSTRAP_PROGRESS_EVENT, (event) => progressEvents.push(event));

    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI,
      languageId: "python",
      version: 1,
      text: "print(1)\n",
    });

    expect(ensureRemoteLspServer).toHaveBeenCalledWith(
      WORKSPACE_ID,
      {
        binaryName: "pyright-langserver",
        languageId: "python",
        args: ["--stdio"],
      },
      expect.any(Function),
    );
    const spawn = channel.calls.find((call) => call.method === "lsp.spawn");
    expect(spawn?.params).toMatchObject({
      binaryPath: "/home/deploy/.nexus-code/lsp/pyright-langserver-1.1.409/bin/pyright-langserver",
      args: ["--stdio"],
    });
    expect(progressEvents).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        languageId: "python",
        name: "pyright-langserver",
        phase: "uploading",
        bytesDone: 4,
        bytesTotal: 8,
      },
    ]);
  });

  test("drops agent-backed servers when their channel is disposed", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentLspHost({
      getAgentChannel: async () => channel,
    });

    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI,
      languageId: "python",
      version: 1,
      text: "print(1)\n",
    });

    const hoverBeforeDispose = await host.call("hover", { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 1 });
    expect(hoverBeforeDispose).toEqual({ contents: "agent hover" });

    for (const listener of channel.lifecycleListeners) {
      listener({ type: "disposed" });
    }

    const hoverAfterDispose = await host.call("hover", { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 1 });
    expect(hoverAfterDispose).toBeNull();
  });

  test("routes concurrent spawn server requests to the originating language", async () => {
    // Without correlation, two same-channel spawns of different languages
    // could attribute pre-spawn-resolution server requests to whichever
    // spawn registered first. With lsp.serverAssigned each request is
    // tagged with its spawn's serverId before initialize finishes.
    const channel = new SharedAgentChannel();
    const host = startAgentLspHost({
      getAgentChannel: async () => channel,
    });
    const serverEvents: Array<{ languageId: string; method: string }> = [];
    host.on("serverEvent", (args) => {
      const event = args as { languageId: string; method: string };
      serverEvents.push({ languageId: event.languageId, method: event.method });
    });

    await Promise.all([
      host.call("didOpen", {
        workspaceId: WORKSPACE_ID,
        workspaceRoot: "/tmp/ws",
        uri: "file:///tmp/ws/main.ts",
        languageId: "typescript",
        version: 1,
        text: "export const x = 1\n",
      }),
      host.call("didOpen", {
        workspaceId: WORKSPACE_ID,
        workspaceRoot: "/tmp/ws",
        uri: "file:///tmp/ws/app.py",
        languageId: "python",
        version: 1,
        text: "print(1)\n",
      }),
    ]);

    expect(serverEvents).toHaveLength(2);
    expect(serverEvents).toContainEqual({
      languageId: "typescript",
      method: "window/logMessage",
    });
    expect(serverEvents).toContainEqual({ languageId: "python", method: "window/logMessage" });
  });

  test("rejects pending requests and forgets the server when lsp.serverExited fires", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentLspHost({
      getAgentChannel: async () => channel,
    });

    await host.call("didOpen", {
      workspaceId: WORKSPACE_ID,
      workspaceRoot: "/tmp/ws",
      uri: URI,
      languageId: "python",
      version: 1,
      text: "print(1)\n",
    });

    channel.emit("lsp.serverExited", {
      serverId: channel.serverId,
      reason: "lsp server exited: signal: killed",
      stderrTail: "panic: out of memory",
    });

    const hoverAfterExit = await host.call("hover", { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 1 });
    expect(hoverAfterExit).toBeNull();
  });
});

describe("LSP host selection", () => {
  test("starts the agent-backed host", () => {
    const agent = fakeHost();
    const workspaceManager = { getAgentChannel: async () => new FakeAgentChannel() };

    expect(
      startConfiguredLspHost({
        workspaceManager,
        agentHostFactory: () => agent,
      }),
    ).toBe(agent);
  });
});

