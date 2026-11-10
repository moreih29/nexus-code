/**
 * Scenario tests for History IPC handlers.
 */
import { describe, expect, test } from "bun:test";
import type { GitRegistry } from "../../../../../../src/main/features/git/domain/registry";
import {
  checkoutDetachedHandler,
  resetSoftHandler,
} from "../../../../../../src/main/features/git/ipc/history-handlers";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

describe("git history IPC handlers", () => {
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
