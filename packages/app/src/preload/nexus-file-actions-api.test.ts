import { describe, expect, test } from "bun:test";

import { FILE_ACTIONS_INVOKE_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { FileActionsRequest, FileActionsResult } from "../common/file-actions";
import { createNexusFileActionsApi } from "./nexus-file-actions-api";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("createNexusFileActionsApi", () => {
  test("invokes the file-actions IPC channel with the original request payload", async () => {
    const calls: Array<{ channel: string; request: FileActionsRequest }> = [];
    const api = createNexusFileActionsApi({
      async invoke(channel: string, request: FileActionsRequest): Promise<FileActionsResult> {
        calls.push({ channel, request });
        return {
          type: "file-actions/shell/result",
          action: "revealInFinder",
          workspaceId,
          path: "src/index.ts",
          absolutePath: "/tmp/alpha/src/index.ts",
        };
      },
    });

    const request: FileActionsRequest = {
      type: "file-actions/reveal-in-finder",
      workspaceId,
      path: "src/index.ts",
    };
    const result = await api.invoke(request);

    expect(calls).toEqual([{ channel: FILE_ACTIONS_INVOKE_CHANNEL, request }]);
    expect(result).toMatchObject({
      type: "file-actions/shell/result",
      action: "revealInFinder",
      absolutePath: "/tmp/alpha/src/index.ts",
    });
  });
});
