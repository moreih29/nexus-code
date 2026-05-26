/**
 * Unit tests for the updates domain (installUpdatesDomain).
 *
 * Tests cover:
 *   A. runInitialAutoPoll broadcasts on newer result
 *   B. checkManual broadcasts with trigger:"manual"
 *   C. ignoredUpdateVersion matching latest → broadcast suppressed
 *   D. ignoredUpdateVersion != latest → broadcast proceeds
 *   E. Same latest twice → broadcast deduped to 1 call
 *   F. Channel change via stateService.setState → ignoredVersion reset + re-poll
 *   G. 3-second progress broadcast via injected timerScheduler
 *
 * All Electron and IPC-router dependencies are stubbed to avoid side-effects.
 * The poller is controlled via the `fetchImpl` injection.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock: electron — shell.openExternal must not run during unit tests
// ---------------------------------------------------------------------------

mock.module("electron", () => ({
  shell: {
    openExternal: async (_url: string) => {},
  },
}));

// ---------------------------------------------------------------------------
// Mock: shared/log/main — silence all log output in tests
// ---------------------------------------------------------------------------

mock.module("../../../../../src/shared/log/main", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Mock: ipc-router — capture register calls, provide no-op broadcast
// ---------------------------------------------------------------------------

mock.module("../../../../../src/main/infra/ipc-router", () => ({
  broadcast: () => {},
  register: () => {},
  validateArgs: <T>(_schema: unknown, args: T): T => args,
}));

// ---------------------------------------------------------------------------
// Mock: shared/ipc/result
// ---------------------------------------------------------------------------

mock.module("../../../../../src/shared/ipc/result", () => ({
  ipcOk: (value: unknown) => ({ ok: true, value }),
}));

// ---------------------------------------------------------------------------
// Mock: shared/ipc/contract — minimal stub with updates.call.check etc.
// ---------------------------------------------------------------------------

// real ipcContract 위에 updates 부분만 override — bun:test mock.module leak 으로
// 다른 테스트가 workspace/fs/dialog 등을 참조할 때 누락되면 cascade fail.
const realIpcContractMod = await import("../../../../../src/shared/ipc/contract");
mock.module("../../../../../src/shared/ipc/contract", () => ({
  ...realIpcContractMod,
  ipcContract: {
    ...realIpcContractMod.ipcContract,
    updates: {
      call: {
        check: { args: {} },
        setIgnoredVersion: { args: {} },
        openReleasePage: { args: {} },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock: shared/security/url-scheme
// ---------------------------------------------------------------------------

mock.module("../../../../../src/shared/security/url-scheme", () => ({
  isExternalSchemeAllowed: (_url: string) => true,
}));

// ---------------------------------------------------------------------------
// Lazy imports — after all mocks are registered
// ---------------------------------------------------------------------------

const { installUpdatesDomain } = await import(
  "../../../../../src/main/features/updates/index"
);

// ---------------------------------------------------------------------------
// Helpers — fake objects
// ---------------------------------------------------------------------------

interface FakeRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

function makeFetch(releases: FakeRelease[]): typeof fetch {
  return async () =>
    ({
      ok: true,
      status: 200,
      // Minimal Headers stub — poller reads `etag` to populate its
      // conditional-request cache. Returning null mimics a response with no
      // ETag, which keeps the cache empty and disables 304 short-circuiting
      // for downstream calls (these tests focus on broadcast semantics, not
      // conditional-request behavior — that contract lives in poller.test.ts).
      headers: {
        get(): string | null {
          return null;
        },
      },
      json: async () => releases,
    }) as unknown as Response;
}

function makeNewerFetch(latestTag = "0.2.0"): typeof fetch {
  return makeFetch([
    {
      tag_name: latestTag,
      html_url: `https://github.com/example/repo/releases/tag/${latestTag}`,
      draft: false,
      prerelease: false,
    },
  ]);
}

function makeCurrentFetch(tag = "0.1.0"): typeof fetch {
  return makeFetch([
    {
      tag_name: tag,
      html_url: `https://github.com/example/repo/releases/tag/${tag}`,
      draft: false,
      prerelease: false,
    },
  ]);
}

type AppStatePartial = {
  updateChannel?: "stable" | "beta";
  ignoredUpdateVersion?: string | null;
  autoCheckForUpdates?: boolean;
};

function makeStateService(initial: AppStatePartial = {}) {
  let state: AppStatePartial = {
    updateChannel: "stable",
    ignoredUpdateVersion: null,
    ...initial,
  };
  return {
    getState: () => ({ ...state }),
    setState(partial: AppStatePartial) {
      state = { ...state, ...partial };
    },
  };
}

type BroadcastCall = { channel: string; event: string; payload: unknown };

// ---------------------------------------------------------------------------
// Helper: wait for microtasks + macrotasks to settle
// ---------------------------------------------------------------------------

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Case A — runInitialAutoPoll fires and produces at least one broadcast on newer
// ---------------------------------------------------------------------------

describe("installUpdatesDomain — Case A: runInitialAutoPoll", () => {
  test("runInitialAutoPoll broadcasts statusChanged when newer version available", async () => {
    const calls: BroadcastCall[] = [];
    const broadcast = (ch: string, ev: string, payload: unknown) => {
      calls.push({ channel: ch, event: ev, payload });
    };
    const stateService = makeStateService();

    const handle = installUpdatesDomain({
      broadcast,
      stateService: stateService as never,
      currentVersion: "0.1.0",
      fetchImpl: makeNewerFetch("0.2.0"),
    });

    handle.runInitialAutoPoll();
    await flushAsync();
    // Allow async microtasks to settle.
    await new Promise((r) => setTimeout(r, 10));

    const statusCalls = calls.filter((c) => c.event === "statusChanged");
    expect(statusCalls.length).toBeGreaterThan(0);
    const payload = statusCalls[0].payload as { kind: string; trigger: string };
    expect(payload.kind).toBe("newer");
    expect(payload.trigger).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// Case B — checkManual broadcasts with trigger:"manual"
// ---------------------------------------------------------------------------

describe("installUpdatesDomain — Case B: checkManual trigger", () => {
  test("checkManual broadcasts with trigger:manual", async () => {
    const calls: BroadcastCall[] = [];
    const broadcast = (ch: string, ev: string, payload: unknown) => {
      calls.push({ channel: ch, event: ev, payload });
    };
    const stateService = makeStateService();

    const handle = installUpdatesDomain({
      broadcast,
      stateService: stateService as never,
      currentVersion: "0.1.0",
      fetchImpl: makeNewerFetch("0.2.0"),
    });

    handle.checkManual();
    await new Promise((r) => setTimeout(r, 10));

    const statusCalls = calls.filter((c) => c.event === "statusChanged");
    expect(statusCalls.length).toBeGreaterThan(0);
    const payload = statusCalls[statusCalls.length - 1].payload as {
      kind: string;
      trigger: string;
    };
    // The final result payload should carry trigger:"manual".
    expect(payload.trigger).toBe("manual");
    expect(payload.kind).toBe("newer");
  });
});

// ---------------------------------------------------------------------------
// Case C — ignoredUpdateVersion matches latest → broadcast suppressed
// ---------------------------------------------------------------------------

describe("installUpdatesDomain — Case C: ignoredUpdateVersion suppresses broadcast", () => {
  test("no statusChanged broadcast when latest matches ignoredUpdateVersion", async () => {
    const calls: BroadcastCall[] = [];
    const broadcast = (ch: string, ev: string, payload: unknown) => {
      calls.push({ channel: ch, event: ev, payload });
    };
    // Pre-set ignoredUpdateVersion to the version that will be returned.
    const stateService = makeStateService({ ignoredUpdateVersion: "0.2.0" });

    const handle = installUpdatesDomain({
      broadcast,
      stateService: stateService as never,
      currentVersion: "0.1.0",
      fetchImpl: makeNewerFetch("0.2.0"),
    });

    handle.checkManual();
    await new Promise((r) => setTimeout(r, 10));

    // Only the 3-second "checking" may have fired (timer not elapsed), but
    // the "newer" result broadcast must be absent.
    const newerCalls = calls.filter(
      (c) =>
        c.event === "statusChanged" &&
        (c.payload as { kind: string }).kind === "newer",
    );
    expect(newerCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case D — ignoredUpdateVersion set to different version → broadcast proceeds
// ---------------------------------------------------------------------------

describe("installUpdatesDomain — Case D: ignoredUpdateVersion != latest allows broadcast", () => {
  test("broadcasts newer when ignoredUpdateVersion differs from latest", async () => {
    const calls: BroadcastCall[] = [];
    const broadcast = (ch: string, ev: string, payload: unknown) => {
      calls.push({ channel: ch, event: ev, payload });
    };
    // Ignored version is 0.2.0, but poll returns 0.2.1.
    const stateService = makeStateService({ ignoredUpdateVersion: "0.2.0" });

    const handle = installUpdatesDomain({
      broadcast,
      stateService: stateService as never,
      currentVersion: "0.1.0",
      fetchImpl: makeNewerFetch("0.2.1"),
    });

    handle.checkManual();
    await new Promise((r) => setTimeout(r, 10));

    const newerCalls = calls.filter(
      (c) =>
        c.event === "statusChanged" &&
        (c.payload as { kind: string; latest?: string }).kind === "newer",
    );
    expect(newerCalls.length).toBeGreaterThan(0);
    const payload = newerCalls[0].payload as { latest: string };
    expect(payload.latest).toBe("0.2.1");
  });
});

// ---------------------------------------------------------------------------
// Case E — manual triggers bypass dedupe
//
// Dedupe is meant to suppress noisy auto-poll repeats (same "newer" notice
// every ~30 minutes, or repeated errors while offline). Manual triggers are
// the user's explicit ask for an answer — silently dropping the response
// would leave them clicking a no-op button. This test pins that policy.
// ---------------------------------------------------------------------------

describe("installUpdatesDomain — Case E: manual triggers bypass dedupe", () => {
  test("second consecutive manual poll with same latest still broadcasts", async () => {
    const calls: BroadcastCall[] = [];
    const broadcast = (ch: string, ev: string, payload: unknown) => {
      calls.push({ channel: ch, event: ev, payload });
    };
    const stateService = makeStateService();

    const handle = installUpdatesDomain({
      broadcast,
      stateService: stateService as never,
      currentVersion: "0.1.0",
      fetchImpl: makeNewerFetch("0.2.0"),
    });

    // Two consecutive manual polls with the same result.
    handle.checkManual();
    await new Promise((r) => setTimeout(r, 10));

    const countAfterFirst = calls.filter(
      (c) =>
        c.event === "statusChanged" &&
        (c.payload as { kind: string }).kind === "newer",
    ).length;

    handle.checkManual();
    await new Promise((r) => setTimeout(r, 10));

    const countAfterSecond = calls.filter(
      (c) =>
        c.event === "statusChanged" &&
        (c.payload as { kind: string }).kind === "newer",
    ).length;

    // The second manual call must add exactly one more "newer" broadcast.
    expect(countAfterFirst).toBe(1);
    expect(countAfterSecond).toBe(countAfterFirst + 1);
  });
});

// ---------------------------------------------------------------------------
// Case F — channel change via stateService.setState → ignoredVersion reset + re-poll
// ---------------------------------------------------------------------------

describe("installUpdatesDomain — Case F: channel change resets ignoredVersion and re-polls", () => {
  test("setState with updateChannel resets ignoredUpdateVersion and fires auto-poll", async () => {
    const calls: BroadcastCall[] = [];
    const broadcast = (ch: string, ev: string, payload: unknown) => {
      calls.push({ channel: ch, event: ev, payload });
    };
    // ignoredUpdateVersion pre-set; expect it to be cleared on channel change.
    const stateService = makeStateService({ ignoredUpdateVersion: "0.2.0" });

    installUpdatesDomain({
      broadcast,
      stateService: stateService as never,
      currentVersion: "0.1.0",
      fetchImpl: makeNewerFetch("0.2.0"),
    });

    // Simulate channel change to "beta" via the patched setState.
    stateService.setState({ updateChannel: "beta" });
    await new Promise((r) => setTimeout(r, 10));

    // After channel change, ignoredUpdateVersion must be null.
    expect(stateService.getState().ignoredUpdateVersion).toBeNull();

    // The domain should have fired a new auto-poll; "newer" broadcast should appear
    // (because ignoredVersion was reset to null before polling).
    const newerCalls = calls.filter(
      (c) =>
        c.event === "statusChanged" &&
        (c.payload as { kind: string }).kind === "newer",
    );
    expect(newerCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Case G — 3-second progress: timerScheduler injection
// ---------------------------------------------------------------------------

describe("installUpdatesDomain — Case G: 3-second progress broadcast via timerScheduler", () => {
  test("broadcasts checking after 3s when poll is still pending", async () => {
    const calls: BroadcastCall[] = [];
    const broadcast = (ch: string, ev: string, payload: unknown) => {
      calls.push({ channel: ch, event: ev, payload });
    };
    const stateService = makeStateService();

    // Controlled timer: collect registered callbacks for manual firing.
    type TimerEntry = { callback: () => void; delayMs: number; handle: symbol };
    const timers: TimerEntry[] = [];

    const timerScheduler = {
      setTimeout(callback: () => void, delayMs: number): symbol {
        const handle = Symbol("timer");
        timers.push({ callback, delayMs, handle });
        return handle;
      },
      clearTimeout(handle: unknown): void {
        const idx = timers.findIndex((t) => t.handle === handle);
        if (idx !== -1) timers.splice(idx, 1);
      },
    };

    // Use a fetch that never resolves — poll is perpetually pending.
    const neverFetch: typeof fetch = () => new Promise(() => {});

    const handle = installUpdatesDomain({
      broadcast,
      stateService: stateService as never,
      currentVersion: "0.1.0",
      timerScheduler,
      fetchImpl: neverFetch,
    });

    handle.checkManual();

    // Before firing the timer: no "checking" broadcast yet.
    const beforeFire = calls.filter(
      (c) =>
        c.event === "statusChanged" &&
        (c.payload as { kind: string }).kind === "checking",
    );
    expect(beforeFire.length).toBe(0);

    // Fire the 3-second timer manually.
    const threeSecTimer = timers.find((t) => t.delayMs === 3000);
    expect(threeSecTimer).toBeDefined();
    threeSecTimer!.callback();

    const afterFire = calls.filter(
      (c) =>
        c.event === "statusChanged" &&
        (c.payload as { kind: string; trigger?: string }).kind === "checking",
    );
    expect(afterFire.length).toBe(1);
    const checkingPayload = afterFire[0].payload as { kind: string; trigger: string };
    expect(checkingPayload.trigger).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// Case H — autoCheckForUpdates=false suppresses auto-poll but keeps manual
// ---------------------------------------------------------------------------

describe("installUpdatesDomain — Case H: autoCheckForUpdates toggle gates auto-poll only", () => {
  test("auto-poll is silent when toggle is off; manual still broadcasts", async () => {
    const calls: BroadcastCall[] = [];
    const broadcast = (ch: string, ev: string, payload: unknown) => {
      calls.push({ channel: ch, event: ev, payload });
    };
    const stateService = makeStateService({ autoCheckForUpdates: false });

    const handle = installUpdatesDomain({
      broadcast,
      stateService: stateService as never,
      currentVersion: "0.1.0",
      fetchImpl: makeNewerFetch("0.2.0"),
    });

    // Auto-poll path should suppress without contacting the fetch mock —
    // the toggle gate sits in front of the poll itself.
    handle.runInitialAutoPoll();
    await new Promise((r) => setTimeout(r, 10));
    const autoBroadcasts = calls.filter((c) => c.event === "statusChanged");
    expect(autoBroadcasts.length).toBe(0);

    // Manual path ignores the toggle — user clicked the button, they
    // expect a response.
    handle.checkManual();
    await new Promise((r) => setTimeout(r, 10));
    const manualNewer = calls.filter(
      (c) =>
        c.event === "statusChanged" &&
        (c.payload as { kind: string }).kind === "newer",
    );
    expect(manualNewer.length).toBe(1);
  });
});
