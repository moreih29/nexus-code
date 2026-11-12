import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// The IPC bridge, answered here (installed before the module is imported)
// ---------------------------------------------------------------------------

const ipcCalls: Array<{ channel: string; method: string; args: unknown }> = [];
let answer: (method: string, args: unknown) => unknown = () => undefined;

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    return Promise.resolve({ ok: true as const, value: answer(method, args) });
  },
  unwrapIpcResult: (result: { ok: boolean; value?: unknown; message?: string }) => {
    if (!result.ok) throw new Error(result.message);
    return result.value;
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

import {
  deleteClaudeSession,
  withTranscriptSizes,
} from "../../../../../src/renderer/services/chat/sessions";

beforeEach(() => {
  ipcCalls.length = 0;
  answer = () => undefined;
});

describe("deleting a Claude session", () => {
  test("asks the agent of the workspace, in the profile that keeps it", async () => {
    answer = () => ({ deleted: true });
    await deleteClaudeSession("ws-1", "/home/me/app", {
      sessionId: "11111111-1111-4111-8111-111111111111",
      profileId: "work",
    });
    expect(ipcCalls).toEqual([
      {
        channel: "chat",
        method: "deleteSession",
        args: {
          workspaceId: "ws-1",
          cwd: "/home/me/app",
          sessionId: "11111111-1111-4111-8111-111111111111",
          profileId: "work",
        },
      },
    ]);
  });

  test("one already gone is as good as deleted", async () => {
    answer = () => ({ deleted: false });
    await expect(
      deleteClaudeSession("ws-1", "/home/me/app", { sessionId: "gone-session", profileId: "p" }),
    ).resolves.toBeUndefined();
  });
});

describe("transcript sizes", () => {
  test("filled in by path, for the sessions that have one and no size yet", async () => {
    answer = () => ({ "/c/a.jsonl": 2048 });
    const sized = await withTranscriptSizes("ws-1", [
      { sessionId: "a", path: "/c/a.jsonl" },
      { sessionId: "b", path: "/c/b.jsonl" },
      { sessionId: "c", size: 5 },
    ]);
    expect(ipcCalls).toEqual([
      {
        channel: "chat",
        method: "fileSizes",
        args: { workspaceId: "ws-1", paths: ["/c/a.jsonl", "/c/b.jsonl"] },
      },
    ]);
    expect(sized).toEqual([
      { sessionId: "a", path: "/c/a.jsonl", size: 2048 },
      { sessionId: "b", path: "/c/b.jsonl" },
      { sessionId: "c", size: 5 },
    ]);
  });

  test("nothing asked when no session has a path", async () => {
    const sessions = [{ sessionId: "a", size: 1 }];
    expect(await withTranscriptSizes("ws-1", sessions)).toEqual(sessions);
    expect(ipcCalls).toEqual([]);
  });
});
