import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcParams,
} from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliDevice } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { RpcFailure } from "../../../../src/main/features/remote/room";
import { contextFor, type FakeApp, fakeApp, SHELL_TAB } from "./fake-services";

const HOST: CliDevice = {
  id: "host",
  name: "Peer PC",
  platform: "windows",
  online: true,
  self: false,
  serves: ["sessions", "files", "files.write", "agents"],
  schema: "0.14.0",
};
const WORKSPACE = { id: "ws", name: "project", path: "C:/work/project" };
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "nexus-file-push-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function peer(directories: string[] = [], device = HOST) {
  const app = fakeApp();
  app.peers.devices = [device];
  const uploads = new Map<string, { path: string; data: Buffer }>();
  const saved = new Map<string, Buffer>();
  app.peers.answer = async (_id, method, params) => {
    if (method === "sessions.list") return { workspaces: [WORKSPACE], sessions: [] };
    if (method === "files.list") {
      const list = params as RpcParams<"files.list">;
      if (directories.includes(list.path)) return { path: list.path, entries: [] };
      throw new RpcFailure(RpcErrorCode.NotFound, `${list.path} does not exist`);
    }
    if (method === "files.mkdir") {
      const folder = (params as RpcParams<"files.mkdir">).path;
      directories.push(folder);
      return { path: folder };
    }
    if (method === "files.write.begin") {
      const begin = params as RpcParams<"files.write.begin">;
      uploads.set(begin.path, { path: begin.path, data: Buffer.alloc(begin.size) });
      return { uploadId: begin.path };
    }
    if (method === "files.write.chunk") {
      const chunk = params as RpcParams<"files.write.chunk">;
      const upload = uploads.get(chunk.uploadId);
      if (!upload) throw new Error("no pending upload");
      Buffer.from(chunk.data, "base64").copy(upload.data, chunk.offset);
      return {};
    }
    if (method === "files.write.end") {
      const end = params as RpcParams<"files.write.end">;
      const upload = uploads.get(end.uploadId);
      if (!upload) throw new Error("no pending upload");
      expect(digest(upload.data)).toBe(end.sha256);
      uploads.delete(end.uploadId);
      saved.set(upload.path, upload.data);
      return { path: upload.path, size: upload.data.length, sha256: end.sha256 };
    }
    if (method === "files.write.abort") {
      uploads.delete((params as RpcParams<"files.write.abort">).uploadId);
      return {};
    }
    throw new Error(`unexpected request ${method}`);
  };
  return { app, saved, uploads, directories };
}

function push(app: FakeApp, ...args: string[]) {
  return runCli(
    CLI_COMMANDS,
    contextFor(app, ["file", "push", "--device", "host", "--workspace", "ws", ...args], undefined, {
      cwd,
    }),
  );
}

test("sends multiple files to an existing directory and reports the two paths", async () => {
  const first = Buffer.alloc(MAX_BYTES_CHUNK + 2, 42);
  await writeFile(path.join(cwd, "first"), first);
  await writeFile(path.join(cwd, "second"), "");
  const { app, saved } = peer(["dest"]);
  const result = await push(app, "first", "second", "dest", "--json");
  expect(result.stderr).toBe("");
  expect(saved).toEqual(
    new Map([
      ["dest\\first", first],
      ["dest\\second", Buffer.alloc(0)],
    ]),
  );
  expect(JSON.parse(result.stdout)).toMatchObject([
    {
      path: path.join(cwd, "first"),
      remotePath: "dest\\first",
      size: first.length,
      sha256: digest(first),
    },
    { path: path.join(cwd, "second"), remotePath: "dest\\second", size: 0 },
  ]);
  expect(
    app.peers.requests
      .filter((request) => request.method.startsWith("files."))
      .every(
        (request) => (request.params as { from?: { tabId: string } }).from?.tabId === SHELL_TAB,
      ),
  ).toBe(true);
});

test("requires an existing directory for multiple sources", async () => {
  const { app, saved } = peer();
  const result = await push(app, "first", "second", "missing");
  expect(result.stderr).toContain("existing directory for multiple sources");
  expect(saved.size).toBe(0);
  expect(app.peers.requests.some((r) => r.method === "files.write.begin")).toBe(false);
});

test("recursively makes directories, including empty ones, and skips links", async () => {
  await mkdir(path.join(cwd, "src", "empty"), { recursive: true });
  await writeFile(path.join(cwd, "src", "file"), "contents");
  if (process.platform !== "win32") await symlink("file", path.join(cwd, "src", "link"));
  const { app, directories, saved } = peer();
  expect((await push(app, "src", "dest")).stderr).toContain("use -r");
  const result = await push(app, "-r", "src", "dest", "--json");
  expect(result.stderr).toBe("");
  expect(directories).toEqual(["dest", "dest\\empty"]);
  expect(saved).toEqual(new Map([["dest\\file", Buffer.from("contents")]]));
  if (process.platform !== "win32") {
    expect(JSON.parse(result.stdout)).toContainEqual(
      expect.objectContaining({ skipped: "symlink" }),
    );
  }
});

test("gates push on protocol version before asking for write methods", async () => {
  const { app } = peer([], { ...HOST, schema: "0.13.4" });
  const result = await push(app, "first", "target");
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("Update it to use file push");
  expect(app.peers.requests).toEqual([]);
});

test("uses terminal control and marks every request for an outside absolute path", async () => {
  await writeFile(path.join(cwd, "first"), "data");
  const { app, saved } = peer([], {
    ...HOST,
    serves: ["sessions", "files", "terminal.control", "agents"],
  });
  expect((await push(app, "first", "C:/work/project/data")).stderr).toContain(
    "requires chat control",
  );
  expect((await push(app, "first", "D:/outside/data")).stderr).toBe("");
  expect(saved.get("D:/outside/data")).toEqual(Buffer.from("data"));
  const transfer = app.peers.requests.filter((r) => r.method.startsWith("files."));
  expect(transfer).toHaveLength(4);
  for (const request of transfer) expect(request.params).toMatchObject({ anywhere: true });
});

test("retries a busy chunk and aborts an upload when a later operation fails", async () => {
  await writeFile(path.join(cwd, "first"), "data");
  const { app, uploads, saved } = peer();
  const answer = app.peers.answer;
  let chunks = 0;
  app.peers.answer = async (...args) => {
    const [, method] = args;
    if (method === "files.write.chunk" && ++chunks === 1) {
      throw new RpcFailure(RpcErrorCode.Unavailable, "the host is busy writing files");
    }
    if (method === "files.write.end")
      throw new RpcFailure(RpcErrorCode.InvalidParams, "hash mismatch");
    return answer?.(...args);
  };
  const result = await push(app, "first", "target");
  expect(result.stderr).toContain("hash mismatch");
  expect(chunks).toBe(2);
  expect(uploads.size).toBe(0);
  expect(saved.size).toBe(0);
  expect(app.peers.requests.at(-1)?.method).toBe("files.write.abort");
});
