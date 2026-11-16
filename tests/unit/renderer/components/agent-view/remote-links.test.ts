import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { beforeOfHunks, peerChatFiles, peerImageLoader } = await import(
  "../../../../../src/renderer/components/agent-view/remote-links"
);
const { shownPath } = await import("../../../../../src/renderer/utils/path");
const { rateLimitOf } = await import(
  "../../../../../src/renderer/components/agent-view/remote-usage"
);
const { senderOf } = await import("../../../../../src/renderer/services/remote/chat-model");
const { folderOf } = await import("../../../../../src/renderer/components/chat/answer-extras");

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
let answer: (method: string, args: Record<string, unknown>) => unknown = () => ({});
const globals = globalThis as Record<string, unknown>;
let saved: unknown;

beforeEach(() => {
  calls.length = 0;
  saved = globals.window;
  globals.window = {
    ...((saved as object | undefined) ?? {}),
    ipc: {
      call: async (_channel: string, method: string, args: Record<string, unknown>) => {
        calls.push({ method, args });
        return answer(method, args);
      },
      cancel: () => {},
    },
  };
});

afterEach(() => {
  globals.window = saved;
});

const panel = {
  todos: [],
  tasks: [],
  agents: [],
  changedFiles: [],
  context: null,
  goal: null,
};

describe("another computer's chat, read from there", () => {
  test("a file the conversation names is there when its folder lists it", async () => {
    answer = (method, args) =>
      method === "peerFilesList" && args.path === "/w/src"
        ? {
            path: "/w/src",
            entries: [
              { name: "a.ts", kind: "file" },
              { name: "lib", kind: "dir" },
            ],
          }
        : Promise.reject(new Error("outside the workspace"));
    const files = peerChatFiles({ deviceId: "d1", workspaceId: "w1" });
    const found = await files.there(["/w/src/a.ts", "/w/src/lib", "/w/src/gone.ts", "/etc/x"]);
    expect([...found]).toEqual(["/w/src/a.ts"]);
    // Each folder is listed once while its entries are fresh.
    await files.there(["/w/src/a.ts"]);
    expect(calls.filter((c) => c.args.path === "/w/src")).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ deviceId: "d1", workspaceId: "w1", path: "/w/src" });
  });

  test("a Windows path is split at its backslashes", async () => {
    answer = () => ({ path: "C:\\w", entries: [{ name: "a.png", kind: "file" }] });
    const files = peerChatFiles({ deviceId: "d1", workspaceId: "w1" });
    expect([...(await files.there(["C:\\w\\a.png"]))]).toEqual(["C:\\w\\a.png"]);
    expect(calls[0]?.args.path).toBe("C:\\w");
  });

  test("an image file's picture comes once; a file that is not an image has none", async () => {
    answer = (_method, args) =>
      args.path === "/w/a.png"
        ? { kind: "image", path: "/w/a.png", mediaType: "image/png", data: "AAA", size: 3 }
        : { kind: "text", path: "/w/a.txt", text: "hi", size: 2, truncated: false };
    const files = peerChatFiles({ deviceId: "d1", workspaceId: "w1" });
    expect(await files.picture("/w/a.png")).toEqual({ mediaType: "image/png", data: "AAA" });
    await files.picture("/w/a.png");
    expect(calls).toHaveLength(1);
    await expect(files.picture("/w/a.txt")).rejects.toThrow();
  });

  test("a message's image is fetched by its place there, once, small enough to look at", async () => {
    answer = () => ({ mediaType: "image/jpeg", data: "BBB" });
    const load = peerImageLoader({ deviceId: "d1", workspaceId: "w1", tabId: "t1" });
    const image = {
      mediaType: "image/jpeg",
      data: "",
      remote: { kind: "user" as const, itemKey: "u-1", index: 0 },
    };
    expect(await load(image)).toEqual({ mediaType: "image/jpeg", data: "BBB" });
    await load(image);
    expect(calls).toEqual([
      {
        method: "peerChatImage",
        args: {
          deviceId: "d1",
          workspaceId: "w1",
          tabId: "t1",
          maxEdge: 2048,
          ref: { kind: "user", itemKey: "u-1", index: 0 },
        },
      },
    ]);
    // One with its bytes already is as it is.
    const here = { mediaType: "image/png", data: "CCC" };
    expect(await load(here)).toBe(here);
  });

  test("a change's file before it is the hunks against the last commit taken back", () => {
    // a b d (committed) became a c d e: b changed to c, e added at the end.
    const hunks = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+c", " d"] },
      { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1, lines: ["+e"] },
    ];
    expect(beforeOfHunks(hunks, "a\nc\nd\ne\n")).toBe("a\nb\nd\n");
    // A line taken out comes back where it was.
    expect(
      beforeOfHunks(
        [{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 0, lines: ["-x"] }],
        "a\nb",
      ),
    ).toBe("a\nx\nb");
    // Hunks that do not fit the file now (it changed since) give nothing.
    expect(beforeOfHunks(hunks, "z\ny\n")).toBeNull();
  });
});

describe("a Windows computer's paths, written with either separator", () => {
  test("are named from the conversation's folder", () => {
    expect(shownPath("C:/Users/me/app/README.md", "C:\\Users\\me\\app")).toBe("README.md");
    expect(shownPath("C:\\Users\\me\\app\\src\\a.ts", "C:\\Users\\me\\app\\")).toBe("src/a.ts");
    expect(shownPath("/Users/me/app/src/a.ts", "/Users/me/app")).toBe("src/a.ts");
    // Outside it, as written.
    expect(shownPath("D:\\other\\b.ts", "C:\\Users\\me\\app")).toBe("D:\\other\\b.ts");
  });

  test("a file card's folder is from there too", () => {
    expect(folderOf("C:/Users/me/app/README.md", "C:\\Users\\me\\app")).toBe("");
    expect(folderOf("C:\\Users\\me\\app\\docs\\a.md", "C:\\Users\\me\\app")).toBe("docs");
    expect(folderOf("/Users/me/app/docs/a.md", "/Users/me/app/")).toBe("docs");
  });
});

describe("what another computer's chat tells of its plan and senders", () => {
  test("a full meter is the limit reached, until its window starts over", () => {
    expect(rateLimitOf(undefined)).toBeUndefined();
    const limits = [
      { kind: "session", percent: 100, resetsAt: 5_000_000 },
      { kind: "weekly", percent: 70, resetsAt: 9_000_000 },
    ];
    expect(rateLimitOf({ ...panel, planLimits: limits }, 1_000)).toEqual({
      status: "rejected",
      rateLimitType: "session",
      resetsAt: 5_000,
    });
    expect(rateLimitOf({ ...panel, planLimits: limits }, 6_000_000)).toBeUndefined();
    expect(rateLimitOf({ ...panel, planLimits: [limits[1]!] }, 1_000)).toBeUndefined();
  });

  test("from 0.11.0, the program's own word: near the limit too, until its window starts over", () => {
    const told = {
      ...panel,
      rateLimit: { status: "allowed_warning", resetsAt: 5_000_000, kind: "five_hour" },
      planLimits: [{ kind: "session", percent: 100, resetsAt: 9_000_000 }],
    };
    expect(rateLimitOf(told, 1_000)).toEqual({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      resetsAt: 5_000,
    });
    expect(rateLimitOf(told, 6_000_000)).toBeUndefined();
  });

  test("a tab there that sent a message is named with its computer", () => {
    const source = { deviceId: "pc", deviceName: "Work PC", selfId: "mac" };
    expect(
      senderOf(
        { kind: "tab", name: "fix", agent: "claude", replyTo: { workspaceId: "w", tabId: "t" } },
        source,
      ),
    ).toEqual({
      kind: "tab",
      name: "fix",
      agent: "claude",
      workspaceId: "w",
      tabId: "t",
      device: { id: "pc", name: "Work PC" },
    });
  });

  test("one of this computer's tabs is this computer's, and a third computer's its own", () => {
    const source = { deviceId: "pc", deviceName: "Work PC", selfId: "mac" };
    expect(
      senderOf(
        {
          kind: "tab",
          name: "mine",
          device: { id: "mac", name: "MacBook" },
          replyTo: { deviceId: "mac", workspaceId: "w", tabId: "t" },
        },
        source,
      ),
    ).toEqual({ kind: "tab", name: "mine", workspaceId: "w", tabId: "t" });
    expect(
      senderOf(
        {
          kind: "tab",
          device: { id: "lap", name: "Laptop" },
          replyTo: { deviceId: "lap", workspaceId: "w", tabId: "t" },
        },
        source,
      ),
    ).toEqual({ kind: "tab", workspaceId: "w", tabId: "t", device: { id: "lap", name: "Laptop" } });
    // Without knowing which computer this is, a sender stays as told.
    expect(senderOf({ kind: "manager" })).toEqual({ kind: "manager" });
  });
});
