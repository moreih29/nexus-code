/**
 * Scenario tests for git remote IPC handlers.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  addRemoteHandler,
  removeRemoteHandler,
} from "../../../../../../src/main/ipc/channels/git/remote-handlers";
import { ipcContract } from "../../../../../../src/shared/ipc-contract";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("git remote IPC contract", () => {
  it("accepts add/remove remote args", () => {
    expect(
      ipcContract.git.call.addRemote.args.safeParse({
        workspaceId: VALID_UUID,
        name: "origin",
        url: "https://example.invalid/repo.git",
      }).success,
    ).toBe(true);
    expect(
      ipcContract.git.call.removeRemote.args.safeParse({
        workspaceId: VALID_UUID,
        name: "origin",
      }).success,
    ).toBe(true);
  });
});

describe("git remote handlers", () => {
  it("adds a remote and refreshes capabilities after the mutation", async () => {
    const trace: string[] = [];
    const repo = {
      addRemote: mock(async (name: string, url: string) => {
        trace.push(`add:${name}:${url}`);
      }),
    };
    const registry = {
      getOrDetect: mock(async () => repo),
      bumpGeneration: mock((workspaceId: string) => {
        trace.push(`bump:${workspaceId}`);
      }),
      refreshStatus: mock(async (workspaceId: string) => {
        trace.push(`refresh:${workspaceId}`);
      }),
    };

    await addRemoteHandler(registry as never)({
      workspaceId: VALID_UUID,
      name: "origin",
      url: "https://example.invalid/repo.git",
    });

    expect(repo.addRemote).toHaveBeenCalledWith(
      "origin",
      "https://example.invalid/repo.git",
      undefined,
    );
    expect(trace).toEqual([
      "add:origin:https://example.invalid/repo.git",
      `bump:${VALID_UUID}`,
      `refresh:${VALID_UUID}`,
    ]);
  });

  it("removes a remote and refreshes capabilities after the mutation", async () => {
    const trace: string[] = [];
    const repo = {
      removeRemote: mock(async (name: string) => {
        trace.push(`remove:${name}`);
      }),
    };
    const registry = {
      getOrDetect: mock(async () => repo),
      bumpGeneration: mock((workspaceId: string) => {
        trace.push(`bump:${workspaceId}`);
      }),
      refreshStatus: mock(async (workspaceId: string) => {
        trace.push(`refresh:${workspaceId}`);
      }),
    };

    await removeRemoteHandler(registry as never)({ workspaceId: VALID_UUID, name: "origin" });

    expect(repo.removeRemote).toHaveBeenCalledWith("origin", undefined);
    expect(trace).toEqual(["remove:origin", `bump:${VALID_UUID}`, `refresh:${VALID_UUID}`]);
  });
});
