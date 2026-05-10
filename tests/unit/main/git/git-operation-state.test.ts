import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readGitOperationState } from "../../../../src/main/git/git-operation-state";

const HEAD_SHA = "1111111111111111111111111111111111111111";
const OTHER_SHA = "2222222222222222222222222222222222222222";

let tmpDir: string;
let gitDir: string;

describe("readGitOperationState", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-op-state-"));
    gitDir = path.join(tmpDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    write("HEAD", "ref: refs/heads/main\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns none when no operation markers exist", async () => {
    await expect(readGitOperationState(gitDir)).resolves.toEqual({ kind: "none" });
  });

  test("detects MERGE_HEAD as merge state", async () => {
    write("MERGE_HEAD", `${OTHER_SHA}\n`);

    await expect(readGitOperationState(gitDir, { conflictCount: 2 })).resolves.toEqual({
      kind: "merge",
      headRef: "main",
      mergeRef: OTHER_SHA,
      conflictCount: 2,
    });
  });

  test("detects rebase-merge interactive progress", async () => {
    mkdir("rebase-merge");
    write("rebase-merge/interactive", "");
    write("rebase-merge/head-name", "refs/heads/feature\n");
    write("rebase-merge/onto", `${HEAD_SHA}\n`);
    write("rebase-merge/msgnum", "3\n");
    write("rebase-merge/end", "7\n");

    await expect(readGitOperationState(gitDir, { conflictCount: 1 })).resolves.toEqual({
      kind: "rebase",
      variant: "interactive",
      headRef: "feature",
      ontoRef: HEAD_SHA,
      doneCount: 3,
      totalCount: 7,
      conflictCount: 1,
    });
  });

  test("detects rebase-merge non-interactive progress", async () => {
    mkdir("rebase-merge");
    write("rebase-merge/head-name", "refs/heads/topic\n");
    write("rebase-merge/onto", `${HEAD_SHA}\n`);
    write("rebase-merge/msgnum", "2\n");
    write("rebase-merge/end", "5\n");

    await expect(readGitOperationState(gitDir)).resolves.toEqual({
      kind: "rebase",
      variant: "merge",
      headRef: "topic",
      ontoRef: HEAD_SHA,
      doneCount: 2,
      totalCount: 5,
      conflictCount: 0,
    });
  });

  test("detects rebase-apply progress", async () => {
    mkdir("rebase-apply");
    write("rebase-apply/head-name", "refs/heads/mailbox\n");
    write("rebase-apply/onto", `${HEAD_SHA}\n`);
    write("rebase-apply/next", "4\n");
    write("rebase-apply/last", "9\n");

    await expect(readGitOperationState(gitDir)).resolves.toEqual({
      kind: "rebase",
      variant: "apply",
      headRef: "mailbox",
      ontoRef: HEAD_SHA,
      doneCount: 4,
      totalCount: 9,
      conflictCount: 0,
    });
  });

  test("detects CHERRY_PICK_HEAD as cherry-pick state", async () => {
    write("CHERRY_PICK_HEAD", `${OTHER_SHA}\n`);

    await expect(readGitOperationState(gitDir, { conflictCount: 1 })).resolves.toEqual({
      kind: "cherry-pick",
      sourceSha: OTHER_SHA,
      conflictCount: 1,
    });
  });

  test("detects REVERT_HEAD as revert state", async () => {
    write("REVERT_HEAD", `${OTHER_SHA}\n`);

    await expect(readGitOperationState(gitDir)).resolves.toEqual({
      kind: "revert",
      sourceSha: OTHER_SHA,
      conflictCount: 0,
    });
  });
});

/** Creates a directory under the fixture `.git` directory. */
function mkdir(relPath: string): void {
  fs.mkdirSync(path.join(gitDir, relPath), { recursive: true });
}

/** Writes a file under the fixture `.git` directory. */
function write(relPath: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(gitDir, relPath)), { recursive: true });
  fs.writeFileSync(path.join(gitDir, relPath), content);
}
