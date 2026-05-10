/**
 * Scenario tests for git tag IPC handlers.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  createTagHandler,
  deleteRemoteTagHandler,
  deleteTagHandler,
  listTagsHandler,
} from "../../../../../../src/main/ipc/channels/git/tag-handlers";
import { ipcContract } from "../../../../../../src/shared/ipc-contract";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("git tag IPC contract", () => {
  it("accepts list/create/delete/delete-remote tag args", () => {
    expect(ipcContract.git.call.listTags.args.safeParse({ workspaceId: VALID_UUID }).success).toBe(
      true,
    );
    expect(
      ipcContract.git.call.createTag.args.safeParse({
        workspaceId: VALID_UUID,
        name: "v1.0.0",
        ref: "HEAD",
        message: "release",
      }).success,
    ).toBe(true);
    expect(
      ipcContract.git.call.deleteTag.args.safeParse({
        workspaceId: VALID_UUID,
        name: "v1.0.0",
      }).success,
    ).toBe(true);
    expect(
      ipcContract.git.call.deleteRemoteTag.args.safeParse({
        workspaceId: VALID_UUID,
        remote: "origin",
        name: "v1.0.0",
      }).success,
    ).toBe(true);
  });
});

describe("git tag handlers", () => {
  it("lists tags without forcing a status refresh", async () => {
    const tag = {
      name: "v1.0.0",
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      message: "release",
      type: "annotated" as const,
      taggerDate: 1_700_000_000_000,
    };
    const repo = { listTags: mock(async () => [tag]) };
    const registry = {
      getOrDetect: mock(async () => repo),
      bumpGeneration: mock(() => {}),
      refreshStatus: mock(async () => {}),
    };

    const result = await listTagsHandler(registry as never)({ workspaceId: VALID_UUID });

    expect(result).toEqual([tag]);
    expect(registry.bumpGeneration).not.toHaveBeenCalled();
    expect(registry.refreshStatus).not.toHaveBeenCalled();
  });

  it("creates a tag and refreshes tagCount after the mutation", async () => {
    const trace: string[] = [];
    const repo = {
      createTag: mock(async (name: string) => {
        trace.push(`create:${name}`);
      }),
    };
    const registry = registryWithTrace(repo, trace);

    await createTagHandler(registry as never)({
      workspaceId: VALID_UUID,
      name: "v1.0.0",
      ref: "HEAD",
      message: "release",
    });

    expect(repo.createTag).toHaveBeenCalledWith(
      "v1.0.0",
      { ref: "HEAD", message: "release" },
      undefined,
    );
    expect(trace).toEqual(["create:v1.0.0", `bump:${VALID_UUID}`, `refresh:${VALID_UUID}`]);
  });

  it("deletes local and remote tags then refreshes tagCount", async () => {
    const localTrace: string[] = [];
    const localRepo = {
      deleteTag: mock(async (name: string) => {
        localTrace.push(`delete:${name}`);
      }),
    };
    const localRegistry = registryWithTrace(localRepo, localTrace);

    await deleteTagHandler(localRegistry as never)({ workspaceId: VALID_UUID, name: "v1.0.0" });

    expect(localRepo.deleteTag).toHaveBeenCalledWith("v1.0.0", undefined);
    expect(localTrace).toEqual(["delete:v1.0.0", `bump:${VALID_UUID}`, `refresh:${VALID_UUID}`]);

    const remoteTrace: string[] = [];
    const remoteRepo = {
      deleteRemoteTag: mock(async (remote: string, name: string) => {
        remoteTrace.push(`delete-remote:${remote}:${name}`);
      }),
    };
    const remoteRegistry = registryWithTrace(remoteRepo, remoteTrace);

    await deleteRemoteTagHandler(remoteRegistry as never)({
      workspaceId: VALID_UUID,
      remote: "origin",
      name: "v1.0.0",
    });

    expect(remoteRepo.deleteRemoteTag).toHaveBeenCalledWith("origin", "v1.0.0", undefined);
    expect(remoteTrace).toEqual([
      "delete-remote:origin:v1.0.0",
      `bump:${VALID_UUID}`,
      `refresh:${VALID_UUID}`,
    ]);
  });
});

/** Builds a mock registry that records refresh ordering. */
function registryWithTrace(repo: unknown, trace: string[]) {
  return {
    getOrDetect: mock(async () => repo),
    bumpGeneration: mock((workspaceId: string) => {
      trace.push(`bump:${workspaceId}`);
    }),
    refreshStatus: mock(async (workspaceId: string) => {
      trace.push(`refresh:${workspaceId}`);
    }),
  };
}
