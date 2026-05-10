/**
 * FormDialog component tests.
 *
 * Bun runs these renderer tests without a DOM, so the Radix Portal wrapper is
 * not rendered. We assert the exported FormDialogContent body with
 * renderToStaticMarkup and cover interaction rules through the pure validation
 * helpers.
 */

import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FormDialogContent,
  type FormDialogField,
  getFormDialogFieldStates,
  handleFormDialogOpenChange,
  initialFormDialogValues,
  isFormDialogSubmitDisabled,
} from "../../../../../src/renderer/components/ui/form-dialog";

const cloneFields: FormDialogField[] = [
  {
    name: "url",
    label: "Repository URL",
    type: "url",
    placeholder: "https://github.com/org/repo.git",
    validate: (value) => (value.includes("://") ? null : "Enter a valid URL"),
  },
  { name: "parent", label: "Parent folder", placeholder: "/Users/alice/work" },
  { name: "name", label: "Folder name", placeholder: "repo" },
  { name: "branch", label: "Branch", placeholder: "main" },
];

const validCloneValues = {
  url: "https://github.com/org/repo.git",
  parent: "/Users/alice/work",
  name: "repo",
  branch: "main",
};

describe("FormDialogContent", () => {
  it("renders a four-field Clone-like form", () => {
    const html = renderToStaticMarkup(
      <FormDialogContent
        title="Clone repository"
        description="Create a local checkout from a remote URL."
        fields={cloneFields}
        values={validCloneValues}
        submitLabel="Clone"
        cancelLabel="Cancel"
        onValueChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("Clone repository");
    expect(html).toContain("Repository URL");
    expect(html).toContain("Parent folder");
    expect(html).toContain("Folder name");
    expect(html).toContain("Branch");
    expect(html).toContain("Clone");
  });

  it("shows inline validation errors and disables submit", () => {
    const values = { ...validCloneValues, url: "github.com/org/repo", name: "" };
    const html = renderToStaticMarkup(
      <FormDialogContent
        title="Clone repository"
        fields={cloneFields}
        values={values}
        submitLabel="Clone"
        cancelLabel="Cancel"
        onValueChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("Enter a valid URL");
    expect(html).toContain("Required");
    expect(html).toContain('disabled=""');
  });

  it("wires Escape/outside dismissal through the onCancel prop seam", () => {
    const onCancel = mock(() => {});

    handleFormDialogOpenChange(false, onCancel);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("FormDialog validation helpers", () => {
  it("initializes values from defaults and caller overrides", () => {
    const values = initialFormDialogValues(
      [
        { name: "url", label: "Repository URL", defaultValue: "https://example.com/repo.git" },
        { name: "branch", label: "Branch", defaultValue: "main" },
      ],
      { branch: "develop" },
    );

    expect(values).toEqual({
      url: "https://example.com/repo.git",
      branch: "develop",
    });
  });

  it("blocks required empty fields and custom validator failures", () => {
    const states = getFormDialogFieldStates(cloneFields, {
      url: "not-a-url",
      parent: "",
      name: "repo",
      branch: "main",
    });

    expect(states.map((state) => state.error)).toEqual([
      "Enter a valid URL",
      "Required",
      null,
      null,
    ]);
    expect(isFormDialogSubmitDisabled(cloneFields, validCloneValues)).toBe(false);
  });
});
