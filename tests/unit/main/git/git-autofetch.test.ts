/**
 * Scenario tests for the Git autofetch scheduler.
 */
import { describe, expect, it, mock } from "bun:test";
import { GitAutofetchScheduler } from "../../../../src/main/git/git-autofetch";
import { GitError } from "../../../../src/main/git/git-error";
import {
  DEFAULT_GIT_OPERATION_STATE,
  DEFAULT_REPO_CAPABILITIES,
} from "../../../../src/shared/types/git";

const workspaceId = "00000000-0000-4000-8000-000000000010";

function makeStatus(lastFetchedAt = 12_345) {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: {
      current: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isUnborn: false,
    },
    capabilities: { ...DEFAULT_REPO_CAPABILITIES, remotes: ["origin"], hasHEAD: true },
    operationState: DEFAULT_GIT_OPERATION_STATE,
    lastFetchedAt,
  };
}

function createHarness() {
  let now = 0;
  const panelState = {
    commitDraft: "",
    expandedGroups: { merge: true, staged: true, working: true, untracked: true },
    expandedTreeNodes: { merge: [], staged: [], working: [], untracked: [] },
    commitOptions: { sign: false, signoff: false, noVerify: false },
    autofetchIntervalMin: 3 as const,
    autofetchManualPaused: false,
    protectedBranches: [],
    panelSegment: "changes" as const,
    historyDetailWidth: 0,
    historyRef: "HEAD",
  };
  const repo = {
    fetchAll: mock(async () => {}),
  };
  const registry = {
    getOrDetect: mock(async () => repo),
    bumpGeneration: mock(() => {}),
    refreshStatus: mock(async () => makeStatus()),
  };
  const storage = {
    isOpen: mock(() => true),
    getGitPanelState: mock(() => panelState),
    setGitPanelState: mock((_id: string, partial: Partial<typeof panelState>) => {
      Object.assign(panelState, partial);
    }),
  };
  const workspaceManager = {
    list: mock(() => [{ id: workspaceId, name: "repo", rootPath: "/repo" }]),
  };
  const events: unknown[] = [];
  const scheduler = new GitAutofetchScheduler({
    registry: registry as never,
    storage: storage as never,
    workspaceManager: workspaceManager as never,
    broadcast: (_channel, _event, payload) => events.push(payload),
    now: () => now,
  });

  return {
    scheduler,
    registry,
    repo,
    storage,
    panelState,
    events,
    setNow: (value: number) => (now = value),
  };
}

describe("GitAutofetchScheduler", () => {
  it("uses a due time based on interval minutes before enqueuing fetch", async () => {
    const h = createHarness();

    await h.scheduler.tick();
    h.setNow(179_999);
    await h.scheduler.tick();
    expect(h.repo.fetchAll).toHaveBeenCalledTimes(0);

    h.setNow(180_000);
    await h.scheduler.tick();

    expect(h.repo.fetchAll).toHaveBeenCalledWith({ interactive: false }, undefined);
    expect(h.registry.bumpGeneration).toHaveBeenCalledTimes(1);
    expect(h.registry.refreshStatus).toHaveBeenCalledTimes(1);
  });

  it("globally pauses on blur and recalculates due time on focus", async () => {
    const h = createHarness();
    h.panelState.autofetchIntervalMin = 1;
    await h.scheduler.tick();

    h.scheduler.setGlobalPaused(true);
    h.setNow(60_000);
    await h.scheduler.tick();
    expect(h.repo.fetchAll).toHaveBeenCalledTimes(0);

    h.scheduler.setGlobalPaused(false);
    await h.scheduler.tick();
    expect(h.repo.fetchAll).toHaveBeenCalledTimes(0);

    h.setNow(120_000);
    await h.scheduler.tick();
    expect(h.repo.fetchAll).toHaveBeenCalledTimes(1);
  });

  it("pauses only the failing workspace after three consecutive background failures", async () => {
    const h = createHarness();
    h.panelState.autofetchIntervalMin = 1;
    h.repo.fetchAll.mockImplementation(async () => {
      throw new GitError("unknown", "network failed");
    });

    await h.scheduler.tick();
    for (const dueAt of [60_000, 120_000, 180_000]) {
      h.setNow(dueAt);
      await h.scheduler.tick();
    }

    expect(h.repo.fetchAll).toHaveBeenCalledTimes(3);
    expect(h.panelState.autofetchManualPaused).toBe(true);
    expect(
      h.events.filter((event) => (event as { showPausedBanner?: boolean }).showPausedBanner),
    ).toHaveLength(1);
  });

  it("treats interval 0 as off without leaving a manual pause flag", async () => {
    const h = createHarness();

    h.scheduler.setSchedule(workspaceId, 0);
    h.setNow(60 * 60_000);
    await h.scheduler.tick();

    expect(h.panelState.autofetchIntervalMin).toBe(0);
    expect(h.panelState.autofetchManualPaused).toBe(false);
    expect(h.repo.fetchAll).toHaveBeenCalledTimes(0);
  });

  it("marks auth failures sticky and clears errors on the next successful explicit fetch", async () => {
    const h = createHarness();
    h.panelState.autofetchIntervalMin = 1;
    h.repo.fetchAll.mockImplementationOnce(async () => {
      throw new GitError("auth-required", "credentials required");
    });

    await h.scheduler.tick();
    h.setNow(60_000);
    await h.scheduler.tick();

    const failureEvent = h.events.at(-1) as { lastError: { sticky: boolean } };
    expect(failureEvent.lastError.sticky).toBe(true);

    h.repo.fetchAll.mockImplementation(async () => {});
    await h.scheduler.fetchNow(workspaceId);

    const successEvent = h.events.at(-1) as { lastError: null; paused: boolean };
    expect(successEvent.lastError).toBeNull();
    expect(successEvent.paused).toBe(false);
  });

  it("marks network failures non-sticky so the next success auto-clears them", async () => {
    const h = createHarness();
    h.panelState.autofetchIntervalMin = 1;
    h.repo.fetchAll.mockImplementationOnce(async () => {
      throw new GitError("unknown", "network unavailable");
    });

    await h.scheduler.tick();
    h.setNow(60_000);
    await h.scheduler.tick();

    const failureEvent = h.events.at(-1) as { lastError: { sticky: boolean } };
    expect(failureEvent.lastError.sticky).toBe(false);

    h.repo.fetchAll.mockImplementation(async () => {});
    await h.scheduler.fetchNow(workspaceId);

    const successEvent = h.events.at(-1) as { lastError: null };
    expect(successEvent.lastError).toBeNull();
  });
});
