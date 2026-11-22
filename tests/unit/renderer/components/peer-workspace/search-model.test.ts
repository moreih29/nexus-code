import { expect, test } from "bun:test";
import i18next from "i18next";
import {
  openPeerResult,
  parsePeerSearchFilters,
  peerSearchErrorKey,
  peerSearchResults,
} from "../../../../../src/renderer/components/peer-workspace/search-model";
import {
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../../../../src/renderer/state/stores/peer-workspace";
import { peerSearchResultPath } from "../../../../../src/renderer/utils/peer-path";

test("peer search converts UTF-16 spans and truncated previews into shared result rows", () => {
  expect(
    peerSearchResults({
      files: [
        {
          path: "src/hello.ts",
          matches: [{ line: 3, column: 27, length: 2, text: "😀", textStart: 27 }],
        },
        { path: "src/hello.ts", matches: [{ line: 8, column: 0, length: 3, text: "foo" }] },
      ],
      truncated: true,
    }),
  ).toEqual({
    groups: [
      {
        relPath: "src/hello.ts",
        expanded: true,
        matches: [
          { range: { line: 2, startCol: 27, endCol: 29 }, preview: "😀", previewStart: 27 },
          { range: { line: 7, startCol: 0, endCol: 3 }, preview: "foo" },
        ],
      },
    ],
    matchesFound: 2,
    truncated: true,
  });
});

test("peer result paths use the host's drive and reject paths outside the workspace", () => {
  expect(peerSearchResultPath("D:/Mixed\\Case", "src/Run.ts")).toBe("D:\\Mixed\\Case\\src\\Run.ts");
  expect(peerSearchResultPath("D:\\", "src/Run.ts")).toBe("D:\\src\\Run.ts");
  expect(peerSearchResultPath("/", "src/Run.ts")).toBe("/src/Run.ts");
  expect(peerSearchResultPath("/w", "src/../Run.ts")).toBeNull();
  expect(peerSearchResultPath("/w", "/Run.ts")).toBeNull();
  expect(peerSearchResultPath("D:/w", "..\\Run.ts")).toBeNull();
});

test("search filters go to the host as bounded names or extensions, with folders for excludes", () => {
  expect(parsePeerSearchFilters("*.ts, README.md, *.ts", false)).toEqual(["*.ts", "README.md"]);
  expect(parsePeerSearchFilters("fixtures/, *.map", true)).toEqual(["fixtures/", "*.map"]);
  expect(parsePeerSearchFilters("fixtures/", false)).toBeNull();
  expect(parsePeerSearchFilters("src/**/*.ts", true)).toBeNull();
  expect(parsePeerSearchFilters("x".repeat(257), true)).toBeNull();
  expect(
    parsePeerSearchFilters(Array.from({ length: 33 }, (_, i) => `x${i}`).join(","), true),
  ).toBeNull();
});

test("unsupported peer searches use the update message", () => {
  expect(i18next.t(peerSearchErrorKey("unsupported"))).toBe("App update needed on that computer");
});

test("opening a Windows match selects the existing peer tab and sends it to the match", () => {
  const before = usePeerWorkspaceStore.getState();
  const target: PeerWorkspaceTarget = {
    accountKey: "account",
    deviceId: "peer",
    deviceName: "PC",
    platform: "win32",
    workspaceId: "project",
    workspace: { id: "project", name: "Project", path: "D:/project" },
  };
  const id = peerTargetId(target);
  try {
    before.select(target, null);
    before.openFile(id, "d:/PROJECT/src/hello.ts");
    openPeerResult(target, "src/Hello.ts", true, { line: 9, startCol: 4, endCol: 9 });
    openPeerResult(target, "src/offline.ts", false);
    const view = usePeerWorkspaceStore.getState().views[id];
    expect(view.activePath).toBe("d:/PROJECT/src/hello.ts");
    expect(view.tabs).toEqual([
      {
        type: "peer.file",
        path: "d:/PROJECT/src/hello.ts",
        at: { line: 10, column: 5 },
      },
    ]);
  } finally {
    usePeerWorkspaceStore.setState(before, true);
  }
});
