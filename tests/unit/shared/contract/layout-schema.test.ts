import { describe, expect, it } from "bun:test";
import { AppStateSchema } from "../../../../src/shared/types/app-state";
import {
  SerializedLeafSchema,
  WorkspaceLayoutSnapshotSchema,
} from "../../../../src/shared/types/layout";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LEAF_ID = "11111111-1111-4111-a111-111111111111";
const SPLIT_ID = "22222222-2222-4222-a222-222222222222";
const INNER_LEAF_ID = "33333333-3333-4333-a333-333333333333";
const INNER_LEAF2_ID = "44444444-4444-4444-a444-444444444444";
const TAB_ID = "55555555-5555-4555-a555-555555555555";
const WS_ID = "66666666-6666-4666-a666-666666666666";

const validLeaf = {
  kind: "leaf" as const,
  id: LEAF_ID,
  tabIds: [TAB_ID],
  activeTabId: TAB_ID,
};

const validSplit = {
  kind: "split" as const,
  id: SPLIT_ID,
  orientation: "horizontal" as const,
  ratio: 0.5,
  first: { kind: "leaf" as const, id: INNER_LEAF_ID, tabIds: [], activeTabId: null },
  second: { kind: "leaf" as const, id: INNER_LEAF2_ID, tabIds: [], activeTabId: null },
};

// ---------------------------------------------------------------------------
// SerializedLeafSchema
// ---------------------------------------------------------------------------

describe("SerializedLeafSchema", () => {
  it("accepts null activeTabId", () => {
    const result = SerializedLeafSchema.safeParse({ ...validLeaf, activeTabId: null });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WorkspaceLayoutSnapshot
// ---------------------------------------------------------------------------

describe("WorkspaceLayoutSnapshotSchema", () => {
  const snapshot = {
    root: validSplit,
    activeGroupId: INNER_LEAF_ID,
    tabs: [
      {
        id: TAB_ID,
        type: "terminal" as const,
        title: "Terminal",
        props: { cwd: "/home/user" },
      },
    ],
  };

  it("keeps a terminal tab's shell across a restart", () => {
    const shell = { kind: "detected" as const, id: "git-bash" };
    const parsed = WorkspaceLayoutSnapshotSchema.parse({
      ...snapshot,
      tabs: [{ ...snapshot.tabs[0], props: { cwd: "/home/user", shell } }],
    });
    expect(parsed.tabs[0]?.props).toEqual({ cwd: "/home/user", shell });
  });

  it("keeps an editor tab's source or preview mode across a restart", () => {
    const editor = {
      id: "88888888-8888-4888-a888-888888888888",
      type: "editor" as const,
      title: "README.md",
      props: { filePath: "/README.md", workspaceId: WS_ID },
    };
    const parsed = WorkspaceLayoutSnapshotSchema.parse({
      ...snapshot,
      tabs: [
        { ...editor, viewMode: "raw" },
        { ...editor, id: TAB_ID },
      ],
    });
    expect(parsed.tabs.map((tab) => ("viewMode" in tab ? tab.viewMode : undefined))).toEqual([
      "raw",
      undefined,
    ]);
    expect(
      WorkspaceLayoutSnapshotSchema.safeParse({
        ...snapshot,
        tabs: [{ ...editor, viewMode: "split" }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AppStateSchema backward-compat
// ---------------------------------------------------------------------------

describe("AppStateSchema — backward-compat", () => {
  it("parses an AppState without layoutByWorkspace (legacy)", () => {
    const result = AppStateSchema.safeParse({
      windowBounds: { x: 0, y: 0, width: 1280, height: 800 },
      lastActiveWorkspaceId: WS_ID,
    });
    expect(result.success).toBe(true);
  });

  it("parses an AppState with a populated layoutByWorkspace", () => {
    const result = AppStateSchema.safeParse({
      layoutByWorkspace: {
        [WS_ID]: {
          root: validLeaf,
          activeGroupId: LEAF_ID,
          tabs: [],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
