/**
 * A changed file's row in the Source Control panel renders only for its own
 * file, and its menu, shared by all rows, does what the row's own did.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  type GitFileActions,
  type GitFileRowProps,
  gitFileMenuActions,
  sameGitFileRow,
} from "../../../../../../src/renderer/components/files/git/file-row/row";
import type { GitStatusEntry } from "../../../../../../src/shared/git/types";

function fakeActions(): GitFileActions {
  return {
    stage: mock(() => {}),
    unstage: mock(() => {}),
    discard: mock(() => {}),
    markResolved: mock(() => {}),
    openDiff: mock(() => {}),
    openFile: mock(() => {}),
    revealInOS: mock(() => {}),
    copyPath: mock(() => {}),
    copyRelativePath: mock(() => {}),
    addToGitignore: mock(() => {}),
    openMenu: mock(() => {}),
  };
}

const entry: GitStatusEntry = { relPath: "src/a.ts", xy: " M", conflictType: null };

describe("a file row's memo", () => {
  const actions = fakeActions();
  const props: GitFileRowProps = { groupKey: "working", entry, actions };

  test("a status refresh's new entry for the same file renders nothing", () => {
    expect(sameGitFileRow(props, { ...props, entry: { ...entry } })).toBe(true);
  });

  test("a change to anything the row shows renders it", () => {
    expect(sameGitFileRow(props, { ...props, entry: { ...entry, xy: "MM" } })).toBe(false);
    expect(sameGitFileRow(props, { ...props, entry: { ...entry, relPath: "src/b.ts" } })).toBe(
      false,
    );
    expect(sameGitFileRow(props, { ...props, entry: { ...entry, oldRelPath: "src/old.ts" } })).toBe(
      false,
    );
    expect(
      sameGitFileRow(props, { ...props, entry: { ...entry, conflictType: "both-modified" } }),
    ).toBe(false);
    expect(sameGitFileRow(props, { ...props, groupKey: "staged" })).toBe(false);
    expect(sameGitFileRow(props, { ...props, actions: fakeActions() })).toBe(false);
  });
});

describe("the shared file menu", () => {
  test("a working file's stages and discards that file", () => {
    const actions = fakeActions();
    const menu = gitFileMenuActions(entry, "working", actions);
    expect(menu.unstage).toBeUndefined();
    expect(menu.markResolved).toBeUndefined();
    menu.stage?.();
    menu.discard?.();
    menu.openChanges();
    menu.openFile();
    expect(actions.stage).toHaveBeenCalledWith(["src/a.ts"]);
    expect(actions.discard).toHaveBeenCalledWith(["src/a.ts"], "src/a.ts", "working");
    expect(actions.openDiff).toHaveBeenCalledWith(entry, "working");
    expect(actions.openFile).toHaveBeenCalledWith(entry);
  });

  test("a staged file's unstages it, and has no stage", () => {
    const actions = fakeActions();
    const menu = gitFileMenuActions(entry, "staged", actions);
    expect(menu.stage).toBeUndefined();
    menu.unstage?.();
    expect(actions.unstage).toHaveBeenCalledWith(["src/a.ts"]);
  });

  test("a conflicted file's marks it resolved, and neither stages nor unstages", () => {
    const actions = fakeActions();
    const conflicted: GitStatusEntry = { ...entry, xy: "UU", conflictType: "both-modified" };
    const menu = gitFileMenuActions(conflicted, "merge", actions);
    expect(menu.stage).toBeUndefined();
    expect(menu.unstage).toBeUndefined();
    menu.markResolved?.();
    expect(actions.markResolved).toHaveBeenCalledWith(conflicted);
  });

  test("the rest act on the file it opened for", () => {
    const actions = fakeActions();
    const menu = gitFileMenuActions(entry, "untracked", actions);
    menu.revealInOS();
    menu.copyPath();
    menu.copyRelativePath();
    menu.addToGitignore();
    expect(actions.revealInOS).toHaveBeenCalledWith(entry);
    expect(actions.copyPath).toHaveBeenCalledWith(entry);
    expect(actions.copyRelativePath).toHaveBeenCalledWith(entry);
    expect(actions.addToGitignore).toHaveBeenCalledWith(entry);
  });
});
