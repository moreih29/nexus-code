import { describe, expect, test } from "bun:test";

import { WORKSPACE_DIFF_READ_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import { createNexusWorkspaceDiffApi } from "./nexus-workspace-diff-api";

describe("createNexusWorkspaceDiffApi", () => {
  test("invokes workspace diff read channel", async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusWorkspaceDiffApi(ipcRenderer);

    await expect(
      api.readWorkspaceDiff({ workspacePath: "/repo", filePath: "src/app.ts" }),
    ).resolves.toEqual({ available: true });

    expect(ipcRenderer.invokeCalls).toEqual([
      {
        channel: WORKSPACE_DIFF_READ_CHANNEL,
        payload: { workspacePath: "/repo", filePath: "src/app.ts" },
      },
    ]);
  });
});

class FakeIpcRenderer {
  public readonly invokeCalls: Array<{ channel: string; payload: unknown }> = [];

  public invoke(channel: string, payload?: unknown): Promise<unknown> {
    this.invokeCalls.push({ channel, payload });
    return Promise.resolve({ available: true });
  }
}
