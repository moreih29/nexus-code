import { expect, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  beforeOfWorkingText,
  readRemoteFileBefore,
} from "../../../../../src/renderer/services/remote/file-comparison";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const peer = { deviceId: "other", workspaceId: "repo" };
const tabId = "chat";
const worktree = "/repo/apps/demo";
const file = { ...peer, path: "/repo/apps/demo/src/task.ts" };
const absent = ipcErr("not-found", "No original");
const status = { branch: "main", ahead: 0, behind: 0, files: [] };
const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }];
const current = { kind: "text", text: "new\n" };

test("a saved chat original takes priority over Git", async () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValueOnce(ipcOk({ before: null }));
  try {
    expect(await readRemoteFileBefore(file, tabId, worktree)).toBeNull();
    expect(call.mock.calls.map(([, method]) => method)).toEqual(["peerChatOriginal"]);
  } finally {
    call.mockRestore();
  }
});

test.each([
  { topLevel: "/repo", root: worktree, absolute: file.path, gitPath: "apps/demo/src/task.ts" },
  {
    topLevel: "d:/Repo",
    root: "D:\\REPO\\Apps\\Demo",
    absolute: "d:/repo/apps/demo/SRC/task.ts",
    gitPath: "Apps/Demo/src/Task.ts",
  },
  {
    topLevel: "\\\\server\\share\\repo",
    root: "//SERVER/Share/repo/Apps/Demo",
    absolute: "\\\\SERVER\\share\\REPO\\Apps\\Demo\\src\\task.ts",
    gitPath: "Apps/Demo/src/task.ts",
  },
])("maps a chat comparison using Git root $topLevel", async ({
  topLevel,
  root,
  absolute,
  gitPath,
}) => {
  const ref = { ...peer, path: absolute };
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(absent)
    .mockResolvedValueOnce(ipcOk({ ...status, topLevel, files: [{ path: gitPath }] }))
    .mockResolvedValueOnce(ipcOk({ path: gitPath, hunks }))
    .mockResolvedValueOnce(ipcOk(current));
  try {
    const { signal } = new AbortController();
    expect(await readRemoteFileBefore(ref, tabId, root, signal)).toBe("old\n");
    expect(call.mock.calls).toEqual([
      ["remote", "peerChatOriginal", { ...ref, tabId }, { signal }],
      ["remote", "peerGitStatus", peer],
      ["remote", "peerGitDiff", { ...peer, path: gitPath }, { signal }],
      ["remote", "peerFilesRead", ref, { signal }],
    ]);
  } finally {
    call.mockRestore();
  }
});

test.each([
  undefined,
  "/repo/other",
  "/Repo",
])("keeps the old absolute Git request when the repository root is unavailable for this workspace (%s)", async (topLevel) => {
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(absent)
    .mockResolvedValueOnce(ipcOk({ ...status, topLevel }))
    .mockResolvedValueOnce(ipcErr("not-found", "No change at that Git path"))
    .mockResolvedValueOnce(ipcOk(current));
  try {
    expect(await readRemoteFileBefore(file, tabId, worktree)).toBeUndefined();
    expect(call.mock.calls[2]?.slice(0, 3)).toEqual(["remote", "peerGitDiff", file]);
    expect(call.mock.calls[3]?.slice(0, 3)).toEqual(["remote", "peerFilesRead", file]);
  } finally {
    call.mockRestore();
  }
});

test("does not use a partial Git patch as a full chat original", async () => {
  const path = "apps/demo/src/task.ts";
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(absent)
    .mockResolvedValueOnce(ipcOk({ ...status, topLevel: "/repo" }))
    .mockResolvedValueOnce(ipcOk({ path, hunks, truncated: true }))
    .mockResolvedValueOnce(ipcOk(current));
  try {
    expect(await readRemoteFileBefore(file, tabId, worktree)).toBeUndefined();
  } finally {
    call.mockRestore();
  }
});

test.each([
  // Git tells LF lines of a file checked out with CRLF (core.autocrlf=true).
  { now: "one\r\nTWO\r\nthree\r\nfour\r\n", before: "one\r\ntwo\r\nthree\r\n" },
  // CRLF kept in Git as well: the lines match as they are.
  { now: "one\r\nTWO\r\nthree\r\nfour\r\n", before: "one\r\ntwo\r\nthree\r\n", gitCr: true },
  // Mixed line endings are not guessed at.
  { now: "one\r\nTWO\nthree\r\nfour\r\n", before: undefined },
])("a chat comparison of a CRLF working file from a Git diff ($now)", async ({
  now,
  before,
  gitCr,
}) => {
  const path = "apps/demo/src/task.ts";
  const cr = gitCr ? "\r" : "";
  const lines = [" one", "-two", "+TWO", " three", "+four"].map((line) => line + cr);
  const crlfHunks = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines }];
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(absent)
    .mockResolvedValueOnce(ipcOk({ ...status, topLevel: "/repo", files: [{ path }] }))
    .mockResolvedValueOnce(ipcOk({ path, hunks: crlfHunks }))
    .mockResolvedValueOnce(ipcOk({ kind: "text", text: now }));
  try {
    expect(await readRemoteFileBefore(file, tabId, worktree)).toBe(before);
  } finally {
    call.mockRestore();
  }
});

test("beforeOfWorkingText takes Git's LF lines back over a CRLF file only", () => {
  const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }];
  expect(beforeOfWorkingText(hunks, "new\r\nrest\r\n")).toBe("old\r\nrest\r\n");
  expect(beforeOfWorkingText(hunks, "new\nrest\n")).toBe("old\nrest\n");
  expect(beforeOfWorkingText(hunks, "new\r\nrest\n")).toBeNull();
  expect(beforeOfWorkingText(hunks, "other\r\n")).toBeNull();
});
