import { describe, it, expect } from "bun:test";
import {
  SerializedLeafSchema,
  SerializedNodeSchema,
  WorkspaceLayoutSnapshotSchema,
} from "../../../../src/shared/types/layout";
import { AppStateSchema } from "../../../../src/shared/types/app-state";

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
  it("parses a valid leaf", () => {
    const result = SerializedLeafSchema.safeParse(validLeaf);
    expect(result.success).toBe(true);
  });

  it("accepts null activeTabId", () => {
    const result = SerializedLeafSchema.safeParse({ ...validLeaf, activeTabId: null });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SerializedNodeSchema — leaf variant
// ---------------------------------------------------------------------------

describe("SerializedNodeSchema — leaf", () => {
  it("parses a valid leaf node", () => {
    const result = SerializedNodeSchema.safeParse(validLeaf);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const result = SerializedNodeSchema.safeParse({ ...validLeaf, kind: "group" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing kind field", () => {
    const { kind: _k, ...noKind } = validLeaf;
    const result = SerializedNodeSchema.safeParse(noKind);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SerializedNodeSchema — split variant
// ---------------------------------------------------------------------------

describe("SerializedNodeSchema — split", () => {
  it("parses a valid split node", () => {
    const result = SerializedNodeSchema.safeParse(validSplit);
    expect(result.success).toBe(true);
  });

  it("rejects ratio below 0.05", () => {
    const result = SerializedNodeSchema.safeParse({ ...validSplit, ratio: 0.04 });
    expect(result.success).toBe(false);
  });

  it("rejects ratio above 0.95", () => {
    const result = SerializedNodeSchema.safeParse({ ...validSplit, ratio: 0.96 });
    expect(result.success).toBe(false);
  });

  it("accepts ratio exactly 0.05", () => {
    const result = SerializedNodeSchema.safeParse({ ...validSplit, ratio: 0.05 });
    expect(result.success).toBe(true);
  });

  it("accepts ratio exactly 0.95", () => {
    const result = SerializedNodeSchema.safeParse({ ...validSplit, ratio: 0.95 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deep nesting
// ---------------------------------------------------------------------------

describe("SerializedNodeSchema — deep nesting", () => {
  it("parses a deeply nested split tree", () => {
    const DEEP1 = "77777777-7777-4777-a777-777777777771";
    const DEEP2 = "77777777-7777-4777-a777-777777777772";
    const DEEP3 = "77777777-7777-4777-a777-777777777773";
    const DEEP4 = "77777777-7777-4777-a777-777777777774";
    const DEEP5 = "77777777-7777-4777-a777-777777777775";

    const deepTree = {
      kind: "split" as const,
      id: DEEP1,
      orientation: "vertical" as const,
      ratio: 0.6,
      first: {
        kind: "split" as const,
        id: DEEP2,
        orientation: "horizontal" as const,
        ratio: 0.4,
        first: { kind: "leaf" as const, id: DEEP3, tabIds: [], activeTabId: null },
        second: { kind: "leaf" as const, id: DEEP4, tabIds: [], activeTabId: null },
      },
      second: { kind: "leaf" as const, id: DEEP5, tabIds: [], activeTabId: null },
    };

    const result = SerializedNodeSchema.safeParse(deepTree);
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

  it("parses a valid snapshot", () => {
    const result = WorkspaceLayoutSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("round-trips through JSON.stringify and parse", () => {
    const parsed = WorkspaceLayoutSnapshotSchema.parse(snapshot);
    const json = JSON.stringify(parsed);
    const reparsed = WorkspaceLayoutSnapshotSchema.parse(JSON.parse(json));
    expect(reparsed).toEqual(parsed);
  });

  it("parses a snapshot with editor tab", () => {
    const EDITOR_TAB = "88888888-8888-4888-a888-888888888888";
    const result = WorkspaceLayoutSnapshotSchema.safeParse({
      ...snapshot,
      tabs: [
        {
          id: EDITOR_TAB,
          type: "editor" as const,
          title: "main.ts",
          props: { filePath: "/src/main.ts", workspaceId: WS_ID },
        },
      ],
    });
    expect(result.success).toBe(true);
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

  it("parses an AppState with an empty layoutByWorkspace", () => {
    const result = AppStateSchema.safeParse({
      layoutByWorkspace: {},
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
