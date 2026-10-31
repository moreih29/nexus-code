/**
 * Signature help on the agent path: the server's signature comes back with
 * the null fields servers send left out, the trigger reaches the server as
 * the request's context, and a trigger character the server does not list
 * asks nothing until a signature is shown.
 */

import { expect, test } from "bun:test";
import { startAgentLspHost } from "../../../../src/main/features/lsp/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
} from "../../../../src/main/infra/agent/channel";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const URI = "file:///tmp/ws/main.py";

/** Answers each LSP request with `responses[method]` and records what it sent. */
class SignatureHelpChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly sent: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Map<string, Set<ChannelEventCallback>>();

  constructor(
    private readonly signatureHelpProvider: unknown,
    private readonly responses: Record<string, unknown>,
  ) {}

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "lsp.spawn") {
      return {
        serverId: "srv",
        capabilities: {
          textDocumentSync: { openClose: true, change: 2 },
          ...(this.signatureHelpProvider
            ? { signatureHelpProvider: this.signatureHelpProvider }
            : {}),
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

async function openHost(signatureHelpProvider: unknown, responses: Record<string, unknown> = {}) {
  const channel = new SignatureHelpChannel(signatureHelpProvider, responses);
  const host = startAgentLspHost({ getAgentChannel: async () => channel });
  await host.call("didOpen", {
    workspaceId: WORKSPACE_ID,
    workspaceRoot: "/tmp/ws",
    uri: URI,
    languageId: "python",
    version: 1,
    text: "get(\n",
  });
  return { channel, host };
}

const IN_CALL = { workspaceId: WORKSPACE_ID, uri: URI, line: 0, character: 4 };
const TYPED = (triggerCharacter: string, isRetrigger = false) => ({
  ...IN_CALL,
  triggerKind: 2,
  triggerCharacter,
  isRetrigger,
});

test("the signature comes back without the null fields servers send", async () => {
  const { host } = await openHost(
    { triggerCharacters: ["(", ","] },
    {
      "textDocument/signatureHelp": {
        signatures: [
          {
            label: "get(url: str, params: dict | None = None)",
            documentation: null,
            parameters: [
              { label: [4, 12], documentation: null },
              { label: "params: dict | None = None", documentation: "Query string." },
            ],
            activeParameter: null,
          },
          { label: "not a signature", parameters: "wrong" },
        ],
        activeSignature: 0,
        activeParameter: 0,
      },
    },
  );

  const help = await host.call("signatureHelp", TYPED("("));

  expect(help).toEqual({
    signatures: [
      {
        label: "get(url: str, params: dict | None = None)",
        parameters: [
          { label: [4, 12] },
          { label: "params: dict | None = None", documentation: "Query string." },
        ],
        activeParameter: null,
      },
    ],
    activeSignature: 0,
    activeParameter: 0,
  });
  host.dispose();
});

test("no signature is null", async () => {
  const { host } = await openHost(
    { triggerCharacters: ["("] },
    { "textDocument/signatureHelp": { signatures: [] } },
  );

  expect(await host.call("signatureHelp", TYPED("("))).toBeNull();
  host.dispose();
});

test("the trigger reaches the server as the request's context", async () => {
  const { channel, host } = await openHost(
    { triggerCharacters: ["(", ","] },
    { "textDocument/signatureHelp": null },
  );
  const shown = { signatures: [{ label: "get(url)" }], activeSignature: 0, activeParameter: 0 };

  await host.call("signatureHelp", TYPED(","));
  await host.call("signatureHelp", {
    ...IN_CALL,
    triggerKind: 3,
    isRetrigger: true,
    activeSignatureHelp: shown,
  });

  const contexts = channel.sent
    .filter((m) => m.method === "textDocument/signatureHelp")
    .map((m) => (m.params as { context: unknown }).context);
  expect(contexts).toEqual([
    { triggerKind: 2, triggerCharacter: ",", isRetrigger: false },
    { triggerKind: 3, isRetrigger: true, activeSignatureHelp: shown },
  ]);
  host.dispose();
});

test("a character the server does not list asks nothing until a signature is shown", async () => {
  const { channel, host } = await openHost(
    { triggerCharacters: ["(", ","], retriggerCharacters: [")"] },
    { "textDocument/signatureHelp": null },
  );

  expect(await host.call("signatureHelp", TYPED("<"))).toBeNull();
  expect(channel.sent.map((m) => m.method)).not.toContain("textDocument/signatureHelp");

  await host.call("signatureHelp", TYPED(")", true));
  expect(channel.sent.map((m) => m.method)).toContain("textDocument/signatureHelp");
  host.dispose();
});

test("a server without signature help asks nothing", async () => {
  const { channel, host } = await openHost(undefined);

  expect(await host.call("signatureHelp", TYPED("("))).toBeNull();
  expect(channel.sent.map((m) => m.method)).not.toContain("textDocument/signatureHelp");
  host.dispose();
});
