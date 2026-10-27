import { describe, expect, it } from "bun:test";
import {
  partialFailureMessage,
  reportedFailure,
  thrownFailure,
} from "../../../../../src/renderer/services/fs-mutations/batch-failure";

describe("partialFailureMessage", () => {
  it("names a failure its item already reported, without a reason", () => {
    expect(
      partialFailureMessage(
        "files:fileTree.paste.pastedPartial",
        1,
        3,
        reportedFailure("/repo/src/a.ts"),
      ),
    ).toBe('Pasted 1 of 3 items. Couldn\'t paste "a.ts".');
  });

  it("adds a thrown failure's reason as a phrase", () => {
    expect(
      partialFailureMessage(
        "files:fileTree.dropTarget.movedPartial",
        2,
        3,
        thrownFailure("/repo/src/a.ts", new Error("PERMISSION_DENIED: /repo/src/a.ts")),
      ),
    ).toBe('Moved 2 of 3 items. Couldn\'t move "a.ts": Permission denied.');
  });
});
