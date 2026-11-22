/** The tasks' git facts the sessions' list tells: kept, and looked at again only once old. */
import { describe, expect, test } from "bun:test";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { listSessions } from "../../../../../src/main/features/remote/serving/sessions";
import { factsOf, REFRESH_MS, TaskGit } from "../../../../../src/main/features/remote/task-git";
import type { GitStatus } from "../../../../../src/shared/git/types";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

function status(over: Partial<GitStatus> = {}): GitStatus {
  return {
    merge: [],
    staged: [{ relPath: "a.ts", xy: "M " }],
    working: [
      { relPath: "a.ts", xy: " M" },
      { relPath: "b.ts", xy: " M" },
    ],
    untracked: [{ relPath: "new.ts", xy: "??" }],
    branch: { current: "feat", upstream: "origin/feat", ahead: 2, behind: 1, isUnborn: false },
    ...over,
  } as unknown as GitStatus;
}

const task = { id: "w2", task: { parentId: "w1" } } as unknown as WorkspaceMeta;
const root = { id: "w1" } as unknown as WorkspaceMeta;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a task's git facts", () => {
  test("its branch, ahead and behind, and each changed file once", () => {
    expect(factsOf(status())).toEqual({ branch: "feat", ahead: 2, behind: 1, uncommitted: 3 });
    const unborn = status({ branch: { current: "main", isUnborn: true } as GitStatus["branch"] });
    expect(factsOf(unborn).branch).toBeNull();
  });

  test("are seen on the next read, and git is asked again only once they are old", async () => {
    let clock = 1_000;
    let asked = 0;
    const git = new TaskGit(
      async () => {
        asked++;
        return status();
      },
      () => clock,
    );
    // The first read asks git and has nothing yet; the next has what it said.
    expect(git.facts(task)).toBeUndefined();
    await settle();
    expect(git.facts(task)).toMatchObject({ branch: "feat", uncommitted: 3 });
    expect(asked).toBe(1);
    clock += REFRESH_MS - 1;
    git.facts(task);
    expect(asked).toBe(1);
    clock += 1;
    git.facts(task);
    expect(asked).toBe(2);
  });

  test("none for a workspace that is no task, and the last kept when git fails", async () => {
    let fail = false;
    let clock = 0;
    const git = new TaskGit(
      async () => {
        if (fail) throw new Error("host away");
        return status();
      },
      () => clock,
    );
    expect(git.facts(root)).toBeUndefined();
    git.facts(task);
    await settle();
    fail = true;
    clock += REFRESH_MS;
    git.facts(task);
    await settle();
    expect(git.facts(task)).toMatchObject({ branch: "feat" });
  });

  test("removing a task leaves no cached git facts even when its lookup and session list finish late", async () => {
    const oldStatus = Promise.withResolvers<GitStatus>();
    const newStatus = Promise.withResolvers<GitStatus | null>();
    let lookups = 0;
    const git = new TaskGit(() => (++lookups === 1 ? oldStatus.promise : newStatus.promise));

    let workspaces = [root, task];
    let tabsReady = Promise.resolve();
    const services = {
      listWorkspaces: () => workspaces,
      ui: async (_op: string, { workspaceIds }: { workspaceIds: string[] }) => {
        await tabsReady;
        return { workspaces: workspaceIds.map(() => ({ tabs: [] })) };
      },
    } as unknown as CliServices;
    await listSessions(services, git.facts);
    expect(lookups).toBe(1);

    const tabs = Promise.withResolvers<void>();
    tabsReady = tabs.promise;
    const listing = listSessions(services, git.facts);
    workspaces = [root];
    git.forget(task.id);
    oldStatus.resolve(status());
    tabs.resolve();
    await listing;
    expect(lookups).toBe(1);

    workspaces = [root, task];
    const reopened = await listSessions(services, git.facts);
    expect(reopened.workspaces.find(({ id }) => id === task.id)?.git).toBeUndefined();
    expect(lookups).toBe(2);
    newStatus.resolve(null);
  });
});
