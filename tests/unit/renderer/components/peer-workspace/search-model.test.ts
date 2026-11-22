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
import {
  peerPathKey,
  peerRelativePath,
  peerSearchResultPath,
} from "../../../../../src/renderer/utils/peer-path";

test("peer search converts UTF-16 spans and truncated previews into shared result rows", () => {
  expect(
    peerSearchResults("/w", {
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

test("peer search discards paths outside the workspace and bounds long previews around the match", () => {
  const match = {
    line: 2,
    column: 803,
    length: 2,
    text: `${"a".repeat(800)}😀${"b".repeat(600)}`,
    textStart: 3,
  };
  const { groups, matchesFound } = peerSearchResults("/w", {
    files: ["../Run.ts", "src/../Run.ts", "/Run.ts", "D:/Run.ts", "src/Run.ts"].map((path) => ({
      path,
      matches: [match],
    })),
  });
  expect(groups.map((group) => group.relPath)).toEqual(["src/Run.ts"]);
  expect(matchesFound).toBe(1);
  const [{ range, preview, previewStart = 0 }] = groups[0].matches;
  expect(preview).toHaveLength(512);
  expect(preview.slice(range.startCol - previewStart, range.endCol - previewStart)).toBe("😀");
});

test("peer result paths use the host's drive and reject paths outside the workspace", () => {
  expect(peerSearchResultPath("D:/Mixed\\Case", "src/Run.ts")).toBe("D:\\Mixed\\Case\\src\\Run.ts");
  expect(peerSearchResultPath("D:\\", "src/Run.ts")).toBe("D:\\src\\Run.ts");
  expect(peerSearchResultPath("/", "src/Run.ts")).toBe("/src/Run.ts");
  expect(peerSearchResultPath("/w", "src/../Run.ts")).toBeNull();
  expect(peerSearchResultPath("/w", "/Run.ts")).toBeNull();
  expect(peerSearchResultPath("/w", "D:\\Run.ts")).toBeNull();
  expect(peerSearchResultPath("D:/w", "..\\Run.ts")).toBeNull();
});

test("UNC peer roots reject Windows traversal and keep native paths and case-insensitive keys", () => {
  const root = "\\\\Server\\Share\\Project";
  const path = peerSearchResultPath(root, "src/Run.ts");
  expect(path).toBe("\\\\Server\\Share\\Project\\src\\Run.ts");
  expect(peerSearchResultPath("//Server/Share/Project/", "src/Run.ts")).toBe(path);
  expect(peerSearchResultPath(root, "..\\Run.ts")).toBeNull();
  expect(peerSearchResultPath(root, "Run.ts:stream")).toBeNull();
  expect(peerSearchResultPath("/w", "\\\\Server\\Share\\Run.ts")).toBeNull();
  expect(peerPathKey(path!)).toBe("//server/share/project/src/run.ts");
  expect(peerRelativePath(path!, root.toLowerCase())).toBe("src/Run.ts");
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
