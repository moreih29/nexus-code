/**
 * Scenario tests for History commit-detail parsing.
 */
import { describe, expect, test } from "bun:test";
import {
  parseCommitDetailOutput,
  parseNameStatusTokens,
} from "../../../../src/main/git/git-commit-detail";

describe("parseCommitDetailOutput", () => {
  test("parses subject, author, body, and file changes", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "Ada Lovelace",
      "ada@example.invalid",
      "2026-05-10T10:00:00+00:00",
      "fix popover",
      "fix popover\n\nbody line\n",
      "M",
      "src/app.ts",
      "R100",
      "old.ts",
      "new.ts",
      "",
    ].join("\x00");

    expect(parseCommitDetailOutput(stdout)).toEqual({
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parents: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      subject: "fix popover",
      author: "Ada Lovelace",
      authorEmail: "ada@example.invalid",
      committerTs: "2026-05-10T10:00:00+00:00",
      message: "fix popover\n\nbody line",
      body: "body line",
      files: [
        { status: "M", path: "src/app.ts" },
        { status: "R100", oldPath: "old.ts", path: "new.ts" },
      ],
    });
  });

  test("suppresses file entries for merge commits", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc",
      "Grace Hopper",
      "grace@example.invalid",
      "2026-05-10T10:00:00+00:00",
      "Merge branch feature",
      "Merge branch feature\n",
      "M",
      "merged.txt",
      "",
    ].join("\x00");

    const detail = parseCommitDetailOutput(stdout);
    expect(detail.parents).toHaveLength(2);
    expect(detail.files).toEqual([]);
  });
});

describe("parseNameStatusTokens", () => {
  test("handles rename/copy old paths and simple statuses", () => {
    expect(parseNameStatusTokens(["A", "a.ts", "C075", "a.ts", "b.ts"])).toEqual([
      { status: "A", path: "a.ts" },
      { status: "C075", oldPath: "a.ts", path: "b.ts" },
    ]);
  });
});
