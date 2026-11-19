import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliDevice } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { RpcFailure } from "../../../../src/main/features/remote/room";
import { API, contextFor, type FakeApp, fakeApp, SHELL_TAB } from "./fake-services";

const DEVICE: CliDevice = {
  id: "face0001",
  name: "Peer PC",
  platform: "windows",
  online: true,
  self: false,
  serves: ["files", "sessions", "agents"],
  schema: "0.13.4",
};
const WS = { id: "befa0001", name: "project", path: "C:/work/project" };
const REMOTE = "C:\\work\\project\\out\\source.bin";
const DATA = Buffer.from([1, 0, 255, 2, 3]);
const VERSION = "0123456789abcdef";

type Read = RpcParams<"files.read">;
type Listing = RpcResult<"files.list">;
type Reader = (read: Read, signal?: AbortSignal) => unknown;

function piece(read: Read, data = DATA, remotePath = REMOTE, version: string | null = VERSION) {
  const offset = read.offset ?? 0;
  const length = read.length ?? MAX_BYTES_CHUNK;
  return {
    kind: "bytes",
    path: remotePath,
    size: data.length,
    offset,
    data: data.subarray(offset, offset + length).toString("base64"),
    ...(version !== null ? { version } : {}),
  };
}

function peer(reader: Reader = (read) => piece(read), listings: Record<string, Listing> = {}) {
  const app = fakeApp();
  app.peers.devices = [DEVICE];
  app.peers.answer = async (_id, method, params, signal) => {
    if (method === "sessions.list") return { workspaces: [WS], sessions: [] };
    if (method === "files.read") return reader(params as Read, signal);
    if (method === "files.list") {
      const asked = (params as RpcParams<"files.list">).path;
      if (listings[asked]) return listings[asked];
      throw new Error(`unexpected listing of ${asked}`);
    }
    throw new Error(`unexpected request ${method}`);
  };
  return app;
}

function fail(code: number, message: string): never {
  throw new RpcFailure(code, message);
}

function directory(asked: string): never {
  return fail(RpcErrorCode.InvalidParams, `${asked} is a folder: files.list lists it`);
}

function reads(app: FakeApp): Read[] {
  return app.peers.requests.filter((r) => r.method === "files.read").map((r) => r.params as Read);
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "nexus-file-pull-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function run(app: FakeApp, args: string[], signal?: AbortSignal) {
  const ctx = contextFor(app, ["file", "pull", ...args], undefined, { cwd });
  return runCli(CLI_COMMANDS, signal ? { ...ctx, signal } : ctx);
}

function pull(app: FakeApp, ...args: string[]) {
  return run(app, ["--device", "face", "--workspace", "befa", ...args]);
}

function hash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

test.each([
  "out/source.bin",
  REMOTE,
  "C:/work/project/out/source.bin",
])("passes %s to the Windows workspace and saves its basename", async (source) => {
  const app = peer();
  const result = await pull(app, source, "--json");
  const target = path.join(cwd, "source.bin");
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.files).toBeUndefined();
  expect(JSON.parse(result.stdout)).toEqual({
    device: { id: DEVICE.id, name: DEVICE.name },
    path: target,
    remotePath: REMOTE,
    size: DATA.length,
    sha256: hash(DATA),
  });
  expect(await readFile(target)).toEqual(DATA);
  expect(reads(app).every((r) => r.path === source && r.workspaceId === WS.id)).toBe(true);
});

test("uses an existing directory or an explicit file name relative to the CLI cwd", async () => {
  const folder = path.join(cwd, "downloads");
  await mkdir(folder);
  const result = await pull(peer(), "source.bin", "downloads");
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(hash(DATA));
  expect(await readFile(path.join(folder, "source.bin"))).toEqual(DATA);

  const file = path.join(cwd, "renamed.bin");
  await writeFile(file, "old contents");
  expect((await pull(peer(), "source.bin", "renamed.bin")).stderr).toBe("");
  expect(await readFile(file)).toEqual(DATA);
  expect((await readdir(cwd)).sort()).toEqual(["downloads", "renamed.bin"]);
});

test.skipIf(process.platform !== "win32")(
  "uses the Git Bash temp path as a local directory",
  async () => {
    const app = peer();
    const ctx = contextFor(
      app,
      ["file", "pull", "--device", "Peer PC", "--workspace", "project", "source.bin", "/tmp"],
      undefined,
      { cwd, msysRoot: "C:\\Git", tempDir: cwd },
    );
    expect((await runCli(CLI_COMMANDS, ctx)).stderr).toBe("");
    expect(await readFile(path.join(cwd, "source.bin"))).toEqual(DATA);
  },
);

test("starts four positioned chunk reads and assembles out-of-order answers", async () => {
  const data = Buffer.concat(
    [1, 2, 3, 4, 5, 6].map((part) => Buffer.alloc(part < 6 ? MAX_BYTES_CHUNK : 13, part)),
  );
  let active = 0;
  let peak = 0;
  const completed: number[] = [];
  const app = peer(async (request) => {
    if (request.length === 0) return piece(request, data);
    const offset = request.offset ?? 0;
    peak = Math.max(++active, peak);
    try {
      await delay(offset === 0 ? 40 : 5);
      completed.push(offset);
      return piece(request, data);
    } finally {
      active--;
    }
  });
  const result = await pull(app, "source.bin", "--json");
  expect(result.stderr).toBe("");
  expect(peak).toBe(4);
  expect(completed[0]).not.toBe(0);
  expect(await readFile(path.join(cwd, "source.bin"))).toEqual(data);
  expect(JSON.parse(result.stdout).sha256).toBe(hash(data));
  expect(reads(app)[0]).toMatchObject({ as: "bytes", length: 0, versioned: true });
  expect(
    reads(app)
      .slice(1)
      .every((r) => r.requireVersion === VERSION),
  ).toBe(true);
  expect(reads(app).at(-1)).toMatchObject({ length: 0, requireVersion: VERSION });
});

test("a changed version lets outstanding reads unwind and keeps the old file", async () => {
  const data = Buffer.alloc(MAX_BYTES_CHUNK + 1, 42);
  const saved = path.join(cwd, "source.bin");
  await writeFile(saved, "previous");
  let otherAborted = false;
  const app = peer(async (request, signal) => {
    if (!request.length) return piece(request, data);
    if (!request.offset) {
      await delay(5);
      return fail(RpcErrorCode.InvalidParams, "file version changed");
    }
    try {
      await delay(2000, undefined, { signal });
    } finally {
      otherAborted = signal?.aborted ?? false;
    }
  });
  const result = await pull(app, "source.bin");
  expect(result.stderr).toContain("changed while copying");
  expect(result.exitCode).not.toBe(0);
  expect(otherAborted).toBe(true);
  expect(await readFile(saved, "utf8")).toBe("previous");
  expect(await readdir(cwd)).toEqual(["source.bin"]);
});

test("a change after the data reads also prevents replacement", async () => {
  const app = peer((request) =>
    piece(
      request,
      DATA,
      REMOTE,
      request.length === 0 && request.requireVersion ? "version-b" : VERSION,
    ),
  );
  expect((await pull(app, "source.bin")).stderr).toContain("changed while copying");
  expect(await readdir(cwd)).toEqual([]);
});

test("cancellation unwinds reads and removes the temporary file", async () => {
  const controller = new AbortController();
  const app = peer(async (request, signal) => {
    if (!request.length) return piece(request);
    expect((await readdir(cwd))[0]).toMatch(/^\.nexus-pull-/);
    controller.abort();
    signal?.throwIfAborted();
    throw new Error("cancellation did not reach remote.request");
  });
  const result = await run(
    app,
    ["--device", DEVICE.id, "--workspace", WS.id, "source.bin"],
    controller.signal,
  );
  expect(result.stderr).toContain("file pull cancelled");
  expect(result.exitCode).not.toBe(0);
  expect(await readdir(cwd)).toEqual([]);
});

test("a failed rename leaves no temporary file", async () => {
  await mkdir(path.join(cwd, "source.bin"));
  const result = await pull(peer(), "source.bin");
  expect(result.stderr).toContain("cannot write");
  expect(result.exitCode).not.toBe(0);
  expect(await readdir(cwd)).toEqual(["source.bin"]);
});

describe("recursive pull", () => {
  const root = "C:\\work\\project";
  const nested = path.win32.join(root, "nested");
  const empty = path.win32.join(root, "empty");

  function tree(truncated = false) {
    return peer(
      (read) => (read.path === "." ? directory(read.path) : piece(read, DATA, read.path)),
      {
        ".": {
          path: root,
          entries: [
            { kind: "file", name: "root.txt" },
            { kind: "dir", name: "nested" },
            { kind: "link", name: "shortcut" },
            { kind: "dir", name: "empty" },
          ],
        },
        [nested]: { path: nested, entries: [{ kind: "file", name: "leaf.txt" }], truncated },
        [empty]: { path: empty, entries: [] },
      },
    );
  }

  test("keeps nested and empty directories and names skipped links", async () => {
    const app = tree();
    const result = await pull(app, "-r", ".", "snapshot", "--json");
    expect(result.stderr).toBe("");
    const dest = path.join(cwd, "snapshot");
    expect((await stat(path.join(dest, "empty"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(dest, "root.txt"))).toEqual(DATA);
    expect(await readFile(path.join(dest, "nested", "leaf.txt"))).toEqual(DATA);
    expect((await readdir(dest)).sort()).toEqual(["empty", "nested", "root.txt"]);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({
        remotePath: path.win32.join(root, "root.txt"),
        sha256: hash(DATA),
      }),
      expect.objectContaining({
        remotePath: path.win32.join(nested, "leaf.txt"),
        sha256: hash(DATA),
      }),
      {
        device: { id: DEVICE.id, name: DEVICE.name },
        remotePath: path.win32.join(root, "shortcut"),
        skipped: "symlink",
      },
    ]);
    expect(reads(app).every((r) => !r.path.endsWith("shortcut"))).toBe(true);
  });

  test("refuses to copy any of a tree with a truncated nested listing", async () => {
    const result = await pull(tree(true), "-r", ".");
    expect(result.stderr).toContain("is truncated");
    expect(result.exitCode).not.toBe(0);
    expect(await readdir(cwd)).toEqual([]);
  });

  test("requires -r for a directory", async () => {
    const result = await pull(tree(), ".");
    expect(result.stderr).toContain("is a directory (use -r to copy it)");
    expect(result.exitCode).not.toBe(0);
  });

  test("rejects a listing with an entry outside the destination", async () => {
    const app = peer((read) => directory(read.path), {
      ".": { path: root, entries: [{ kind: "file", name: "..\\outside.txt" }] },
    });
    expect((await pull(app, "-r", ".")).stderr).toContain("invalid entry name");
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("older hosts", () => {
  test.each(["0.13.3", "0.13.4"])("copies from a versionless %s host", async (schema) => {
    const app = peer((read) => piece(read, DATA, REMOTE, null));
    app.peers.devices = [{ ...DEVICE, schema }];
    const result = await pull(app, "source.bin");
    expect(result.stderr).toBe("");
    expect(await readFile(path.join(cwd, "source.bin"))).toEqual(DATA);
    expect(reads(app)[0]?.length).toBe(schema === "0.13.4" ? 0 : 1);
    expect(
      reads(app)
        .slice(1)
        .every((r) => !r.versioned && !r.requireVersion),
    ).toBe(true);
  });

  test("detects a size change without a version", async () => {
    const app = peer((read) =>
      piece(read, read.length === 1 ? DATA : Buffer.concat([DATA, DATA]), REMOTE, null),
    );
    app.peers.devices = [{ ...DEVICE, schema: "0.13.3" }];
    expect((await pull(app, "source.bin")).stderr).toContain("changed while copying");
    expect(await readdir(cwd)).toEqual([]);
  });

  test("reports an older host that ignores the bytes option", async () => {
    const app = peer(() => ({ kind: "binary", path: REMOTE, size: DATA.length }));
    expect((await pull(app, "source.bin")).stderr).toContain(
      'does not support files.read as "bytes"',
    );
    expect(await readdir(cwd)).toEqual([]);
  });
});

test("requires a device and a workspace, as other remote creation commands do", async () => {
  expect((await run(peer(), ["source.bin"])).stderr).toContain("give --device");
  expect((await run(peer(), ["source.bin", "--device", "Peer PC"])).stderr).toContain(
    "give --workspace",
  );
  expect((await run(peer(), ["--help"])).stdout).toContain("-r, --recursive");
});

test("a shell on an SSH workspace cannot write to the app's host", async () => {
  const app = peer();
  const at = app.workspaces.findIndex((workspace) => workspace.id === API);
  const existing = app.workspaces[at];
  if (!existing) throw new Error("missing API workspace in fixture");
  app.workspaces[at] = {
    ...existing,
    location: { kind: "ssh", host: "box", remotePath: "/w/api" },
  };
  const ctx = contextFor(
    app,
    ["file", "pull", "--device", DEVICE.id, "--workspace", WS.id, "source.bin"],
    { workspaceId: API, tabId: SHELL_TAB },
    { cwd },
  );
  expect((await runCli(CLI_COMMANDS, ctx)).stderr).toContain("run file pull in a local workspace");
  expect(app.peers.requests).toEqual([]);
  expect(await readdir(cwd)).toEqual([]);
});

test("reports an offline device and a device with no files capability", async () => {
  const app = peer();
  app.peers.devices = [{ ...DEVICE, online: false }];
  expect((await pull(app, "source.bin")).stderr).toContain('"Peer PC" is offline');
  app.peers.devices = [{ ...DEVICE, serves: ["sessions", "agents"] }];
  expect((await pull(app, "source.bin")).stderr).toContain('"Peer PC" does not share files');
  expect(app.peers.requests).toEqual([]);
});

test.each([
  [RpcErrorCode.Forbidden, "is outside the workspace's folders"],
  [RpcErrorCode.NotFound, "does not exist"],
  [RpcErrorCode.Unavailable, "files.read: no answer in time"],
])("explains a peer failure (%s) in one line", async (code, message) => {
  const app = peer((read) => fail(code, `${read.path} ${message}`));
  const result = await pull(app, "parent/\nsource.bin");
  expect(result.stderr).toContain(
    code === RpcErrorCode.Unavailable ? "did not answer in time" : message,
  );
  expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(result.exitCode).not.toBe(0);
  expect(await readdir(cwd)).toEqual([]);
});
