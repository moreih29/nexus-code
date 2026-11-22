import { expect, mock, test } from "bun:test";
import { MAX_SEARCH_MATCHES, RPC_METHODS } from "../../../../../packages/remote-protocol/src/rpc";
import {
  PEER_READ_METHODS,
  peerReadCalls,
} from "../../../../../src/main/features/remote/peer-read-calls";
import { ipcContract } from "../../../../../src/shared/ipc/contract";
import { ipcOk } from "../../../../../src/shared/ipc/result";

test("peerFilesSearch validates the protocol payload, then forwards only the search parameters", async () => {
  const c = ipcContract.remote.call.peerFilesSearch;
  const params = { workspaceId: "w1", query: "hi", wholeWord: true, include: ["*.ts"] };
  const result = {
    files: [{ path: "hello.ts", matches: [{ line: 1, column: 2, length: 2, text: "  hi" }] }],
  };
  const payload = { deviceId: "d2", ...params, unexpected: "discard" };
  expect(c.args.parse(payload)).toEqual({ deviceId: "d2", ...params });
  expect(c.result).toBe(RPC_METHODS["files.search"].result);
  expect(c.args.safeParse(params).success).toBe(false);
  expect(c.args.safeParse({ deviceId: "d2", ...params, query: "" }).success).toBe(false);
  const request = mock(async () => result);
  const calls = peerReadCalls(
    () => ({ request: request as never }),
    async (run) => ipcOk(await run()),
  );
  const signal = new AbortController().signal;
  expect(await calls.peerFilesSearch(payload, { signal } as never)).toEqual(ipcOk(result));
  expect(request).toHaveBeenCalledWith("d2", "files.search", params, expect.any(Number), signal);
  expect(() => calls.peerFilesSearch(params)).toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});

test("peerFilesSearch rejects input beyond the protocol limits", () => {
  const { args } = ipcContract.remote.call.peerFilesSearch;
  const payload = { deviceId: "d2", workspaceId: "w1", query: "hi" };
  const filters = Array.from({ length: 33 }, () => "*.ts");
  for (const overLimit of [
    { query: "x".repeat(1025) },
    { include: filters },
    { exclude: filters },
    { include: ["x".repeat(257)] },
    { exclude: ["x".repeat(257)] },
    { limit: MAX_SEARCH_MATCHES + 1 },
  ]) {
    expect(args.safeParse({ ...payload, ...overLimit }).success).toBe(false);
  }
});

test("peerGitStatus sends only the workspace ID to git.status", async () => {
  const c = ipcContract.remote.call.peerGitStatus;
  const params = { workspaceId: "w1" };
  const payload = { ...params, deviceId: "d2", unexpected: true };
  const result = { branch: "main", upstream: "origin/main", ahead: 1, behind: 2, files: [] };
  expect(c.args.parse(payload)).toEqual({ ...params, deviceId: "d2" });
  expect(c.result).toBe(RPC_METHODS["git.status"].result);
  expect(c.args.safeParse(params).success).toBe(false);

  const request = mock(async () => result);
  const calls = peerReadCalls(
    () => ({ request: request as never }),
    async (run) => ipcOk(await run()),
  );
  const signal = new AbortController().signal;
  expect(await calls.peerGitStatus(payload, { signal } as never)).toEqual(ipcOk(result));
  expect(request).toHaveBeenCalledWith("d2", "git.status", params, undefined, signal);
  expect(request).toHaveBeenCalledTimes(1);
});

test.each([
  {
    call: "peerGitLog",
    method: "git.log",
    params: { workspaceId: "w1", limit: 50, skip: 50 },
    invalid: { workspaceId: "w1", limit: 201, skip: -1 },
    result: { commits: [] },
  },
  {
    call: "peerGitShow",
    method: "git.show",
    params: { workspaceId: "w1", hash: "1234abcd" },
    invalid: { workspaceId: "w1", hash: "HEAD" },
    result: { hash: "1234abcd", parents: [], subject: "First", author: "Ada", at: 1, files: [] },
  },
] as const)("$call validates and forwards $method with cancellation", async ({
  call,
  method,
  params,
  invalid,
  result,
}) => {
  const contract = ipcContract.remote.call[call];
  const payload = { deviceId: "d2", ...params, unexpected: true };
  expect(contract.args.parse(payload)).toEqual({ deviceId: "d2", ...params });
  expect(contract.args.safeParse({ deviceId: "d2", ...invalid }).success).toBe(false);
  expect(contract.result).toBe(RPC_METHODS[method].result);
  const request = mock(async () => result);
  const calls = peerReadCalls(
    () => ({ request: request as never }),
    async (run) => ipcOk(await run()),
  );
  const signal = new AbortController().signal;
  expect(await calls[call](payload, { signal } as never)).toEqual(ipcOk(result));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("d2", method, params, undefined, signal);
});

test("the peer File and Git IPCs map only to read RPCs", () => {
  expect(PEER_READ_METHODS).toEqual({
    peerFilesList: "files.list",
    peerFilesFind: "files.find",
    peerFilesSearch: "files.search",
    peerFilesRead: "files.read",
    peerGitStatus: "git.status",
    peerGitDiff: "git.diff",
    peerGitLog: "git.log",
    peerGitShow: "git.show",
  });
  const reads = new Set([
    "files.list",
    "files.find",
    "files.search",
    "files.read",
    "git.status",
    "git.diff",
    "git.log",
    "git.show",
  ]);
  for (const method of Object.values(PEER_READ_METHODS)) {
    expect(reads.has(method)).toBe(true);
  }
  const methods = Object.keys(ipcContract.remote.call).filter((name) =>
    /^peer(Files|Git)/.test(name),
  );
  expect(methods.toSorted()).toEqual(
    [...Object.keys(PEER_READ_METHODS), "peerFilesReadBytes"].sort(),
  );
});
