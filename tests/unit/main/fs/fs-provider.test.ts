import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFsProvider } from "../../../../src/main/fs/provider/factory";
import { LocalFsProvider } from "../../../../src/main/fs/provider/local/local-fs-provider";
import type { SshChannel } from "../../../../src/main/transport/ssh-channel";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nexus-fs-provider-"));
});

afterEach(async () => {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Builds workspace metadata for fs provider factory tests.
 */
function makeMeta(location: WorkspaceMeta["location"]): WorkspaceMeta {
  return {
    id: "123e4567-e89b-12d3-a456-426614174000",
    name: "workspace",
    location,
    rootPath: location.kind === "local" ? location.rootPath : location.remotePath,
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

describe("LocalFsProvider", () => {
  it("reads workspace-relative files through the read core", async () => {
    const provider = new LocalFsProvider(tmpRoot);
    const content = "export const x = 1;\n";
    await fs.promises.writeFile(path.join(tmpRoot, "index.ts"), content, "utf8");

    const result = await provider.readFile("index.ts");

    expect(provider.kind).toBe("local");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.content).toBe(content);
  });

  it("rejects traversal outside the workspace root", async () => {
    const provider = new LocalFsProvider(tmpRoot);

    await expect(provider.stat("../outside.txt")).rejects.toThrow("path escapes workspace root");
  });
});

describe("createFsProvider", () => {
  it("creates a local provider for local workspace metadata", () => {
    const provider = createFsProvider(makeMeta({ kind: "local", rootPath: tmpRoot }));

    expect(provider.kind).toBe("local");
  });

  it("creates an ssh provider stub for ssh workspace metadata", async () => {
    let provider: ReturnType<typeof createFsProvider> | undefined;

    expect(() => {
      provider = createFsProvider(
        makeMeta({ kind: "ssh", host: "dev.example.com", remotePath: "/srv/repo" }),
      );
    }).not.toThrow();

    if (!provider) {
      throw new Error("expected ssh provider");
    }
    expect(provider.kind).toBe("ssh");
    await expect(provider.readdir("")).rejects.toThrow("ssh fs provider: channel not yet wired");
  });

  it("creates an ssh provider that delegates reads through the supplied channel", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const channel: SshChannel = {
      ready: Promise.resolve(),
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "fs.readdir") {
          return [{ name: "src", type: "dir" }];
        }
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
      },
      on: () => () => {},
      onLifecycle: () => () => {},
      dispose: () => {},
    };
    const provider = createFsProvider(
      makeMeta({ kind: "ssh", host: "dev.example.com", remotePath: "/srv/repo" }),
      channel,
    );

    await expect(provider.readdir(".")).resolves.toEqual([{ name: "src", type: "dir" }]);
    await expect(provider.stat("README.md")).resolves.toMatchObject({ size: 7 });
    await expect(provider.readFile("README.md")).resolves.toMatchObject({ content: "hello\n" });
    expect(calls).toEqual([
      { method: "fs.readdir", params: { relPath: "." } },
      { method: "fs.stat", params: { relPath: "README.md" } },
      { method: "fs.readFile", params: { relPath: "README.md" } },
    ]);
  });

  it("classifies malformed ssh provider responses as agent protocol errors", async () => {
    const channel: SshChannel = {
      ready: Promise.resolve(),
      call: async () => ({ unexpected: true }),
      on: () => () => {},
      onLifecycle: () => () => {},
      dispose: () => {},
    };
    const provider = createFsProvider(
      makeMeta({ kind: "ssh", host: "dev.example.com", remotePath: "/srv/repo" }),
      channel,
    );

    try {
      await provider.stat("README.md");
      throw new Error("expected provider.stat to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Remote server protocol error");
      expect((error as { code?: string }).code).toBe("server.protocol-error");
    }
  });
});
