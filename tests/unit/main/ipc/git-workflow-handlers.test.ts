/**
 * Scenario tests for workflow IPC handlers' mutation refresh contract.
 */
import { describe, expect, test } from "bun:test";
import { GitError } from "../../../../src/main/features/git/domain/git-error";
import type { GitRegistry } from "../../../../src/main/features/git/domain/git-registry";
import {
  abortOpHandler,
  cherryPickHandler,
  continueOpHandler,
  markResolvedHandler,
  mergeHandler,
  rebaseHandler,
} from "../../../../src/main/features/git/ipc/workflow-handlers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

describe("git workflow IPC handlers", () => {
  test("successful workflow mutations bump generation before refreshing status", async () => {
    const cases = [
      {
        name: "merge",
        repo: { merge: async () => ({ result: "clean" as const }) },
        handler: mergeHandler,
        args: { workspaceId: WORKSPACE_ID, branch: "feature", mode: "default" },
      },
      {
        name: "rebase",
        repo: {
          rebase: async () => ({
            result: "clean" as const,
            conflictCount: 0,
            doneCount: 1,
            totalCount: 1,
          }),
        },
        handler: rebaseHandler,
        args: { workspaceId: WORKSPACE_ID, onto: "main" },
      },
      {
        name: "cherryPick",
        repo: { cherryPick: async () => ({ result: "clean" as const }) },
        handler: cherryPickHandler,
        args: { workspaceId: WORKSPACE_ID, sha: "abc123" },
      },
      {
        name: "abortOp",
        repo: { abortOp: async () => undefined },
        handler: abortOpHandler,
        args: { workspaceId: WORKSPACE_ID },
      },
      {
        name: "continueOp",
        repo: { continueOp: async () => ({ result: "completed" as const }) },
        handler: continueOpHandler,
        args: { workspaceId: WORKSPACE_ID },
      },
      {
        name: "markResolved",
        repo: { markResolved: async () => ({ remainingConflicts: 0 }) },
        handler: markResolvedHandler,
        args: { workspaceId: WORKSPACE_ID, paths: ["conflict.txt"] },
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

  test("empty cherry-pick errors bump generation before refreshing status", async () => {
    const events: string[] = [];
    let cherryPickHeadExists = false;
    const emptyCommitError = new GitError(
      "empty-commit",
      "The previous cherry-pick is now empty.",
      { hint: { kind: "allow-empty" } },
    );
    const registry = {
      getOrDetect: async () => {
        events.push("getOrDetect");
        return {
          cherryPick: async () => {
            events.push("cherryPick");
            cherryPickHeadExists = true;
            throw emptyCommitError;
          },
        };
      },
      bumpGeneration: () => {
        events.push("bumpGeneration");
      },
      refreshStatus: async () => {
        events.push("refreshStatus");
        expect(cherryPickHeadExists).toBe(true);
        return {};
      },
    } as unknown as GitRegistry;

    await expect(
      cherryPickHandler(registry)({ workspaceId: WORKSPACE_ID, sha: "abc123" }),
    ).rejects.toBe(emptyCommitError);

    expect(events).toEqual(["getOrDetect", "cherryPick", "bumpGeneration", "refreshStatus"]);
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
