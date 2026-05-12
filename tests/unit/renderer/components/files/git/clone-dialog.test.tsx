/**
 * Scenario tests for the Clone dialog's renderer-only behavior.
 */
import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CloneDialogContent,
  getCloneCtaDefault,
  runPostCloneWorkspaceAction,
  setCloneCtaDefault,
} from "../../../../../../src/renderer/components/files/git/CloneDialog";
import {
  createCloneFormFields,
  deriveFolderNameFromUrl,
  joinFsPath,
  previewClonePath,
  validateCloneFolderName,
  validateCloneParent,
  validateCloneUrl,
} from "../../../../../../src/renderer/components/files/git/clone-form-utils";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

describe("CloneDialog form helpers", () => {
  it("derives folder names and live previews from common clone URLs", () => {
    expect(deriveFolderNameFromUrl("https://github.com/org/repo.git")).toBe("repo");
    expect(deriveFolderNameFromUrl("git@github.com:org/repo.git")).toBe("repo");
    expect(previewClonePath("/Users/alice/work", "repo")).toBe("/Users/alice/work/repo");
    expect(joinFsPath("C:\\Users\\alice\\work", "repo")).toBe("C:\\Users\\alice\\work\\repo");
  });

  it("validates URL, parent, and folder name before submit", () => {
    expect(validateCloneUrl("https://github.com/org/repo.git")).toBeNull();
    expect(validateCloneUrl("https://github.com/org/repo with space.git")).toContain("spaces");
    expect(validateCloneParent("/Users/alice/work")).toBeNull();
    expect(validateCloneParent("relative/path")).toContain("absolute");
    expect(validateCloneFolderName("repo_1.2-3")).toBeNull();
    expect(validateCloneFolderName(".repo")).toContain("dot");
    expect(validateCloneFolderName("repo/name")).toContain("letters");
  });

  it("renders the four FormDialog fields, Advanced disclosure, and preview", () => {
    const html = renderToStaticMarkup(
      <CloneDialogContent
        mode="form"
        fields={createCloneFormFields()}
        values={{
          url: "https://github.com/org/repo.git",
          parent: "/Users/alice/work",
          name: "repo",
          branch: "",
        }}
        advancedOpen={true}
        recurseSubmodules={true}
        progress={{ phase: null, pct: null, cancelling: false }}
        success={null}
        errorMessage={null}
        ctaDefault="new-window"
        postCloneBusy={null}
        currentWindowDirty={false}
        onValueChange={() => {}}
        onChooseParent={() => {}}
        onToggleAdvanced={() => {}}
        onRecurseSubmodulesChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
        onCancelClone={() => {}}
        onPostCloneAction={() => {}}
      />,
    );

    expect(html).toContain("Repository URL");
    expect(html).toContain("Parent folder");
    expect(html).toContain("Folder name");
    expect(html).toContain("Branch");
    expect(html).toContain("Choose…");
    expect(html).toContain("Will clone to:");
    expect(html).toContain("/Users/alice/work/repo");
    expect(html).toContain("Advanced");
    expect(html).toContain("Initialize submodules recursively");
  });

  it("renders progress cancel state and success CTAs", () => {
    const progressHtml = renderToStaticMarkup(
      <CloneDialogContent
        mode="progress"
        fields={createCloneFormFields()}
        values={{ url: "", parent: "", name: "", branch: "" }}
        advancedOpen={false}
        recurseSubmodules={false}
        progress={{ phase: "receiving", pct: 55, cancelling: false }}
        success={null}
        errorMessage={null}
        ctaDefault="new-window"
        postCloneBusy={null}
        currentWindowDirty={false}
        onValueChange={() => {}}
        onChooseParent={() => {}}
        onToggleAdvanced={() => {}}
        onRecurseSubmodulesChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
        onCancelClone={() => {}}
        onPostCloneAction={() => {}}
      />,
    );
    expect(progressHtml).toContain("Receiving objects");
    expect(progressHtml).toContain("Cancel");

    const successHtml = renderToStaticMarkup(
      <CloneDialogContent
        mode="success"
        fields={createCloneFormFields()}
        values={{ url: "", parent: "", name: "", branch: "" }}
        advancedOpen={false}
        recurseSubmodules={false}
        progress={{ phase: null, pct: null, cancelling: false }}
        success={{ absPath: "/Users/alice/work/repo", name: "repo" }}
        errorMessage={null}
        ctaDefault="new-window"
        postCloneBusy={null}
        currentWindowDirty={true}
        onValueChange={() => {}}
        onChooseParent={() => {}}
        onToggleAdvanced={() => {}}
        onRecurseSubmodulesChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
        onCancelClone={() => {}}
        onPostCloneAction={() => {}}
      />,
    );
    expect(successHtml).toContain("Open in new window");
    expect(successHtml).toContain("Add to workspaces");
    expect(successHtml).toContain("Open in current window ⚠");
  });
});

describe("CloneDialog post-clone workspace flow", () => {
  it("creates and activates separately for opening actions", async () => {
    const calls: string[] = [];
    const meta = workspaceMeta();
    const createWorkspace = mock(async () => {
      calls.push("create");
      return meta;
    });
    const activateWorkspace = mock(async () => {
      calls.push("activate");
    });
    const openNewWindow = mock(async () => {
      calls.push("open-new-window");
    });

    await runPostCloneWorkspaceAction(
      "new-window",
      { absPath: meta.rootPath, name: meta.name },
      { createWorkspace, activateWorkspace, openNewWindow },
    );

    expect(calls).toEqual(["create", "activate", "open-new-window"]);
  });

  it("keeps the last post-clone CTA as a session default", () => {
    setCloneCtaDefault("current-window");
    expect(getCloneCtaDefault()).toBe("current-window");
    setCloneCtaDefault("new-window");
  });
});

function workspaceMeta(): WorkspaceMeta {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "repo",
    rootPath: "/Users/alice/work/repo",
    location: { kind: "local", rootPath: "/Users/alice/work/repo" },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date(0).toISOString(),
    tabs: [],
  };
}
