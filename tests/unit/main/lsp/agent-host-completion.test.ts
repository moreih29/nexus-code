/**
 * Completion on the agent path: the list keeps what the editor shows
 * (detail, documentation, edits, sort order), a trigger character the
 * server does not list asks nothing, and a picked item is resolved for the
 * fields servers leave out of the list.
 */

import { expect, test } from "bun:test";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";

const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const URI = "file:///tmp/ws/main.ts";

/** Answers each LSP request with `responses[method]` and records what it sent. */
class CompletionChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly sent: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();

  constructor(
    private readonly completionProvider: unknown,
    private readonly responses: Record<string, unknown>,
  ) {}

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "lsp.spawn") {
      return {
        serverId: "srv",
        capabilities: {
          textDocumentSync: { openClose: true, change: 2 },
          completionProvider: this.completionProvider,
        },
      } as TResult;
    }
    if (method === "lsp.send") {
      const message = (params as { message: { id?: number; method: string; params: unknown } })
        .message;
      this.sent.push({ method: message.method, params: message.params });
      queueMicrotask(() => {
        for (const listener of this.listeners.get("lsp.message") ?? []) {
          listener({
            serverId: "srv",
            message: { jsonrpc: "2.0", id: message.id, result: this.responses[message.method] },
          });
        }
      });
    }
    return {} as TResult;
  }

  fire(): void {}

  on(event: string, callback: ChannelEventCallback): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  onLifecycle(_callback: ChannelLifecycleCallback): () => void {
    return () => {};
  }

  dispose(): void {}
}

async function openHost(completionProvider: unknown, responses: Record<string, unknown> = {}) {
  const channel = new CompletionChannel(completionProvider, responses);
  const host = startAgentLspHost({ getAgentChannel: async () => channel });
  await host.call("didOpen", {
    workspaceId: WORKSPACE_ID,
    workspaceRoot: "/tmp/ws",
    uri: URI,
    languageId: "typescript",
    version: 1,
    text: "app.\n",
  });
  return { channel, host };
}

const AT_DOT = { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 4 };

test("the list keeps the fields the editor shows, and items with null fields", async () => {
  const item = {
    label: "readFile",
    labelDetails: { description: "node:fs" },
    kind: 3,
    detail: "function readFile(path: string): string",
    documentation: { kind: "markdown", value: "Reads a file." },
    sortText: "11",
    filterText: "readFile",
    insertText: "readFile($1)",
    insertTextFormat: 2,
    textEdit: {
      range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } },
      newText: "readFile($1)",
    },
    additionalTextEdits: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'import { readFile } from "node:fs";\n',
      },
    ],
    commitCharacters: ["("],
    data: { entryNames: ["readFile"] },
  };
  const { host } = await openHost(
    { triggerCharacters: ["."] },
    {
      "textDocument/completion": {
        isIncomplete: true,
        items: [item, { label: "x", detail: null }],
      },
    },
  );

  const list = await host.call("completion", AT_DOT);

  expect(list).toEqual({ isIncomplete: true, items: [item, { label: "x" }] });
  host.dispose();
});

test("a trigger character the server does not complete on asks nothing", async () => {
  const { channel, host } = await openHost({ triggerCharacters: ["."] });

  const list = await host.call("completion", { ...AT_DOT, triggerKind: 2, triggerCharacter: "<" });

  expect(list).toEqual({ isIncomplete: false, items: [] });
  expect(channel.sent.map((m) => m.method)).not.toContain("textDocument/completion");
  host.dispose();
});

test("the trigger reaches the server as the request's context", async () => {
  const { channel, host } = await openHost(
    { triggerCharacters: ["."] },
    { "textDocument/completion": [] },
  );

  await host.call("completion", { ...AT_DOT, triggerKind: 2, triggerCharacter: "." });
  await host.call("completion", { ...AT_DOT, triggerKind: 1 });

  const contexts = channel.sent
    .filter((m) => m.method === "textDocument/completion")
    .map((m) => (m.params as { context?: unknown }).context);
  expect(contexts).toEqual([{ triggerKind: 2, triggerCharacter: "." }, { triggerKind: 1 }]);
  host.dispose();
});

test("a picked item is resolved for its documentation and auto-import", async () => {
  const resolved = {
    label: "readFile",
    detail: "function readFile(path: string): string",
    documentation: "Reads a file.",
    additionalTextEdits: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'import { readFile } from "node:fs";\n',
      },
    ],
  };
  const { channel, host } = await openHost(
    { triggerCharacters: ["."], resolveProvider: true },
    { "completionItem/resolve": resolved },
  );
  const item = { label: "readFile", data: { entryNames: ["readFile"] } };

  const result = await host.call("completionResolve", {
    workspaceId: WORKSPACE_ID,
    uri: URI,
    item,
  });

  expect(result).toEqual(resolved);
  expect(channel.sent.find((m) => m.method === "completionItem/resolve")?.params).toEqual(item);
  host.dispose();
});

test("an item comes back as it was when the server does not resolve", async () => {
  const { channel, host } = await openHost({ triggerCharacters: ["."] });
  const item = { label: "readFile" };

  const result = await host.call("completionResolve", {
    workspaceId: WORKSPACE_ID,
    uri: URI,
    item,
  });

  expect(result).toEqual(item);
  expect(channel.sent).toHaveLength(0);
  host.dispose();
});
