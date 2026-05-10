/**
 * Scenario tests for History IPC handlers.
 */
import { describe, expect, test } from "bun:test";
import { GitError } from "../../../../../../src/main/git/git-error";
import type { GitRegistry } from "../../../../../../src/main/git/git-registry";
import {
  checkoutDetachedHandler,
  commitDetailHandler,
  resetSoftHandler,
  searchCommitsHandler,
} from "../../../../../../src/main/ipc/channels/git/history-handlers";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

describe("git history IPC handlers", () => {
  test("read handlers call the repository without bumping generation", async () => {
    const events: string[] = [];
    const registry = makeRegistry(
      {
        commitDetail: async (sha: string) => {
          events.push(`detail:${sha}`);
          return {
            sha,
            parents: [],
            subject: "subject",
            author: "Ada",
            authorEmail: "ada@example.invalid",
            committerTs: "2026-05-10T00:00:00.000Z",
            message: "subject",
            body: "",
            files: [],
          };
        },
        searchCommits: async (query: string, limit: number) => {
          events.push(`search:${query}:${limit}`);
          return { kind: "grep" as const, entries: [] };
        },
      },
      events,
    );

    await commitDetailHandler(registry)({ workspaceId: WORKSPACE_ID, sha: "abc123" });
    await searchCommitsHandler(registry)({
      workspaceId: WORKSPACE_ID,
      query: "fix popover",
      limit: 25,
    });

    expect(events).toEqual([
      "getOrDetect",
      "detail:abc123",
      "getOrDetect",
      "search:fix popover:25",
    ]);
  });

  test("mutating handlers bump generation before refreshing status", async () => {
    const cases = [
      {
        name: "checkoutDetached",
        repo: { checkoutDetached: async () => undefined },
        handler: checkoutDetachedHandler,
        args: { workspaceId: WORKSPACE_ID, sha: "abc123" },
      },
      {
        name: "resetSoft",
        repo: { resetSoft: async () => undefined },
        handler: resetSoftHandler,
        args: { workspaceId: WORKSPACE_ID, targetSha: "abc123" },
      },
    ];

    for (const scenario of cases) {
      const events: string[] = [];
      const registry = makeRegistry(scenario.repo, events);

      await scenario.handler(registry)(scenario.args);

      expect({ name: scenario.name, events }).toEqual({
        name: scenario.name,
        events: ["getOrDetect", "bumpGeneration", "refreshStatus"],
      });
    }
  });

  test("non-repository workspaces surface typed not-repo", async () => {
    const registry = {
      getOrDetect: async () => null,
    } as unknown as GitRegistry;

    await expect(
      commitDetailHandler(registry)({ workspaceId: WORKSPACE_ID, sha: "abc123" }),
    ).rejects.toMatchObject({ kind: "not-repo" } satisfies Partial<GitError>);
  });
});

/** Builds a minimal GitRegistry double that records refresh ordering. */
function makeRegistry(repo: unknown, events: string[]): GitRegistry {
  return {
    getOrDetect: async () => {
      events.push("getOrDetect");
      return repo;
    },
    bumpGeneration: () => {
      events.push("bumpGeneration");
    },
    refreshStatus: async () => {
      events.push("refreshStatus");
      return {};
    },
  } as unknown as GitRegistry;
}
