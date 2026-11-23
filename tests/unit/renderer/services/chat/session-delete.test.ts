import { beforeEach, describe, expect, mock, test } from "bun:test";

const ipcCalls: Array<{ channel: string; method: string; args: unknown }> = [];
let answer: (method: string, args: unknown) => unknown = () => undefined;

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: async (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    return { ok: true as const, value: await answer(method, args) };
  },
  unwrapIpcResult: (result: { ok: boolean; value?: unknown; message?: string }) => {
    if (!result.ok) throw new Error(result.message);
    return result.value;
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

import { deleteClaudeSession } from "../../../../../src/renderer/services/chat/claude/sessions";
import { withTranscriptSizes } from "../../../../../src/renderer/services/chat/sessions";

beforeEach(() => {
  ipcCalls.length = 0;
  answer = () => undefined;
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const ROOT = "/home/me/.nexus-code/attach";
const user = (uuid: string, content: string) => ({
  type: "user",
  uuid,
  timestamp: "2026-11-10T13:52:27.980Z",
  message: { role: "user", content },
});

describe("deleting a Claude session", () => {
  test("asks the agent of the workspace, in the profile that keeps it", async () => {
    answer = (method) =>
      method === "transcript" ? { found: false, lines: [] } : { deleted: true };
    await deleteClaudeSession("ws-1", "/home/me/app", {
      sessionId: "11111111-1111-4111-8111-111111111111",
      profileId: "work",
    });
    expect(ipcCalls).toEqual([
      {
        channel: "chat",
        method: "transcript",
        args: {
          workspaceId: "ws-1",
          sessionId: "11111111-1111-4111-8111-111111111111",
          profileId: "work",
        },
      },
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

  test("the files its messages attached go after it, read before it goes", async () => {
    const root = ROOT;
    answer = (method) => {
      if (method === "transcript")
        return {
          found: true,
          lines: [
            user("u1", `look\n\n@${root}/ws-1/t1/1/a.txt @/home/me/elsewhere.txt`),
            user("u2", `and\n\n@${root}/ws-1/t2/4/b.png`),
          ],
        };
      if (method === "attachRoot") return { root };
      return { deleted: true };
    };
    await deleteClaudeSession("ws-1", "/home/me/app", { sessionId: "s", profileId: "p" });
    await settled();
    expect(ipcCalls.map((call) => call.method)).toEqual([
      "transcript",
      "deleteSession",
      "attachRoot",
      "removeAttachments",
    ]);
    expect(ipcCalls.at(-1)?.args).toEqual({ workspaceId: "ws-1", slots: ["t1/1", "t2/4"] });
  });

  test("it is deleted without waiting while the agent looks for other conversations naming its files", async () => {
    let release = () => {};
    const looking = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = (method) => {
      if (method === "transcript")
        return { found: true, lines: [user("u1", `look\n\n@${ROOT}/ws-1/t1/1/a.txt`)] };
      if (method === "attachRoot") return { root: ROOT };
      if (method === "removeAttachments") return looking;
      return { deleted: true };
    };
    await deleteClaudeSession("ws-1", "/home/me/app", { sessionId: "s", profileId: "p" });
    await settled();
    expect(ipcCalls.at(-1)?.method).toBe("removeAttachments");
    release();
  });

  test("files left by a removal that fails are only logged", async () => {
    answer = (method) => {
      if (method === "transcript")
        return { found: true, lines: [user("u1", `look\n\n@${ROOT}/ws-1/t1/1/a.txt`)] };
      if (method === "attachRoot") return { root: ROOT };
      if (method === "removeAttachments")
        return Promise.reject(new Error("a history was not read"));
      return { deleted: true };
    };
    await deleteClaudeSession("ws-1", "/home/me/app", { sessionId: "s", profileId: "p" });
    await settled();
    expect(ipcCalls.at(-1)?.method).toBe("removeAttachments");
  });

  test("a transcript that cannot be read still deletes, and removes no file", async () => {
    answer = (method) => {
      if (method === "transcript") throw new Error("offline");
      return { deleted: true };
    };
    await deleteClaudeSession("ws-1", "/home/me/app", { sessionId: "s", profileId: "p" });
    expect(ipcCalls.map((call) => call.method)).toEqual(["transcript", "deleteSession"]);
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
