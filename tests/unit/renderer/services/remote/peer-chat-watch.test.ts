import { expect, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { watchPeerChat } from "../../../../../src/renderer/services/remote/peer-chat-watch";
import { ipcOk } from "../../../../../src/shared/ipc/result";

const chat = { deviceId: "desktop", workspaceId: "repo", tabId: "chat" };
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("switching views waits for the old chat watch to unwatch, including a late start", async () => {
  const first = Promise.withResolvers<ReturnType<typeof ipcOk<{ watchId: string }>>>();
  const unwatch = Promise.withResolvers<ReturnType<typeof ipcOk<undefined>>>();
  const calls = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => unwatch.promise)
    .mockResolvedValueOnce(ipcOk({ watchId: "workspace" }))
    .mockResolvedValueOnce(ipcOk(undefined));
  let stopAgent: (() => void) | undefined;
  let stopWorkspace: (() => void) | undefined;
  const results: string[] = [];
  try {
    stopAgent = watchPeerChat(chat, undefined, () => results.push("agent"));
    await settled();
    stopAgent();
    stopWorkspace = watchPeerChat(chat, undefined, () => results.push("workspace"));
    await settled();
    expect(calls.mock.calls.map(([, method]) => method)).toEqual(["peerChatWatch"]);
    first.resolve(ipcOk({ watchId: "agent" }));
    await settled();
    expect(calls.mock.calls.map(([, method]) => method)).toEqual([
      "peerChatWatch",
      "peerChatUnwatch",
    ]);
    expect(calls.mock.calls[1]?.[2]).toEqual({ deviceId: chat.deviceId, watchId: "agent" });
    expect(results).toEqual([]);
    unwatch.resolve(ipcOk(undefined));
    await settled();
    expect(calls.mock.calls.map(([, method]) => method)).toEqual([
      "peerChatWatch",
      "peerChatUnwatch",
      "peerChatWatch",
    ]);
    expect(results).toEqual(["workspace"]);
  } finally {
    first.resolve(ipcOk({ watchId: "agent" }));
    unwatch.resolve(ipcOk(undefined));
    stopAgent?.();
    stopWorkspace?.();
    await settled();
    calls.mockRestore();
  }
});
