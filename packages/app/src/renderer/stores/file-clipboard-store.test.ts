import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { FileActionsRequest, FileActionsResult, FilePasteCollision, FilePasteRequest } from "../../common/file-actions";
import { createFileClipboardStore } from "./file-clipboard-store";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("file clipboard store", () => {
  test("tracks copy/cut items and sends paste requests", async () => {
    const requests: FileActionsRequest[] = [];
    const store = createFileClipboardStore({
      async invoke(request) {
        requests.push(request);
        return pasteResult(request as FilePasteRequest, []);
      },
    });

    store.getState().copy([
      { workspaceId, path: "src/index.ts", kind: "file" },
      { workspaceId, path: "src/index.ts", kind: "file" },
    ]);

    expect(store.getState().clipboard?.operation).toBe("copy");
    expect(store.getState().clipboard?.items).toHaveLength(1);
    expect(store.getState().hasClipboardItems()).toBe(true);

    const result = await store.getState().paste({ workspaceId, targetDirectory: "src" });

    expect(result?.applied).toHaveLength(1);
    expect((requests[0] as FilePasteRequest).conflictStrategy).toBe("prompt");
    expect((requests[0] as FilePasteRequest).targetDirectory).toBe("src");
    expect(store.getState().clipboard?.operation).toBe("copy");
  });

  test("keeps cut clipboard when paste collides and clears after resolving", async () => {
    const requests: FilePasteRequest[] = [];
    const store = createFileClipboardStore({
      async invoke(request) {
        const pasteRequest = request as FilePasteRequest;
        requests.push(pasteRequest);
        if (pasteRequest.conflictStrategy === "prompt") {
          return pasteResult(pasteRequest, [
            { sourcePath: "src/index.ts", targetPath: "dest/index.ts", kind: "file" },
          ]);
        }
        return pasteResult(pasteRequest, []);
      },
    });

    store.getState().cut([{ workspaceId, path: "src/index.ts", kind: "file" }]);

    const collisionResult = await store.getState().paste({ workspaceId, targetDirectory: "dest" });
    expect(collisionResult?.collisions).toHaveLength(1);
    expect(store.getState().pendingCollision?.collisions[0]?.targetPath).toBe("dest/index.ts");
    expect(store.getState().clipboard?.operation).toBe("cut");

    const resolvedResult = await store.getState().resolvePendingCollision("replace");
    expect(resolvedResult?.applied).toHaveLength(1);
    expect(requests.map((request) => request.conflictStrategy)).toEqual(["prompt", "replace"]);
    expect(store.getState().pendingCollision).toBeNull();
    expect(store.getState().clipboard).toBeNull();
  });
});

function pasteResult(
  request: FilePasteRequest,
  collisions: FilePasteCollision[],
): FileActionsResult {
  return {
    type: "file-actions/clipboard/paste/result",
    workspaceId: request.workspaceId,
    operation: request.operation,
    applied: collisions.length > 0
      ? []
      : request.entries.map((entry) => ({
          sourceWorkspaceId: entry.workspaceId,
          sourcePath: entry.path,
          targetWorkspaceId: request.workspaceId,
          targetPath: `${request.targetDirectory ?? ""}/${entry.path.split("/").at(-1)}`.replace(/^\//, ""),
          kind: entry.kind,
          operation: request.operation,
        })),
    collisions,
    skipped: [],
  };
}
