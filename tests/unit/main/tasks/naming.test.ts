import { describe, expect, it } from "bun:test";
import {
  repoFolderName,
  subPathInRepo,
  taskSlug,
  uniqueName,
} from "../../../../src/main/features/tasks/naming";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

function workspace(location: WorkspaceMeta["location"]): WorkspaceMeta {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "w",
    location,
    rootPath: location.kind === "local" ? location.rootPath : location.remotePath,
    colorTone: "default",
    pinned: false,
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
  };
}

describe("taskSlug", () => {
  it.each([
    ["Fix login bug", "fix-login-bug"],
    ["  feat: add/remove  ", "feat-add-remove"],
    ["로그인 수정", "로그인-수정"],
    ["..hidden..name..", "hidden.name"],
    ["release.lock", "release"],
    ["!!!", ""],
  ])("%p → %p", (name, slug) => {
    expect(taskSlug(name)).toBe(slug);
  });

  it("caps the length without leaving a trailing separator", () => {
    const slug = taskSlug(`${"a".repeat(39)} tail`);
    expect(slug).toBe("a".repeat(39));
  });
});

describe("uniqueName", () => {
  it("adds the first free numeric suffix", () => {
    const taken = new Set(["fix", "fix-2"]);
    expect(uniqueName("fix", (name) => taken.has(name))).toBe("fix-3");
    expect(uniqueName("new", (name) => taken.has(name))).toBe("new");
  });
});

describe("repoFolderName", () => {
  it("keeps the folder name and tells same-named repositories apart", () => {
    const a = repoFolderName(workspace({ kind: "local", rootPath: "/work/app" }));
    const b = repoFolderName(workspace({ kind: "local", rootPath: "/other/app" }));
    expect(a).toMatch(/^app-[0-9a-f]{6}$/);
    expect(b).toMatch(/^app-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    expect(repoFolderName(workspace({ kind: "local", rootPath: "C:\\src\\My App\\" }))).toMatch(
      /^my-app-[0-9a-f]{6}$/,
    );
  });
});

describe("subPathInRepo", () => {
  it("is empty at the top level and relative below it, on either separator", () => {
    expect(subPathInRepo("/repo", "/repo")).toBe("");
    expect(subPathInRepo("/repo/packages/app/", "/repo")).toBe("packages/app");
    expect(subPathInRepo("C:\\repo\\packages\\app", "C:/repo")).toBe("packages/app");
    expect(subPathInRepo("/repository", "/repo")).toBe("");
  });
});
