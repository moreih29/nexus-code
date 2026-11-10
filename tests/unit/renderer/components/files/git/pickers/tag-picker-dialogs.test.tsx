/**
 * Scenario tests for tag delete confirmation: local and remote deletes stay apart.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  confirmTagDeleteRequest,
  type DeleteTagRequest,
} from "../../../../../../../src/renderer/components/files/git/pickers/tag-picker";
import type { RemoteTag, Tag } from "../../../../../../../src/shared/git/types";

const workspaceId = "ws-tags";

const tag: Tag = {
  name: "v1.0.0",
  sha: "0123456789abcdef0123456789abcdef01234567",
  message: "release",
  type: "annotated",
  taggerDate: 1_700_000_000_000,
};

const remoteTag: RemoteTag = {
  remote: "origin",
  name: "v1.0.0",
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  scope: "remote",
};

describe("tag delete confirmation content", () => {
  it("calls only deleteTag for local delete confirmations", async () => {
    const deleteTag = mock(async () => true);
    const deleteRemoteTag = mock(async () => true);
    const onDeleted = mock(() => {});

    const deleted = await confirmTagDeleteRequest(deleteRequest({ kind: "local" }), {
      workspaceId,
      deleteTag,
      deleteRemoteTag,
      onDeleted,
    });

    expect(deleted).toBe(true);
    expect(deleteTag).toHaveBeenCalledWith(workspaceId, "v1.0.0");
    expect(deleteRemoteTag).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("calls only deleteRemoteTag for remote delete confirmations", async () => {
    const deleteTag = mock(async () => true);
    const deleteRemoteTag = mock(async () => true);
    const onDeleted = mock(() => {});

    const deleted = await confirmTagDeleteRequest(
      deleteRequest({ kind: "remote", remote: "origin" }),
      {
        workspaceId,
        deleteTag,
        deleteRemoteTag,
        onDeleted,
      },
    );

    expect(deleted).toBe(true);
    expect(deleteTag).not.toHaveBeenCalled();
    expect(deleteRemoteTag).toHaveBeenCalledWith(workspaceId, "origin", "v1.0.0");
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});

/** Builds a delete request around the default tag fixture. */
function deleteRequest(overrides: Partial<DeleteTagRequest> = {}): DeleteTagRequest {
  const localItem: Extract<DeleteTagRequest["item"], { scope: "local" }> = {
    id: "tag:v1.0.0",
    label: "v1.0.0",
    kindLabel: "annotated",
    kind: "tag",
    scope: "local",
    tag,
  };
  if (overrides.kind === "remote") {
    const remote = overrides.remote ?? "origin";
    return {
      kind: "remote",
      item: {
        id: `tag:remote:${remote}:v1.0.0`,
        label: `${remote}/v1.0.0`,
        kindLabel: "delete",
        kind: "tag",
        scope: "remote",
        remote,
        tag: { ...remoteTag, remote },
        tone: "destructive",
      },
      remote,
    };
  }
  return { kind: "local", item: localItem };
}
