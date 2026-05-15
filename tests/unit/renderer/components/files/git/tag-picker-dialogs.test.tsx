/**
 * Scenario tests for tag create/delete dialog content.
 */
import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildCreateTagFields,
  CreateTagRefSelector,
  confirmTagDeleteRequest,
  type DeleteTagRequest,
  TagDeleteConfirmContent,
} from "../../../../../../src/renderer/components/files/git/pickers/tag-picker";
import { FormDialogContent } from "../../../../../../src/renderer/components/ui/form-dialog";
import type { RemoteTag, Tag } from "../../../../../../src/shared/types/git";

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

describe("tag create FormDialog content", () => {
  it("renders required name, optional message, and the at-ref picker affordance", () => {
    const html = renderToStaticMarkup(
      <FormDialogContent
        title="Create tag"
        description="Create a lightweight tag or add a message for an annotated tag."
        fields={buildCreateTagFields()}
        values={{ name: "v1.0.0", message: "release" }}
        submitLabel="Create Tag"
        cancelLabel="Cancel"
        extraContent={<CreateTagRefSelector refName="HEAD" onPickRef={() => {}} />}
        onValueChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("Create tag");
    expect(html).toContain("Name");
    expect(html).toContain("Message");
    expect(html).toContain("Message creates an annotated tag");
    expect(html).toContain("Target ref");
    expect(html).toContain("HEAD");
    expect(html).toContain("at ref…");
    expect(html).toContain("<textarea");
  });
});

describe("tag delete confirmation content", () => {
  it("renders a single local delete confirmation without a remote checkbox", () => {
    const request = deleteRequest({ kind: "local" });
    const html = renderToStaticMarkup(
      <TagDeleteConfirmContent request={request} onCancel={() => {}} onConfirm={() => {}} />,
    );

    expect(html).toContain("Delete tag &#x27;v1.0.0&#x27;?");
    expect(html).toContain("Delete local tag &#x27;v1.0.0&#x27;");
    expect(html).not.toContain("Also delete");
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders a single remote delete confirmation without a local checkbox", () => {
    const request = deleteRequest({ kind: "remote", remote: "origin" });
    const html = renderToStaticMarkup(
      <TagDeleteConfirmContent request={request} onCancel={() => {}} onConfirm={() => {}} />,
    );

    expect(html).toContain("Delete remote tag &#x27;origin/v1.0.0&#x27;?");
    expect(html).toContain("Delete tag &#x27;v1.0.0&#x27; from origin");
    expect(html).not.toContain("Also delete");
    expect(html).not.toContain('type="checkbox"');
  });

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
