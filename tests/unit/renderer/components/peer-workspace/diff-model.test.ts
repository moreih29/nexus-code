import { expect, spyOn, test } from "bun:test";
import {
  type DiffHunk,
  MAX_BYTES_CHUNK,
  type RpcResult,
} from "../../../../../packages/remote-protocol/src/rpc";
import {
  loadPeerDiff,
  reconstructPeerDiff,
} from "../../../../../src/renderer/components/peer-workspace/diff-model";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { PEER_WORKSPACE_TEXT_LIMIT } from "../../../../../src/renderer/services/remote/peer-workspace";
import type { PeerWorkspaceTarget } from "../../../../../src/renderer/state/stores/peer-workspace";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const path = "src/run.ts";
const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "other",
  deviceName: "Desktop",
  platform: "win32",
  workspaceId: "w",
  workspace: { id: "w", name: "Project", path: "D:\\Project" },
};
const text = (value: string) => ({ kind: "text" as const, text: value });
const patch = (hunks: DiffHunk[]): RpcResult<"git.diff"> => ({ path, hunks });
const edit = (before: string, after: string) =>
  patch([
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${before}`, `+${after}`] },
  ]);

test("staged-only changes compare HEAD to INDEX and unstaged changes compare INDEX to WORKING", () => {
  expect(
    reconstructPeerDiff({ path, staged: "M" }, "staged", edit("head", "index"), text("index\n")),
  ).toMatchObject({
    kind: "text",
    before: "head\n",
    after: "index\n",
  });
  expect(
    reconstructPeerDiff(
      { path, unstaged: "M" },
      "unstaged",
      edit("index", "working"),
      text("working\n"),
    ),
  ).toMatchObject({
    kind: "text",
    before: "index\n",
    after: "working\n",
  });
});

test("with changes on both sides, reverse WORKING to INDEX before undoing the staged patch", () => {
  const change = { path, staged: "M", unstaged: "M" };
  const unstaged = edit("index", "working");
  const working = text("working\n");
  expect(
    reconstructPeerDiff(change, "staged", edit("head", "index"), working, unstaged),
  ).toMatchObject({
    kind: "text",
    before: "head\n",
    after: "index\n",
  });
  expect(reconstructPeerDiff(change, "unstaged", unstaged, working)).toMatchObject({
    kind: "text",
    before: "index\n",
    after: "working\n",
  });
});

test("added and untracked files start empty and a deleted file ends empty", () => {
  const addition = patch([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+new"] }]);
  const deletion = patch([
    { oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ["-a", "-b"] },
  ]);
  expect(
    reconstructPeerDiff({ path, staged: "A" }, "staged", addition, text("new\n")),
  ).toMatchObject({
    kind: "text",
    before: "",
    after: "new\n",
  });
  expect(
    reconstructPeerDiff({ path, unstaged: "?" }, "unstaged", addition, text("new\n")),
  ).toMatchObject({
    kind: "text",
    before: "",
    after: "new\n",
  });
  expect(
    reconstructPeerDiff({ path, unstaged: "D" }, "unstaged", deletion, text("")),
  ).toMatchObject({
    kind: "text",
    before: "a\nb\n",
    after: "",
  });
  expect(
    reconstructPeerDiff({ path, staged: "D", unstaged: "?" }, "staged", deletion, text("new\n")),
  ).toMatchObject({
    kind: "text",
    before: "a\nb\n",
    after: "",
  });
  expect(
    reconstructPeerDiff(
      { path, staged: "M", unstaged: "D" },
      "staged",
      edit("head", "a"),
      text(""),
      deletion,
    ),
  ).toMatchObject({
    kind: "text",
    before: "head\nb\n",
    after: "a\nb\n",
  });
});

test("a rename compares the old path to the new path, including a rename without hunks", () => {
  const oldPath = "old/run.ts";
  const change = { path, oldPath, staged: "R", unstaged: "M" };
  const original = { ...patch([]), oldPath };
  const working = text("b\n");
  const workingPatch = { ...edit("a", "b"), oldPath };
  expect(reconstructPeerDiff(change, "staged", original, working, workingPatch)).toEqual({
    kind: "text",
    before: "a\n",
    after: "a\n",
    oldPath,
  });
  expect(reconstructPeerDiff(change, "unstaged", workingPatch, working)).toMatchObject({
    kind: "text",
    before: "a\n",
    after: "b\n",
    oldPath: undefined,
  });
});

test("a CRLF working tree reconstructs with literal CRLF or normalized Git hunks", () => {
  const change = { path, unstaged: "M" };
  for (const diff of [edit("a", "b"), edit("a\r", "b\r")]) {
    expect(reconstructPeerDiff(change, "unstaged", diff, text("b\r\nunchanged\r\n"))).toMatchObject(
      {
        kind: "text",
        before: "a\r\nunchanged\r\n",
        after: "b\r\nunchanged\r\n",
      },
    );
  }
});

test("a long unchanged region can be reconstructed without spreading its lines", () => {
  const unchanged = "unchanged\n".repeat(300_000);
  expect(
    reconstructPeerDiff(
      { path, unstaged: "M" },
      "unstaged",
      edit("a", "b"),
      text(`b\n${unchanged}`),
    ),
  ).toMatchObject({
    kind: "text",
    before: `a\n${unchanged}`,
  });
});

test("a mismatch, truncation, binary file, or oversized file falls back to the selected hunks", () => {
  const change = { path, unstaged: "M" };
  const diff = edit("a", "b");
  for (const unavailable of [
    text("changed again\n"),
    { ...text("b\n"), truncated: true },
    { kind: "binary" as const },
    { kind: "too_large" as const },
    { kind: "failed" as const, reason: "permission-denied" },
  ]) {
    expect(reconstructPeerDiff(change, "unstaged", diff, unavailable)).toEqual({
      kind: "patch",
      patch: diff,
    });
  }
  for (const limited of [
    { ...diff, truncated: true },
    { ...diff, binary: true },
  ]) {
    expect(reconstructPeerDiff(change, "unstaged", limited, text("b\n"))).toEqual({
      kind: "patch",
      patch: limited,
    });
  }
  expect(
    reconstructPeerDiff({ ...change, staged: "M" }, "staged", diff, text("c\n"), {
      ...edit("b", "c"),
      truncated: true,
    }),
  ).toEqual({
    kind: "patch",
    patch: diff,
  });
});

test.each([
  { hint: "M", name: "reported" },
  { hint: undefined, name: "unreported" },
])("a staged diff reverses $name working edits and reads the peer Windows path", async ({
  hint,
}) => {
  const working = Buffer.from("working\n");
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcOk(edit("head", "index")))
    .mockResolvedValueOnce(ipcOk(edit("index", "working")))
    .mockResolvedValueOnce(
      ipcOk({ parts: [working.subarray(0, 1).toString("base64")], size: working.length }),
    )
    .mockResolvedValueOnce(ipcOk({ parts: [working.toString("base64")], size: working.length }));
  const { signal } = new AbortController();
  try {
    const change = { path, staged: "M", unstaged: hint };
    expect(await loadPeerDiff(target, change, "staged", signal)).toMatchObject({
      kind: "text",
      before: "head\n",
      after: "index\n",
    });
    const peer = { deviceId: "other", workspaceId: "w" };
    const relative = { ...peer, path };
    const absolute = { ...peer, path: "D:\\Project\\src\\run.ts" };
    expect(call.mock.calls.map(([channel, method, params]) => [channel, method, params])).toEqual([
      ["remote", "peerGitDiff", { ...relative, staged: true }],
      ["remote", "peerGitDiff", { ...relative, staged: false }],
      ["remote", "peerFilesReadBytes", { ...absolute, offset: 0, length: 1 }],
      [
        "remote",
        "peerFilesReadBytes",
        { ...absolute, offset: 0, length: MAX_BYTES_CHUNK, whole: true },
      ],
    ]);
  } finally {
    call.mockRestore();
  }
});

test("forbidden and oversized text reads keep the patch without downloading file content", async () => {
  const diff = edit("a", "b");
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcOk(diff))
    .mockResolvedValueOnce(ipcErr("permission-denied", "outside the workspace"))
    .mockResolvedValueOnce(ipcOk(diff))
    .mockResolvedValueOnce(ipcOk({ parts: ["Yg=="], size: PEER_WORKSPACE_TEXT_LIMIT + 1 }))
    .mockResolvedValueOnce(ipcErr("permission-denied", "outside the workspace"));
  const { signal } = new AbortController();
  try {
    const change = { path, unstaged: "M" };
    expect(await loadPeerDiff(target, change, "unstaged", signal)).toEqual({
      kind: "patch",
      patch: diff,
    });
    expect(await loadPeerDiff(target, change, "unstaged", signal)).toEqual({
      kind: "patch",
      patch: diff,
    });
    expect(await loadPeerDiff(target, { path, unstaged: "?" }, "unstaged", signal)).toMatchObject({
      kind: "patch",
      permissionDenied: true,
      patch: { hunks: [] },
    });
    expect(
      await loadPeerDiff(target, { path: "../outside", unstaged: "M" }, "unstaged", signal),
    ).toMatchObject({
      kind: "patch",
      permissionDenied: true,
      patch: { hunks: [] },
    });
    expect(call.mock.calls.map((entry) => entry[1])).toEqual([
      "peerGitDiff",
      "peerFilesReadBytes",
      "peerGitDiff",
      "peerFilesReadBytes",
      "peerGitDiff",
    ]);
  } finally {
    call.mockRestore();
  }
});

test.each([
  "a\nb",
  "a\nb\n",
])("the diff falls back when the last line only changes its ending (%j)", (working) => {
  const diff = patch([
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+b"] },
  ]);
  expect(reconstructPeerDiff({ path, unstaged: "M" }, "unstaged", diff, text(working))).toEqual({
    kind: "patch",
    patch: diff,
  });
});

test("an untracked patch must account for the entire working file", () => {
  const diff = patch([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+mine"] }]);
  for (const working of ["someone else's file\n", "mine\nand an unrelated line\n"]) {
    expect(reconstructPeerDiff({ path, unstaged: "?" }, "unstaged", diff, text(working))).toEqual({
      kind: "patch",
      patch: diff,
    });
  }
});

test("a fresh NotFound unstaged diff overrides a stale working-change status", async () => {
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcOk(edit("head", "index")))
    .mockResolvedValueOnce(ipcErr("not-found", "no unstaged change"))
    .mockResolvedValueOnce(ipcOk({ parts: ["aQ=="], size: 6 }))
    .mockResolvedValueOnce(ipcOk({ parts: ["aW5kZXgK"], size: 6 }));
  try {
    const { signal } = new AbortController();
    expect(
      await loadPeerDiff(target, { path, staged: "M", unstaged: "D" }, "staged", signal),
    ).toMatchObject({
      kind: "text",
      before: "head\n",
      after: "index\n",
    });
  } finally {
    call.mockRestore();
  }
});

test.each([
  {
    type: "POSIX",
    topLevel: "/repo",
    root: "/repo/apps/demo",
    gitPath: "apps/demo/src/run.ts",
    absolute: "/repo/apps/demo/src/run.ts",
  },
  {
    type: "Windows drive",
    topLevel: "d:/REPO/",
    root: "D:\\Repo\\apps/demo",
    gitPath: "Apps/Demo/src/run.ts",
    absolute: "D:\\Repo\\apps\\demo\\src\\run.ts",
  },
  {
    type: "Windows UNC",
    topLevel: "//SERVER/Share/Repo",
    root: "\\\\server\\share\\repo\\apps/demo",
    gitPath: "Apps/Demo/src/run.ts",
    absolute: "\\\\server\\share\\repo\\apps\\demo\\src\\run.ts",
  },
  {
    type: "Windows drive root",
    topLevel: "D:\\",
    root: "d:/",
    gitPath: path,
    absolute: "D:\\src\\run.ts",
  },
  {
    type: "workspace outside of topLevel",
    topLevel: "/repo/app",
    root: "/repo/app-link",
    gitPath: path,
    absolute: "/repo/app-link/src/run.ts",
  },
])("loads the correct working file for $type", async ({ topLevel, root, gitPath, absolute }) => {
  const diff = { ...edit("a", "b"), path: gitPath };
  const peer = { deviceId: target.deviceId, workspaceId: target.workspaceId };
  const { signal } = new AbortController();
  const call = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcOk(diff))
    .mockResolvedValueOnce(ipcOk({ parts: ["Yg=="], size: 2 }))
    .mockResolvedValueOnce(ipcOk({ parts: ["Ygo="], size: 2 }));
  try {
    const nested = { ...target, workspace: { ...target.workspace, path: root } };
    expect(
      await loadPeerDiff(nested, { path: gitPath, unstaged: "M" }, "unstaged", signal, topLevel),
    ).toMatchObject({
      kind: "text",
      before: "a\n",
      after: "b\n",
    });
    expect(call.mock.calls.map(([channel, method, args]) => [channel, method, args])).toEqual([
      ["remote", "peerGitDiff", { ...peer, path: gitPath, staged: false }],
      ["remote", "peerFilesReadBytes", { ...peer, path: absolute, offset: 0, length: 1 }],
      [
        "remote",
        "peerFilesReadBytes",
        { ...peer, path: absolute, offset: 0, length: MAX_BYTES_CHUNK, whole: true },
      ],
    ]);
  } finally {
    call.mockRestore();
  }
});

test("a Git change outside a nested workspace still shows its hunks without reading the file", async () => {
  const gitPath = "app-other/src/run.ts";
  const diff = { ...edit("a", "b"), path: gitPath };
  const nested = { ...target, workspace: { ...target.workspace, path: "/repo/app" } };
  const { signal } = new AbortController();
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValueOnce(ipcOk(diff));
  try {
    expect(
      await loadPeerDiff(nested, { path: gitPath, unstaged: "M" }, "unstaged", signal, "/repo"),
    ).toEqual({
      kind: "patch",
      patch: diff,
      permissionDenied: true,
    });
    expect(call.mock.calls.map((call) => call[1])).toEqual(["peerGitDiff"]);
  } finally {
    call.mockRestore();
  }
});
