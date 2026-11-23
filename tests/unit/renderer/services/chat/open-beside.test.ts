import { describe, expect, mock, test } from "bun:test";

const files = new Set(["notes/a.ts:12", "src/a.ts", "tracks/P/out/a.png", "tracks/P/b.ts:3"]);
const stats: string[] = [];
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, _method: string, args: { relPath: string }) => {
    if (channel !== "fs") return Promise.resolve({ ok: true as const, value: undefined });
    stats.push(args.relPath);
    return Promise.resolve(
      files.has(args.relPath)
        ? { ok: true as const, value: { size: 1, mtime: 0, type: "file" } }
        : { ok: false as const, error: { code: "ENOENT" } },
    );
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

const { fileLinkTarget, followFileLink } = await import(
  "../../../../../src/renderer/services/chat/open-beside"
);
const { resolveFileLink } = await import("../../../../../src/renderer/services/chat/links");
const { linkPlaceIndex } = await import("../../../../../src/renderer/services/chat/link-places");

const target = (href: string) => {
  const link = resolveFileLink(href, "/w");
  if (!link) throw new Error(`no link: ${href}`);
  return fileLinkTarget("ws", "/w", link);
};

describe("the file a line link opens", () => {
  test("a file named with the colon is the one meant, when there is one", async () => {
    expect(await target("notes/a.ts:12")).toEqual({ path: "/w/notes/a.ts:12" });
  });

  test("otherwise the file before the colon, at the line", async () => {
    expect(await target("src/a.ts:12:3")).toEqual({
      path: "/w/src/a.ts",
      line: 12,
      column: 3,
      literal: "/w/src/a.ts:12:3",
    });
  });

  test("nothing is looked up for a link without a line, or one outside the workspace", async () => {
    stats.length = 0;
    expect(await target("src/a.ts")).toEqual({ path: "/w/src/a.ts" });
    expect(await target("/elsewhere/b.ts:4")).toMatchObject({ path: "/elsewhere/b.ts", line: 4 });
    expect(stats).toEqual([]);
  });
});

describe("the file a link written from where the agent's shell went opens", () => {
  const places = linkPlaceIndex(
    { b: { input: { command: "cd /w/tracks/P && python run.py" } } },
    "/w",
  );
  const follow = (href: string) => followFileLink("ws", "/w", href, places);

  test("the file where the shell went, when the chat's folder has none", async () => {
    expect(await follow("out/a.png")).toEqual({ path: "/w/tracks/P/out/a.png" });
  });

  test("the chat's folder's own file first", async () => {
    expect(await follow("src/a.ts:7")).toMatchObject({ path: "/w/src/a.ts", line: 7 });
  });

  test("a file named with its colon there, too", async () => {
    expect(await follow("b.ts:3")).toEqual({ path: "/w/tracks/P/b.ts:3" });
  });

  test("the chat's folder's when no place has it", async () => {
    expect(await follow("gone.png")).toEqual({ path: "/w/gone.png" });
    expect(await follow("https://example.com")).toBeNull();
  });
});
