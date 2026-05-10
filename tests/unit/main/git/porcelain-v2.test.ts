import { describe, expect, test } from "bun:test";
import { parseV2Porcelain } from "../../../../src/main/git/porcelain-v2";
import { DEFAULT_REPO_CAPABILITIES, type GitStatus } from "../../../../src/shared/types/git";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const ZERO = "0000000000000000000000000000000000000000";

interface PorcelainFixture {
  readonly name: string;
  readonly text: string;
  readonly expected: GitStatus;
}

// The pure parser fills capabilities with defaults; the GitRepository wraps
// the parsed status with real `git remote` and stash counts before broadcast.
const cleanStatus: GitStatus = {
  merge: [],
  staged: [],
  working: [],
  untracked: [],
  branch: null,
  capabilities: { ...DEFAULT_REPO_CAPABILITIES },
};

const fixtures: PorcelainFixture[] = [
  {
    name: "clean branch with upstream counters",
    text: records(
      "# branch.oid " + HASH,
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
    ),
    expected: {
      ...cleanStatus,
      branch: { current: "main", upstream: "origin/main", ahead: 2, behind: 1, isUnborn: false },
    },
  },
  {
    name: "mixed staged, working, deleted, and untracked groups",
    text: records(
      "# branch.oid " + HASH,
      "# branch.head feature/git-panel",
      tracked("M.", "src/staged.ts"),
      tracked(".M", "src/working dir/file one.ts"),
      tracked("D.", "src/deleted.ts", HASH, ZERO),
      "? notes/todo item.md",
    ),
    expected: {
      merge: [],
      staged: [entry("src/staged.ts", "M."), entry("src/deleted.ts", "D.")],
      working: [entry("src/working dir/file one.ts", ".M")],
      untracked: [entry("notes/todo item.md", "??")],
      branch: { current: "feature/git-panel", upstream: null, ahead: 0, behind: 0, isUnborn: false },
      capabilities: { ...DEFAULT_REPO_CAPABILITIES },
    },
  },
  {
    name: "unborn repository emits isUnborn=true when branch.oid is (initial)",
    text: records(
      "# branch.oid (initial)",
      "# branch.head main",
      tracked("A.", "src/new-file.ts"),
    ),
    expected: {
      ...cleanStatus,
      staged: [entry("src/new-file.ts", "A.")],
      branch: { current: "main", upstream: null, ahead: 0, behind: 0, isUnborn: true },
    },
  },
  {
    name: "nul-delimited staged rename preserves old path with spaces",
    text: records(renamed("R.", "src/new name.ts"), "src/old name.ts"),
    expected: {
      ...cleanStatus,
      staged: [entry("src/new name.ts", "R.", "src/old name.ts")],
    },
  },
  {
    name: "conflict record is isolated in the merge group",
    text: records(unmerged("UU", "src/conflict file.txt")),
    expected: {
      ...cleanStatus,
      merge: [entry("src/conflict file.txt", "UU")],
    },
  },
  {
    name: "line-delimited rename uses tab old-path fallback",
    text: `${renamed("R.", "src/new-name.ts\tsrc/old-name.ts")}\n`,
    expected: {
      ...cleanStatus,
      staged: [entry("src/new-name.ts", "R.", "src/old-name.ts")],
    },
  },
  {
    name: "untracked path keeps spaces exactly",
    text: records("? untracked folder/file with spaces.txt"),
    expected: {
      ...cleanStatus,
      untracked: [entry("untracked folder/file with spaces.txt", "??")],
    },
  },
];

describe("parseV2Porcelain", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(parseV2Porcelain(fixture.text)).toEqual(fixture.expected);
    });
  }
});

/** Joins porcelain-v2 records using the real -z delimiter used by git status. */
function records(...parts: string[]): string {
  return `${parts.join("\0")}\0`;
}

/** Builds a porcelain-v2 ordinary tracked-file record with a free-form path tail. */
function tracked(xy: string, relPath: string, headHash = HASH, indexHash = HASH): string {
  return `1 ${xy} N... 100644 100644 100644 ${headHash} ${indexHash} ${relPath}`;
}

/** Builds a porcelain-v2 rename record whose old path is supplied separately in -z mode. */
function renamed(xy: string, relPath: string): string {
  return `2 ${xy} N... 100644 100644 100644 ${HASH} ${HASH} R100 ${relPath}`;
}

/** Builds a porcelain-v2 unmerged record with stage hashes and a free-form path tail. */
function unmerged(xy: string, relPath: string): string {
  return `u ${xy} N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} ${relPath}`;
}

/** Creates a status entry while keeping oldRelPath absent unless a rename needs it. */
function entry(relPath: string, xy: string, oldRelPath?: string) {
  return oldRelPath ? { relPath, oldRelPath, xy } : { relPath, xy };
}
