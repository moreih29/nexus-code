import { describe, expect, it } from "bun:test";
import {
  createFilePresence,
  filesFound,
  filesGone,
  lookupPath,
} from "../../../../../src/renderer/services/chat/file-presence";

describe("lookupPath", () => {
  it("is the path under the workspace root", () => {
    expect(lookupPath("/p/build/notes.json", "/p")).toBe("build/notes.json");
    expect(lookupPath("/p/system.stats", "/p/")).toBe("system.stats");
  });

  it("is the path under a Windows root, however it ends", () => {
    expect(lookupPath("C:/w/src/a.ts", "C:\\w")).toBe("src/a.ts");
    expect(lookupPath("C:/src/a.ts", "C:\\")).toBe("src/a.ts");
    expect(lookupPath("c:/W/a.ts", "C:\\w\\")).toBe("a.ts");
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

  it("looks a file outside the workspace up by its path once a tab granted it", async () => {
    const asked: string[] = [];
    const granted = new Set(["/tmp/shot.png", "/dev/shm"]);
    const presence = createFilePresence(
      async (_workspaceId, path) => {
        asked.push(path);
        return path === "/tmp/shot.png";
      },
      Date.now,
      (_workspaceId, path) => granted.has(path),
    );
    expect(await presence.isThere("ws", "/p", "/tmp/shot.png")).toBe(true);
    expect(await presence.isThere("ws", "/p", "/dev/shm")).toBe(false);
    expect(await presence.isThere("ws", "/p", "/etc/hosts")).toBe(false);
    expect(await presence.isThere("ws", "C:\\w", "D:/out/log.txt")).toBe(false);
    expect(asked).toEqual(["/tmp/shot.png", "/dev/shm"]);
  });

  it("looks a Windows file outside the workspace up by its path from the drive", async () => {
    const output = String.raw`C:\Temp\claude\tasks\b1.output`;
    const granted = new Set(["D:/out/shot.png", output]);
    const asked: string[] = [];
    const presence = createFilePresence(
      async (_workspaceId, path) => {
        asked.push(path);
        return true;
      },
      Date.now,
      (_workspaceId, path) => granted.has(path),
    );
    expect(await presence.isThere("ws", "C:\\w", "D:/out/shot.png")).toBe(true);
    expect(await presence.isThere("ws", "C:\\w", output)).toBe(true);
    expect(asked).toEqual(["D:/out/shot.png", output]);
  });
});

describe("filesFound", () => {
  it("looks up so many at once, however many there are, and keeps their order", async () => {
    let going = 0;
    let most = 0;
    const presence = createFilePresence(async (_workspaceId, relPath) => {
      going++;
      most = Math.max(most, going);
      await new Promise((resolve) => setTimeout(resolve, 1));
      going--;
      return !relPath.endsWith("gone.png");
    });
    const paths = Array.from({ length: 50 }, (_, i) => `/p/${i}${i % 7 === 0 ? "gone" : ""}.png`);
    const found = await filesFound(presence, "ws", "/p", paths, 8);
    expect(most).toBe(8);
    expect([...found]).toEqual(paths.filter((path) => !path.endsWith("gone.png")));
    expect(await filesFound(presence, "ws", "/p", [], 8)).toEqual(new Set());
  });
});

describe("filesGone", () => {
  it("is what was looked up and not found, not what cannot be looked up yet", async () => {
    const granted = new Set(["/h/attach/w/c/1/kept.png", "/h/attach/w/old/1/removed.png"]);
    const grantedCheck = (_workspaceId: string, path: string) => granted.has(path);
    const presence = createFilePresence(
      async (_workspaceId, relPath) =>
        relPath === "/h/attach/w/c/1/kept.png" || relPath === "in.png",
      () => 0,
      grantedCheck,
    );
    const paths = [
      "/h/attach/w/c/1/kept.png",
      "/h/attach/w/old/1/removed.png",
      "/p/in.png",
      "/p/gone.png",
      "/h/attach/w/c/2/new.png",
    ];
    const gone = await filesGone(presence, "w", "/p", paths, grantedCheck);
    expect([...gone]).toEqual(["/h/attach/w/old/1/removed.png", "/p/gone.png"]);
  });
});
