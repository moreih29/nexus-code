/** Contract: WorkspaceReorderArgsSchema and WorkspaceReorderedEventSchema */
import { describe, expect, it } from "bun:test";
import {
  WorkspaceReorderArgsSchema,
  WorkspaceReorderedEventSchema,
} from "../../../../src/shared/ipc/contract";

const VALID_ID = "11111111-1111-4111-8111-111111111111";
const VALID_ID2 = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// WorkspaceReorderArgsSchema
// ---------------------------------------------------------------------------

describe("WorkspaceReorderArgsSchema", () => {
  it("accepts id + targetGroup only (tail insertion)", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({
      id: VALID_ID,
      targetGroup: "unpinned",
    });
    expect(result.success).toBe(true);
  });

  it("accepts id + beforeId + targetGroup (insert-after)", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({
      id: VALID_ID,
      beforeId: VALID_ID2,
      targetGroup: "pinned",
    });
    expect(result.success).toBe(true);
  });

  it("accepts id + afterId + targetGroup (insert-before)", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({
      id: VALID_ID,
      afterId: VALID_ID2,
      targetGroup: "unpinned",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when both beforeId and afterId are provided", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({
      id: VALID_ID,
      beforeId: VALID_ID2,
      afterId: VALID_ID2,
      targetGroup: "unpinned",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("beforeId and afterId are mutually exclusive");
    }
  });

  it("rejects missing id", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({
      targetGroup: "unpinned",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing targetGroup", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({ id: VALID_ID });
    expect(result.success).toBe(false);
  });

  it("rejects invalid targetGroup value", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({
      id: VALID_ID,
      targetGroup: "other",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid beforeId", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({
      id: VALID_ID,
      beforeId: "not-a-uuid",
      targetGroup: "unpinned",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkspaceReorderedEventSchema
// ---------------------------------------------------------------------------

describe("WorkspaceReorderedEventSchema", () => {
  it("accepts an orders array with all required fields", () => {
    const result = WorkspaceReorderedEventSchema.safeParse({
      orders: [
        { id: VALID_ID, sortOrder: 1024, pinnedSortOrder: 0, pinned: false },
        { id: VALID_ID2, sortOrder: 2048, pinnedSortOrder: 0, pinned: false },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty orders array", () => {
    const result = WorkspaceReorderedEventSchema.safeParse({ orders: [] });
    expect(result.success).toBe(true);
  });

  it("rejects when orders is missing", () => {
    const result = WorkspaceReorderedEventSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an order entry with a non-integer sortOrder", () => {
    const result = WorkspaceReorderedEventSchema.safeParse({
      orders: [{ id: VALID_ID, sortOrder: 1.5, pinnedSortOrder: 0, pinned: false }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an order entry with a missing pinned field", () => {
    const result = WorkspaceReorderedEventSchema.safeParse({
      orders: [{ id: VALID_ID, sortOrder: 1024, pinnedSortOrder: 0 }],
    });
    expect(result.success).toBe(false);
  });
});
