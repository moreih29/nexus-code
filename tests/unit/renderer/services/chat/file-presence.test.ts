import { describe, expect, it } from "bun:test";
import {
  createFilePresence,
  filesFound,
  filesGone,
  lookupPath,
  pathToLookUp,
} from "../../../../../src/renderer/services/chat/file-presence";
import { resolveFilePath } from "../../../../../src/renderer/services/chat/links";

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

  it("looks a file outside the workspace up by its path, granted or not", async () => {
    const asked: string[] = [];
    const presence = createFilePresence(async (_workspaceId, path) => {
      asked.push(path);
      return path === "/tmp/shot.png";
    });
    expect(await presence.isThere("ws", "/p", "/tmp/shot.png")).toBe(true);
    expect(await presence.isThere("ws", "/p", "/etc/hosts")).toBe(false);
    expect(await presence.isThere("ws", "C:\\w", "D:/out/log.txt")).toBe(false);
    expect(asked).toEqual(["/tmp/shot.png", "/etc/hosts", "D:/out/log.txt"]);
  });

  it("never looks up a network share or device path an answer names", async () => {
    const asked: string[] = [];
    const presence = createFilePresence(async (_workspaceId, path) => {
      asked.push(path);
      return true;
    });
    for (const path of ["//evil.test/share/a.png", "\\\\evil.test\\share\\a.png", "\\\\?\\C:\\a"]) {
      expect(await presence.isThere("ws", "C:\\w", path)).toBe(false);
    }
    expect(asked).toEqual([]);
  });

  it("looks a Windows file outside the workspace up by its path from the drive", async () => {
    const output = String.raw`C:\Temp\claude\tasks\b1.output`;
    const asked: string[] = [];
    const presence = createFilePresence(async (_workspaceId, path) => {
      asked.push(path);
      return true;
    });
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
  it("is what was looked up and not found", async () => {
    const presence = createFilePresence(
      async (_workspaceId, relPath) =>
        relPath === "/h/attach/w/c/1/kept.png" || relPath === "in.png",
      () => 0,
    );
    const paths = [
      "/h/attach/w/c/1/kept.png",
      "/h/attach/w/old/1/removed.png",
      "/p/in.png",
      "/p/gone.png",
      "//share/x/a.png",
    ];
    const gone = await filesGone(presence, "w", "/p", paths);
    expect([...gone]).toEqual(["/h/attach/w/old/1/removed.png", "/p/gone.png"]);
  });
});

describe("pathToLookUp", () => {
  const ROOTS = ["C:/w", "//nas/share/w", "/p"];
  const UNREACHABLE = [
    String.raw`\??\UNC\127.0.0.1\qa-none-46\a.txt`,
    "/??/UNC/127.0.0.1/qa-none-46/a.txt",
    String.raw`\??\C:\tmp\a.txt`,
    String.raw`\\?\UNC\s\sh\a.txt`,
    String.raw`\\.\C:\a.txt`,
    String.raw`\\s\sh\a.txt`,
    "//s/sh/a.txt",
    String.raw`/\s\sh\a.txt`,
  ];

  it("looks up no share or device path under any root", () => {
    for (const root of ROOTS) {
      for (const path of UNREACHABLE) {
        expect([root, path, pathToLookUp(path, root)]).toEqual([root, path, null]);
      }
    }
  });

  it("looks up no share an answer link names in percent-encoding", () => {
    for (const link of [
      "/%3F%3F/UNC/127.0.0.1/qa-none-46/a.txt",
      "file:///%3F%3F/UNC/127.0.0.1/qa-none-46/a.txt",
      "%5C%3F%3F%5CUNC%5C127.0.0.1%5Cqa-none-46%5Ca.txt",
    ]) {
      const path = resolveFilePath(link, "C:/w");
      expect([link, path === null || pathToLookUp(path, "C:/w") === null]).toEqual([link, true]);
    }
  });

  it("looks up a path inside a share root in that workspace, but no device form of it", () => {
    expect(pathToLookUp("//nas/share/w/src/a.ts", "//nas/share/w")).toBe("src/a.ts");
    expect(pathToLookUp("//nas/share/w/src/a.ts", String.raw`\\nas\share\w`)).toBe("src/a.ts");
    expect(pathToLookUp("//nas/share/other/a.ts", "//nas/share/w")).toBeNull();
    expect(pathToLookUp(String.raw`\\?\UNC\nas\share\w\a.ts`, "//nas/share/w")).toBeNull();
    expect(pathToLookUp(String.raw`\\?\C:\w\a.ts`, String.raw`\\?\C:\w`)).toBeNull();
    expect(pathToLookUp("/??/UNC/nas/share/w/a.ts", "/??/UNC/nas/share/w")).toBeNull();
  });

  it("looks up only drive paths outside a Windows root, and rooted paths outside a POSIX one", () => {
    expect(pathToLookUp("D:/out/a.txt", "C:/w")).toBe("D:/out/a.txt");
    expect(pathToLookUp("/out/a.txt", "C:/w")).toBeNull();
    expect(pathToLookUp("/out/a.txt", "//nas/share/w")).toBeNull();
    expect(pathToLookUp("/out/a.txt", "/p")).toBe("/out/a.txt");
    expect(pathToLookUp("C:/w/src/a.ts", "C:/w")).toBe("src/a.ts");
  });

  it("never asks about a share or device path", async () => {
    const asked: string[] = [];
    const presence = createFilePresence(async (_workspaceId, relPath) => {
      asked.push(relPath);
      return true;
    });
    for (const path of UNREACHABLE) expect(await presence.isThere("ws", "C:/w", path)).toBe(false);
    expect(await presence.isThere("ws", "C:/w", "D:/out/a.txt")).toBe(true);
    expect(asked).toEqual(["D:/out/a.txt"]);
  });
});

describe("automount paths", () => {
  it("are never looked up on their own", async () => {
    const asked: string[] = [];
    const presence = createFilePresence(async (_workspaceId, relPath) => {
      asked.push(relPath);
      return true;
    });
    for (const path of [
      "/net/host/share/a.txt",
      "/Network/Servers/host/a.txt",
      "/tmp/../net/host/a.txt",
    ]) {
      expect(pathToLookUp(path, "/p")).toBeNull();
      expect(await presence.isThere("ws", "/p", path)).toBe(false);
    }
    expect(await presence.isThere("ws", "/p", "/tmp/a.txt")).toBe(true);
    expect(asked).toEqual(["/tmp/a.txt"]);
  });

  it("inside a workspace root under one, are looked up in the workspace", () => {
    expect(pathToLookUp("/net/host/w/src/a.ts", "/net/host/w")).toBe("src/a.ts");
  });

  it("are not counted as gone", async () => {
    const presence = createFilePresence(async () => false);
    expect(await filesGone(presence, "ws", "/p", ["/net/host/a.txt", "/tmp/a.txt"])).toEqual(
      new Set(["/tmp/a.txt"]),
    );
  });
});
