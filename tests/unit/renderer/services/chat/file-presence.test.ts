/**
 * File presence — a path a reply only guessed at is a file once the
 * workspace has it; each lookup is shared and kept a while.
 */
import { describe, expect, it } from "bun:test";
import {
  createFilePresence,
  lookupPath,
  resultFilesThere,
} from "../../../../../src/renderer/services/chat/file-presence";

describe("lookupPath", () => {
  it("is the path under the workspace root", () => {
    expect(lookupPath("/p/build/notes.json", "/p")).toBe("build/notes.json");
    expect(lookupPath("/p/system.stats", "/p/")).toBe("system.stats");
  });

  it("is null outside the root, and for the root itself", () => {
    expect(lookupPath("/q/v0.17.0", "/p")).toBeNull();
    expect(lookupPath("/p", "/p")).toBeNull();
    expect(lookupPath("/p/a.ts", "")).toBeNull();
  });
});

describe("createFilePresence", () => {
  function setup(files: readonly string[]) {
    const asked: string[] = [];
    let clock = 0;
    const presence = createFilePresence(
      async (_workspaceId, relPath) => {
        asked.push(relPath);
        return files.includes(relPath);
      },
      () => clock,
    );
    return {
      presence,
      asked,
      tick: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("finds the files the workspace has, and no others", async () => {
    const { presence } = setup(["package.json"]);
    expect(await presence.isThere("ws", "/p", "/p/package.json")).toBe(true);
    expect(await presence.isThere("ws", "/p", "/p/system.stats")).toBe(false);
    expect(await presence.isThere("ws", "/p", "/q/package.json")).toBe(false);
  });

  it("asks once for lookups at the same time, and keeps the answer a while", async () => {
    const { presence, asked, tick } = setup(["a.ts"]);
    const both = await Promise.all([
      presence.isThere("ws", "/p", "/p/a.ts"),
      presence.isThere("ws", "/p", "/p/a.ts"),
    ]);
    expect(both).toEqual([true, true]);
    expect(asked).toEqual(["a.ts"]);
    expect(presence.known("ws", "/p/a.ts")).toBe(true);

    tick(10_000);
    await presence.isThere("ws", "/p", "/p/a.ts");
    expect(asked).toEqual(["a.ts"]);

    tick(30_000);
    expect(presence.known("ws", "/p/a.ts")).toBeUndefined();
    await presence.isThere("ws", "/p", "/p/a.ts");
    expect(asked).toEqual(["a.ts", "a.ts"]);
  });

  it("looks a file not found up again, as the agent may make it", async () => {
    const files: string[] = [];
    const asked: string[] = [];
    const presence = createFilePresence(async (_workspaceId, relPath) => {
      asked.push(relPath);
      return files.includes(relPath);
    });
    expect(await presence.isThere("ws", "/p", "/p/x.sh")).toBe(false);
    expect(presence.known("ws", "/p/x.sh")).toBeUndefined();
    files.push("x.sh");
    expect(await presence.isThere("ws", "/p", "/p/x.sh")).toBe(true);
    expect(asked).toEqual(["x.sh", "x.sh"]);
  });

  it("keeps workspaces apart", async () => {
    const { presence, asked } = setup(["a.ts"]);
    await presence.isThere("one", "/p", "/p/a.ts");
    await presence.isThere("two", "/p", "/p/a.ts");
    expect(asked).toEqual(["a.ts", "a.ts"]);
  });

  it("takes a failed lookup for no file", async () => {
    const presence = createFilePresence(async () => {
      throw new Error("disconnected");
    });
    expect(await presence.isThere("ws", "/p", "/p/a.ts")).toBe(false);
  });
});

describe("resultFilesThere", () => {
  it("keeps the files named for sure, and a guessed one only once it is there", async () => {
    const asked: string[] = [];
    const files = await resultFilesThere(
      [
        { kind: "file", target: "src/a.ts", created: false, guessed: true },
        { kind: "url", target: "https://example.com", created: false, guessed: false },
        { kind: "file", target: "v0.17.0", created: false, guessed: true },
        { kind: "file", target: "/p/b.md", created: false, guessed: false },
      ],
      "/p",
      async (path) => {
        asked.push(path);
        return path === "/p/src/a.ts";
      },
    );
    expect(files).toEqual(["/p/src/a.ts", "/p/b.md"]);
    expect(asked).toEqual(["/p/src/a.ts", "/p/v0.17.0"]);
  });
});
