import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_BYTES_CHUNK,
  RpcErrorCode,
  type RpcParams,
} from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { AgentFsProvider } from "../../../../../src/main/features/fs/bridge/agent-provider";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import { AgentGate } from "../../../../../src/main/features/remote/agent-gate";
import {
  FileWrites,
  makeRemoteDirectory,
} from "../../../../../src/main/features/remote/file-writes";
import { RpcFailure } from "../../../../../src/main/features/remote/room";

import { serveWith } from "../../../../../src/main/features/remote/serve";
import type { RemoteAgentsPolicy } from "../../../../../src/shared/types/app-state";
import { fakeApp } from "../../cli/fake-services";

const FROM = { kind: "tab", workspaceId: "source", tabId: "tab" } as const;
const DEVICE = "device";
const authorize = () => {};
const digest = (data: string) => createHash("sha256").update(data).digest("hex");
const piece = (uploadId: string, offset: number, data: string) => ({
  uploadId,
  offset,
  data: Buffer.from(data).toString("base64"),
});

let tmp: string;
let root: string;
let writes: FileWrites;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "nexus-file-writes-")));
  root = path.join(tmp, "workspace");
  await mkdir(root);
  writes = new FileWrites();
});
afterEach(async () => {
  await writes.drop();
  await rm(tmp, { recursive: true, force: true });
});

function begin(
  file: string,
  size: number,
  options: Partial<RpcParams<"files.write.begin">> = {},
  device = DEVICE,
) {
  return writes.begin(
    device,
    root,
    { workspaceId: "w", path: file, size, from: FROM, ...options },
    authorize,
  );
}

test("writes positioned pieces out of order and publishes only a verified file", async () => {
  const target = path.join(root, "data");
  const { uploadId } = await begin("data", 6);
  const temporary = path.join(root, (await readdir(root))[0] as string);
  expect(await stat(temporary)).toMatchObject({ size: 0 });
  if (process.platform !== "win32") expect((await stat(temporary)).mode & 0o777).toBe(0o600);
  await Promise.all([
    writes.chunk(DEVICE, piece(uploadId, 4, "ef")),
    writes.chunk(DEVICE, piece(uploadId, 0, "ab")),
    writes.chunk(DEVICE, piece(uploadId, 2, "cd")),
  ]);
  await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  const sha256 = digest("abcdef");
  expect(await writes.end(DEVICE, { uploadId, sha256 })).toEqual({ path: target, size: 6, sha256 });
  expect(await readFile(target, "utf8")).toBe("abcdef");
  expect(await readdir(root)).toEqual(["data"]);
  if (process.platform !== "win32")
    expect((await stat(target)).mode & 0o777).toBe(0o666 & ~process.umask());
});

test("an incorrect hash never replaces the destination and removes the temporary file", async () => {
  const target = path.join(root, "data");
  await writeFile(target, "old");
  const { uploadId } = await begin("data", 3);
  await writes.chunk(DEVICE, piece(uploadId, 0, "new"));
  await expect(writes.end(DEVICE, { uploadId, sha256: digest("bad") })).rejects.toThrow(
    "SHA-256 did not match",
  );
  expect(await readFile(target, "utf8")).toBe("old");
  expect(await readdir(root)).toEqual(["data"]);
});

test("rejects gaps even when untouched holes match the declared hash", async () => {
  const { uploadId } = await begin("data", 3);
  await writes.chunk(DEVICE, piece(uploadId, 2, "x"));
  await expect(writes.end(DEVICE, { uploadId, sha256: digest("\0\0x") })).rejects.toThrow(
    "all the declared bytes",
  );
  expect(await readdir(root)).toEqual([]);
});

test("rejects overlapping, oversized and noncanonical chunks", async () => {
  const { uploadId } = await begin("data", MAX_BYTES_CHUNK + 1);
  for (const data of ["eA", "eB==", Buffer.alloc(MAX_BYTES_CHUNK + 1).toString("base64")]) {
    await expect(writes.chunk(DEVICE, { uploadId, offset: 0, data })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams,
    });
  }
  await writes.chunk(DEVICE, piece(uploadId, 0, "a"));
  await expect(writes.chunk(DEVICE, piece(uploadId, 0, "b"))).rejects.toThrow("overlaps");
});

test.skipIf(process.platform === "win32")(
  "retains mode when overwriting an existing file with an empty file",
  async () => {
    const target = path.join(root, "data");
    await writeFile(target, "old");
    await chmod(target, 0o754);
    const { uploadId } = await begin("data", 0);
    await writes.end(DEVICE, { uploadId, sha256: digest("") });
    expect(await readFile(target, "utf8")).toBe("");
    expect((await stat(target)).mode & 0o777).toBe(0o754);
  },
);

test("refuses lexical escapes and missing parents; mkdir creates one level at a time", async () => {
  await expect(begin("../outside", 0)).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
  await expect(begin(path.join(tmp, "outside"), 0)).rejects.toMatchObject({
    code: RpcErrorCode.Forbidden,
  });
  await expect(begin("nested/data", 0)).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  await expect(
    makeRemoteDirectory(root, { path: "nested/empty" }, authorize),
  ).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  for (const folder of [".", "nested", "nested", "nested/empty"]) {
    expect(await makeRemoteDirectory(root, { path: folder }, authorize)).toEqual({
      path: path.resolve(root, folder),
    });
  }
});

test.skipIf(process.platform === "win32")(
  "rejects escaping symlink parents and symlink destinations",
  async () => {
    await symlink(tmp, path.join(root, "link"), "dir");
    await expect(begin("link/data", 0)).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    await expect(begin("link", 0)).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    await expect(
      makeRemoteDirectory(root, { path: "link/folder" }, authorize),
    ).rejects.toMatchObject({ code: RpcErrorCode.Forbidden });
    expect(await readdir(tmp)).toEqual(["workspace"]);
  },
);

test("anywhere requires an absolute path; permissions are rechecked for later pieces and commit", async () => {
  await expect(begin("relative", 0, { anywhere: true })).rejects.toMatchObject({
    code: RpcErrorCode.Forbidden,
  });
  const target = path.join(tmp, "outside");
  let allowed = true;
  const { uploadId } = await writes.begin(
    DEVICE,
    root,
    {
      workspaceId: "w",
      path: target,
      size: 1,
      from: FROM,
      anywhere: true,
    },
    () => {
      if (!allowed) throw new RpcFailure(RpcErrorCode.Forbidden, "terminal control is off");
    },
  );
  allowed = false;
  await expect(writes.chunk(DEVICE, piece(uploadId, 0, "x"))).rejects.toThrow(
    "terminal control is off",
  );
  await expect(writes.end(DEVICE, { uploadId, sha256: digest("x") })).rejects.toThrow(
    "terminal control is off",
  );
  allowed = true;
  await writes.chunk(DEVICE, piece(uploadId, 0, "x"));
  expect((await writes.end(DEVICE, { uploadId, sha256: digest("x") })).path).toBe(target);
});

test("another peer cannot complete or abort an upload; owner abort is idempotent", async () => {
  const { uploadId } = await begin("data", 0);
  await expect(writes.end("other", { uploadId, sha256: digest("") })).rejects.toMatchObject({
    code: RpcErrorCode.NotFound,
  });
  await writes.abort("other", { uploadId });
  expect(await readdir(root)).toHaveLength(1);
  await writes.abort(DEVICE, { uploadId });
  await writes.abort(DEVICE, { uploadId });
  expect(await readdir(root)).toEqual([]);
});

test("idle expiry is reset by a chunk and removes the temporary file", async () => {
  const pending = new Set<() => Promise<void>>();
  writes = new FileWrites((expire, idleMs) => {
    expect(idleMs).toBe(120_000);
    pending.add(expire);
    return () => pending.delete(expire);
  });
  const { uploadId } = await begin("idle", 3);
  expect(pending.size).toBe(1);
  const [atBegin] = pending;
  await writes.chunk(DEVICE, piece(uploadId, 0, "new"));
  expect(pending.size).toBe(1);
  expect(pending.has(atBegin as () => Promise<void>)).toBe(false);
  await Promise.all([...pending].map((expire) => expire()));
  expect(pending.size).toBe(0);
  expect(await readdir(root)).toEqual([]);
});

test("disconnect waits for a pending chunk before removing its temporary file", async () => {
  const { uploadId } = await begin("gone", 3);
  await Promise.all([writes.chunk(DEVICE, piece(uploadId, 0, "new")), writes.drop(DEVICE)]);
  expect(await readdir(root)).toEqual([]);
});

test("reserves concurrent slots before checking files and releases them when uploads are dropped", async () => {
  const parallel = (device: string, count: number) =>
    Array.from({ length: count }, (_, i) => begin(device + i, 0, {}, device));
  await Promise.all([...parallel("a", 4), ...parallel("b", 4)]);
  await expect(begin("extra", 0, {}, "c")).rejects.toThrow("busy writing files");
  await writes.drop("b");
  await expect(begin("extra", 0, {}, "a")).rejects.toThrow("busy writing files");
  await begin("extra", 0, {}, "c");
  expect(await readdir(root)).toHaveLength(5);
});

function consentHost(
  policy: RemoteAgentsPolicy,
  ...answers: Array<"once" | "session" | "deny" | "timeout">
) {
  return fileHost(policy, answers);
}

function fileHost(
  policy: RemoteAgentsPolicy,
  answers: Array<"once" | "session" | "deny" | "timeout">,
  agent?: FsProvider,
) {
  const app = fakeApp();
  const workspace = app.workspaces[0];
  if (!workspace) throw new Error("workspace fixture is missing");
  const location =
    agent?.kind === "ssh"
      ? { kind: "ssh", host: "host", remotePath: "/remote" }
      : agent?.kind === "wsl"
        ? { kind: "wsl", distro: "Ubuntu", remotePath: "/remote" }
        : { kind: "local", rootPath: root };
  Object.assign(workspace, {
    rootPath: "remotePath" in location ? location.remotePath : root,
    location,
  });
  const prompts: unknown[] = [];
  const services = {
    ...app.services,
    ui: async (op: string, args: unknown) => {
      if (op !== "consent.ask") throw new Error(`unexpected ${op}`);
      prompts.push(args);
      expect(await readdir(root)).not.toContainEqual(expect.stringMatching(/^\.nexus-push-/));
      return { answer: answers.shift() ?? "deny" };
    },
  } as CliServices;
  const serve = serveWith(() => services, {
    controls: () => ({ chat: true, terminal: true }),
    agents: new AgentGate({ policy: () => policy }),
    fileWrites: writes,
    files: {
      fs: async () => {
        if (agent) return agent;
        throw new Error("probing a write target reads no entries");
      },
      shrink: () => null,
    },
  });
  const from = { from: FROM, workspaceId: workspace.id };
  const transferId = "10000000-0000-4000-8000-000000000000";
  const invoke = (method: Parameters<typeof serve>[0]["method"], params: object) =>
    serve({ from: DEVICE, method, params: { ...from, transferId, ...params } });
  const empty = async (target: string, anywhere?: true) => {
    const { uploadId } = (await invoke("files.write.begin", {
      path: target,
      size: 0,
      anywhere,
    })) as { uploadId: string };
    return invoke("files.write.end", { uploadId, sha256: digest("") });
  };
  return { prompts, invoke, empty };
}

test.each([
  "deny",
  "timeout",
] as const)("leaves no temporary file when the consent prompt answers %s", async (answer) => {
  const { invoke, prompts } = consentHost("ask", answer);
  await expect(invoke("files.write.begin", { path: "data", size: 1 })).rejects.toThrow(
    answer === "deny" ? "did not allow" : "did not answer in time",
  );
  expect(prompts).toHaveLength(1);
  expect(await readdir(root)).toEqual([]);
});

test("agent deny blocks file access without asking, and allow proceeds without asking", async () => {
  const deny = consentHost("deny");
  await expect(deny.invoke("files.write.begin", { path: "data", size: 1 })).rejects.toThrow(
    "agents are off",
  );
  await expect(deny.invoke("files.list", { path: tmp, anywhere: true })).rejects.toThrow(
    "agents are off",
  );
  expect(deny.prompts).toEqual([]);
  const allow = consentHost("allow");
  await allow.empty("data");
  expect(await readdir(root)).toEqual(["data"]);
  expect(allow.prompts).toEqual([]);
});

test("recursive workspace push asks once for its tree and can exceed the messaging limit", async () => {
  const { invoke, empty, prompts } = consentHost("ask", "once");
  await invoke("files.mkdir", { path: "dest" });
  await invoke("files.mkdir", { path: "dest/folder" });
  for (let i = 0; i < 22; i++) await empty(`dest/folder/file-${i}`);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({
    change: { kind: "fileWriteTree", detail: path.join(root, "dest") },
  });
  expect(await readdir(path.join(root, "dest", "folder"))).toHaveLength(22);
  await expect(empty("dest-other")).rejects.toThrow("did not allow");
  expect(prompts).toHaveLength(2);
});

test("recursive push outside the workspace can approve the destination probe and writes with one prompt", async () => {
  const { invoke, empty, prompts } = consentHost("ask", "once");
  const dest = path.join(tmp, "dest");
  await mkdir(dest);
  await writeFile(path.join(dest, "private"), "existing");
  expect(await invoke("files.list", { path: dest, anywhere: true, writeTarget: true })).toEqual({
    path: dest,
    entries: [],
  });
  await invoke("files.mkdir", { path: path.join(dest, "folder"), anywhere: true });
  await empty(path.join(dest, "folder", "new"), true);
  expect(await readdir(path.join(dest, "folder"))).toEqual(["new"]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({
    change: { kind: "fileWriteTree", detail: dest, terminal: true },
  });
});

test.each([
  ["ssh", true],
  ["wsl", true],
  ["ssh", false],
  ["wsl", false],
] as const)("%s workspace push with upload RPC support %s", async (kind, supported) => {
  const fs = new AgentFsProvider(kind);
  const calls: Array<{ method: string; params: unknown }> = [];
  fs.callAgentMethod = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (!supported)
      throw Object.assign(new Error("method unavailable"), { code: "unsupported-method" });
    if (method === "fs.upload.resolve") {
      return { path: `/remote/${(params as { relPath: string }).relPath}` } as T;
    }
    return {} as T;
  };
  const { invoke, prompts } = fileHost("ask", ["once"], fs);
  if (!supported) {
    for (const method of ["files.write.begin", "files.mkdir"] as const) {
      await expect(invoke(method, { path: "folder", size: 3 })).rejects.toMatchObject({
        code: RpcErrorCode.Unavailable,
        message: "the remote filesystem agent must be updated to write files",
      });
    }
    expect(prompts).toHaveLength(0);
    expect(calls.every(({ method }) => method === "fs.upload.resolve")).toBe(true);
    return;
  }
  expect(await invoke("files.mkdir", { path: "folder" })).toEqual({ path: "/remote/folder" });
  const { uploadId } = (await invoke("files.write.begin", {
    path: "/remote/folder/data",
    size: 3,
  })) as { uploadId: string };
  const chunk = piece(uploadId, 0, "new");
  await invoke("files.write.chunk", chunk);
  const sha256 = digest("new");
  expect(await invoke("files.write.end", { uploadId, sha256 })).toEqual({
    path: "/remote/folder/data",
    size: 3,
    sha256,
  });
  expect(prompts).toHaveLength(1);
  expect(calls).toEqual([
    { method: "fs.upload.resolve", params: { relPath: "folder", directory: true } },
    { method: "fs.upload.mkdir", params: { relPath: "folder", expectedPath: "/remote/folder" } },
    { method: "fs.upload.resolve", params: { relPath: "folder/data", directory: false } },
    {
      method: "fs.upload.begin",
      params: { relPath: "folder/data", expectedPath: "/remote/folder/data", uploadId, size: 3 },
    },
    { method: "fs.upload.chunk", params: chunk },
    { method: "fs.upload.verify", params: { uploadId, sha256 } },
    { method: "fs.upload.commit", params: { uploadId } },
  ]);
});
