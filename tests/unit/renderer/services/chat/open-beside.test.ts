import { describe, expect, mock, test } from "bun:test";

// The workspace's files, by their path from its root.
const files = new Set(["notes/a.ts:12", "src/a.ts"]);
const stats: string[] = [];
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (_channel: string, _method: string, args: { relPath: string }) => {
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

const { fileLinkTarget } = await import("../../../../../src/renderer/services/chat/open-beside");
const { resolveFileLink } = await import("../../../../../src/renderer/services/chat/links");

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
