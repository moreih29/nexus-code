import { describe, expect, it, mock } from "bun:test";
import { LocalFsProvider } from "../../../../src/main/features/fs/bridge/local-provider";
import type { AgentChannel } from "../../../../src/main/infra/agent/channel/channel";

function makeChannel(resultFor: (method: string, params?: unknown) => unknown): AgentChannel {
  return {
    ready: Promise.resolve(),
    call: mock(async (method: string, params?: unknown) => resultFor(method, params)),
    on: mock(() => () => {}),
    onLifecycle: mock(() => () => {}),
    dispose: mock(() => {}),
  };
}

describe("LocalFsProvider", () => {
  it("starts one local agent lazily and delegates workspace fs calls to it", async () => {
    const channel = makeChannel((method) => {
      if (method === "fs.readdir") return [{ name: "src", type: "dir" }];
      if (method === "fs.stat") {
        return { type: "file", size: 7, mtime: "2026-01-01T00:00:00.000Z", isSymlink: false };
      }
      return {
        kind: "ok",
        content: "hello\n",
        encoding: "utf8",
        sizeBytes: 6,
        isBinary: false,
        mtime: "2026-01-01T00:00:00.000Z",
      };
    });
    const createChannel = mock(() => channel);
    const provider = new LocalFsProvider("/workspace", {
      createChannel,
      resolveCommand: () => ({ binaryPath: "/bin/agent" }),
    });

    await expect(provider.readdir(".")).resolves.toEqual([{ name: "src", type: "dir" }]);
    await expect(provider.stat("README.md")).resolves.toMatchObject({ size: 7 });
    await expect(provider.readFile("README.md")).resolves.toMatchObject({ content: "hello\n" });
    await expect(provider.readAbsolute("/external/lib.ts")).resolves.toMatchObject({
      content: "hello\n",
    });

    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).toHaveBeenCalledWith({
      binaryPath: "/bin/agent",
      rootPath: "/workspace",
    });
    expect(channel.call).toHaveBeenCalledWith("fs.readdir", { relPath: "." });
    expect(channel.call).toHaveBeenCalledWith("fs.stat", { relPath: "README.md" });
    expect(channel.call).toHaveBeenCalledWith("fs.readFile", { relPath: "README.md" });
    expect(channel.call).toHaveBeenCalledWith("fs.readAbsolute", {
      absolutePath: "/external/lib.ts",
    });
  });

  it("delegates mutations through the same local agent channel", async () => {
    const channel = makeChannel((method) => {
      if (method === "fs.writeFile") {
        return { kind: "ok", mtime: "2026-01-01T00:00:00.000Z", size: 5 };
      }
      return {};
    });
    const provider = new LocalFsProvider("/workspace", {
      createChannel: () => channel,
      resolveCommand: () => ({ binaryPath: "/bin/agent" }),
    });

    await expect(provider.writeFile("a.txt", "hello", { exists: false })).resolves.toMatchObject({
      kind: "ok",
      size: 5,
    });
    await expect(provider.createFile("b.txt")).resolves.toBeUndefined();
    await expect(provider.mkdir("src")).resolves.toBeUndefined();

    expect(channel.call).toHaveBeenCalledWith("fs.writeFile", {
      relPath: "a.txt",
      content: "hello",
      expected: { exists: false },
    });
    expect(channel.call).toHaveBeenCalledWith("fs.createFile", { relPath: "b.txt" });
    expect(channel.call).toHaveBeenCalledWith("fs.mkdir", { relPath: "src" });
  });

  it("disposes the owned local agent channel", async () => {
    const channel = makeChannel(() => []);
    const provider = new LocalFsProvider("/workspace", {
      createChannel: () => channel,
      resolveCommand: () => ({ binaryPath: "/bin/agent" }),
    });

    await provider.readdir(".");
    provider.dispose();

    expect(channel.dispose).toHaveBeenCalledTimes(1);
  });
});
