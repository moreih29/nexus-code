import { expect, mock, test } from "bun:test";
import { ipcOk } from "../../../../src/shared/ipc/result";

type ChatCall = (
  sender: object,
  channel: "chat",
  method: string,
  args: unknown,
) => Promise<unknown>;

let ipcCall: ChatCall | undefined;
mock.module("electron", () => ({
  ipcMain: {
    on: () => {},
    handle: (channel: string, handler: ChatCall) => {
      if (channel === "ipc:call") ipcCall = handler;
    },
  },
}));

const { setupRouter } = await import("../../../../src/main/infra/ipc-router");
const { registerChatChannel } = await import("../../../../src/main/features/chat/ipc");

test("disposing the chat host ends an MCP sign-in waiting over IPC", async () => {
  setupRouter();
  const handler = ipcCall;
  if (!handler) throw new Error("IPC call handler was not installed");
  const host = registerChatChannel({
    workspaceManager: {
      getAgentChannel: async () => {
        throw new Error("unexpected agent request");
      },
      tryGetAgentChannel: async () => null,
      onProviderReady: () => () => {},
      getSpawnHookInfo: async () => null,
      getWrapperBinDir: () => null,
      getWrapperAgentBin: () => null,
      getWrapperShimDir: () => null,
    },
  });
  const call = (method: string, args: unknown) => handler({}, "chat", method, args);
  const opened = (await call("oauthListen", {})) as { ok: true; value: { id: string } };
  const { id } = opened.value;
  let response: unknown;
  const waiting = call("oauthWait", { id }).then((value) => {
    response = value;
  });
  try {
    host.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(response).toEqual(ipcOk({ url: null }));
  } finally {
    await call("oauthCancel", { id });
    await waiting;
  }
});

test("chat.send and chat.close take a run reader's tab id and refuse other names", async () => {
  setupRouter();
  const handler = ipcCall;
  if (!handler) throw new Error("IPC call handler was not installed");
  const host = registerChatChannel({
    workspaceManager: {
      getAgentChannel: async () => {
        throw new Error("unexpected agent request");
      },
      tryGetAgentChannel: async () => null,
      peekAgentChannel: async () => null,
      onProviderReady: () => () => {},
      getSpawnHookInfo: async () => null,
      getWrapperBinDir: () => null,
      getWrapperAgentBin: () => null,
      getWrapperShimDir: () => null,
    },
  });
  const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const call = (method: string, args: unknown) =>
    handler({}, "chat", method, args) as Promise<{ ok: boolean; kind?: string }>;
  const message = { id: 1, method: "thread/read" };
  try {
    const reader = "print-run-reader-0f8e2b9c-4d1a-4e5f-9a7b-3c2d1e0f9a8b";
    expect(await call("close", { workspaceId, tabId: reader })).toEqual(ipcOk(undefined));
    const sent = await call("send", { workspaceId, tabId: reader, message });
    expect(sent.ok).toBe(false);
    expect(sent.kind).toBe("chat.reader-read-only");

    for (const tabId of [
      "print-run-reader-made-up",
      "print-run-reader-0f8e2b9c-4d1a-4e5f-9a7b-3c2d1e0f9a8b-x",
      "print-run-reader-0F8E2B9C-4D1A-4E5F-9A7B-3C2D1E0F9A8B",
      "x-print-run-reader-0f8e2b9c-4d1a-4e5f-9a7b-3c2d1e0f9a8b",
      "../0f8e2b9c-4d1a-4e5f-9a7b-3c2d1e0f9a8b",
      "",
    ]) {
      for (const [method, args] of [
        ["close", { workspaceId, tabId }],
        ["send", { workspaceId, tabId, message }],
      ] as const) {
        const refused = await call(method, args);
        expect(refused.ok).toBe(false);
        expect(refused.kind).toBe("invalid-args");
      }
    }
  } finally {
    host.dispose();
  }
});
