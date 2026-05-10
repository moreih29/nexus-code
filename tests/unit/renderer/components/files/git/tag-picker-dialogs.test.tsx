/**
 * Scenario tests for tag create/delete dialog content.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildCreateTagFields,
  CreateTagRefSelector,
  type DeleteTagRequest,
  TagDeleteConfirmContent,
} from "../../../../../../src/renderer/components/files/git/TagPicker";
import { FormDialogContent } from "../../../../../../src/renderer/components/ui/form-dialog";
import type { Tag } from "../../../../../../src/shared/types/git";

const tag: Tag = {
  name: "v1.0.0",
  sha: "0123456789abcdef0123456789abcdef01234567",
  message: "release",
  type: "annotated",
  taggerDate: 1_700_000_000_000,
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
  it("defaults the origin remote checkbox off", () => {
    const request = deleteRequest({ includeRemote: false, remote: "origin" });
    const html = renderToStaticMarkup(
      <TagDeleteConfirmContent
        request={request}
        onToggleRemote={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(html).toContain("Also delete on origin");
    expect(html).not.toContain('checked=""');
  });

  it("disables remote deletion when no remotes are configured", () => {
    const request = deleteRequest({ includeRemote: false, remote: "origin", remoteDisabled: true });
    const html = renderToStaticMarkup(
      <TagDeleteConfirmContent
        request={request}
        onToggleRemote={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(html).toContain("No remotes are configured");
    expect(html).toContain('disabled=""');
  });
});

/** Builds a delete request around the default tag fixture. */
function deleteRequest(overrides: Partial<DeleteTagRequest> = {}): DeleteTagRequest {
  return {
    item: {
      id: "tag:v1.0.0",
      label: "v1.0.0",
      kindLabel: "annotated",
      kind: "tag",
      tag,
    },
    includeRemote: false,
    remote: "origin",
    remoteDisabled: false,
    ...overrides,
  };
}
