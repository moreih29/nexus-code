/** Contract: WorkspaceReorderArgsSchema's beforeId/afterId exclusivity rule */
import { describe, expect, it } from "bun:test";
import { WorkspaceReorderArgsSchema } from "../../../../src/shared/ipc/contract";

const VALID_ID = "11111111-1111-4111-8111-111111111111";
const VALID_ID2 = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// WorkspaceReorderArgsSchema
// ---------------------------------------------------------------------------

describe("WorkspaceReorderArgsSchema", () => {
  it("accepts at most one of beforeId and afterId", () => {
    const cases = [
      { id: VALID_ID, targetGroup: "unpinned" }, // tail insertion
      { id: VALID_ID, beforeId: VALID_ID2, targetGroup: "pinned" }, // insert-after
      { id: VALID_ID, afterId: VALID_ID2, targetGroup: "unpinned" }, // insert-before
    ];
    for (const args of cases) {
      expect(WorkspaceReorderArgsSchema.safeParse(args).success, JSON.stringify(args)).toBe(true);
    }
  });

  it("rejects when both beforeId and afterId are provided", () => {
    const result = WorkspaceReorderArgsSchema.safeParse({
      id: VALID_ID,
      beforeId: VALID_ID2,
      afterId: VALID_ID2,
      targetGroup: "unpinned",
    });
    expect(result.success).toBe(false);
  });
});
