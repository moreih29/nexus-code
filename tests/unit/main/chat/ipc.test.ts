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
