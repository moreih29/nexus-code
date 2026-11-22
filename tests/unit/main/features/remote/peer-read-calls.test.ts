import { expect, mock, test } from "bun:test";
import { RPC_METHODS } from "../../../../../packages/remote-protocol/src/rpc";
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
  expect(c.args.parse({ deviceId: "d2", ...params })).toEqual({ deviceId: "d2", ...params });
  expect(c.result).toBe(RPC_METHODS["files.search"].result);
  expect(c.args.safeParse(params).success).toBe(false);
  expect(c.args.safeParse({ deviceId: "d2", ...params, query: "" }).success).toBe(false);
  const request = mock(async () => result);
  const calls = peerReadCalls(
    () => ({ request: request as never }),
    async (run) => ipcOk(await run()),
  );
  const signal = new AbortController().signal;
  expect(await calls.peerFilesSearch({ deviceId: "d2", ...params }, { signal } as never)).toEqual(
    ipcOk(result),
  );
  expect(request).toHaveBeenCalledWith("d2", "files.search", params, expect.any(Number), signal);
  expect(() => calls.peerFilesSearch(params)).toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});

test("the peer File and Git IPCs map only to read RPCs", () => {
  expect(PEER_READ_METHODS).toEqual({
    peerFilesList: "files.list",
    peerFilesFind: "files.find",
    peerFilesSearch: "files.search",
    peerFilesRead: "files.read",
    peerGitDiff: "git.diff",
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
  const files = Object.keys(ipcContract.remote.call).filter((name) => /^peerFiles/i.test(name));
  expect(files.some((name) => /write|mkdir/i.test(name))).toBe(false);
  expect(files.toSorted()).toEqual([
    "peerFilesFind",
    "peerFilesList",
    "peerFilesRead",
    "peerFilesReadBytes",
    "peerFilesSearch",
  ]);
});
