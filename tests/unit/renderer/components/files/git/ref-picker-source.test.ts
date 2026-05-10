/**
 * Scenario tests for the shared git.ref-picker source.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  createRefPickerSource,
  type RefPickItem,
} from "../../../../../../src/renderer/components/files/git/ref-picker-source";
import type { BranchList, LogEntry, Tag } from "../../../../../../src/shared/types/git";

const workspaceId = "ws-ref-picker";

function branches(): BranchList {
  return {
    current: {
      current: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isUnborn: false,
    },
    local: ["main", "feature/local"],
    remote: ["origin/main", "origin/release"],
  };
}

function tag(): Tag {
  return {
    name: "v1.0.0",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    message: "release",
    type: "annotated",
    taggerDate: Date.now(),
  };
}

function commit(): LogEntry {
  return {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    shortSha: "bbbbbbb",
    parents: [],
    authorName: "Nexus Test",
    authorEmail: "nexus@example.invalid",
    authoredAt: new Date(Date.now() - 60_000).toISOString(),
    subject: "recent work",
  };
}

function buildSource() {
  const acceptRef = mock(() => {});
  const source = createRefPickerSource({
    workspaceId,
    listBranches: mock(async () => branches()),
    listTags: mock(async () => [tag()]),
    listRecentCommits: mock(async () => [commit()]),
    acceptRef,
  });
  return { source, acceptRef };
}

async function search(
  source: ReturnType<typeof createRefPickerSource>,
  query: string,
): Promise<readonly RefPickItem[]> {
  return source.search(query, new AbortController().signal);
}

describe("createRefPickerSource", () => {
  it("searches branches, tags, and recent commits on empty query", async () => {
    const { source } = buildSource();

    expect(source.id).toBe("git.ref-picker");
    expect(source.searchOnEmptyQuery).toBe(true);

    const items = await search(source, "");
    expect(items.map((item) => `${item.kind}:${item.ref}`)).toEqual([
      "branch:feature/local",
      "branch:main",
      "remote:origin/main",
      "remote:origin/release",
      "tag:v1.0.0",
      "commit:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("filters by tag names and commit SHAs, then accepts the selected ref", async () => {
    const { source, acceptRef } = buildSource();

    const tagHits = await search(source, "v1");
    expect(tagHits.map((item) => item.ref)).toEqual(["v1.0.0"]);

    const commitHits = await search(source, "bbbbbbb");
    expect(commitHits).toHaveLength(1);
    source.accept(commitHits[0]!);
    expect(acceptRef).toHaveBeenCalledWith(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      commitHits[0],
    );
  });
});
