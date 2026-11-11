import { beforeEach, describe, expect, test } from "bun:test";
import {
  backoffMs,
  FORCED_GAP_MS,
  FRESH_MS,
  ingestClaudeUsage,
  ingestCodexLimits,
  ingestCodexPush,
  type PlanUsageSource,
  POLL_MS,
  planUsageKey,
  pollPlanUsage,
  registerPlanSource,
  resetPlanUsage,
  UNAVAILABLE_MS,
  usePlanUsageStore,
  wantPlanUsage,
} from "../../../../../src/renderer/services/chat/plan-usage";
import type { WorkspaceLocation } from "../../../../../src/shared/types/workspace";

let now = 1_000_000;
const KEY = "claude|local|claude-default";
const LIMITS = { rate_limits: { limits: [{ kind: "session", percent: 40 }] } };

/** A tab of KEY's profile that answers with `answer`, counting its asks. */
function source(
  answer: () => Promise<unknown>,
  { key = KEY, ready = true, busy = false, agent = "claude" as const } = {},
) {
  const tab = {
    asks: 0,
    agent,
    usageKey: () => key,
    ready: () => ready,
    busy: () => busy,
    fetchUsage: () => {
      tab.asks += 1;
      return answer();
    },
  } satisfies PlanUsageSource & { asks: number };
  registerPlanSource(tab);
  return tab;
}

const entry = (key = KEY) => usePlanUsageStore.getState().byKey[key];

beforeEach(() => {
  now = 1_000_000;
  resetPlanUsage(() => now);
});

describe("a profile's key", () => {
  test("is its agent, the host its program runs on, and its id, the default filled in", () => {
    const ssh = {
      kind: "ssh",
      host: "box",
      user: "me",
      remotePath: "/srv/a",
    } as WorkspaceLocation;
    const otherFolder = { ...ssh, remotePath: "/srv/b" } as WorkspaceLocation;
    const wsl = { kind: "wsl", distro: "Ubuntu", remotePath: "/home/a" } as WorkspaceLocation;
    expect(planUsageKey("claude", undefined, undefined)).toBe(KEY);
    expect(planUsageKey("codex", undefined, "work")).toBe("codex|local|work");
    expect(planUsageKey("claude", ssh, "work")).toBe("claude|ssh:me@box:22|work");
    // Another folder on the same host is the same profile.
    expect(planUsageKey("claude", otherFolder, "work")).toBe(planUsageKey("claude", ssh, "work"));
    expect(planUsageKey("claude", wsl, undefined)).toBe("claude|wsl:Ubuntu|claude-default");
  });
});

describe("asking for a profile's usage", () => {
  test("tabs of one profile asking at once make one request", async () => {
    const a = source(() => Promise.resolve(LIMITS));
    const b = source(() => Promise.resolve(LIMITS));
    await Promise.all([wantPlanUsage(KEY), wantPlanUsage(KEY), wantPlanUsage(KEY)]);
    expect(a.asks + b.asks).toBe(1);
    expect(entry()?.claude).toEqual(LIMITS);
    expect(entry()?.fetchedAt).toBe(now);
  });

  test("asks none while what it heard is fresh, and again after", async () => {
    const tab = source(() => Promise.resolve(LIMITS));
    await wantPlanUsage(KEY);
    now += FRESH_MS - 1;
    await wantPlanUsage(KEY);
    expect(tab.asks).toBe(1);
    now += 1;
    await wantPlanUsage(KEY);
    expect(tab.asks).toBe(2);
  });

  test("the user's ask goes sooner, but not twice in a short while", async () => {
    const tab = source(() => Promise.resolve(LIMITS));
    await wantPlanUsage(KEY);
    now += FORCED_GAP_MS - 1;
    await wantPlanUsage(KEY, { force: true });
    expect(tab.asks).toBe(1);
    now += 1;
    await wantPlanUsage(KEY, { force: true });
    expect(tab.asks).toBe(2);
  });

  test("an answer with no limits is a failure: the numbers stay, and it waits longer each time", async () => {
    let answer: unknown = LIMITS;
    const tab = source(() => Promise.resolve(answer));
    await wantPlanUsage(KEY);
    answer = { rate_limits: null };
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      now = entry()?.nextAt ?? now;
      await wantPlanUsage(KEY);
      waits.push((entry()?.nextAt ?? 0) - now);
    }
    expect(tab.asks).toBe(6);
    expect(entry()?.claude).toEqual(LIMITS);
    expect(entry()?.failures).toBe(5);
    const minutes = waits.map((ms) => Math.round(ms / 60_000));
    expect(minutes[0]).toBeGreaterThanOrEqual(2);
    expect(minutes.at(-1)).toBeLessThanOrEqual(17);
    for (let i = 1; i < waits.length; i++)
      expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1] * 0.8);
    // Nor does the user's ask go past a failure's wait.
    now += FORCED_GAP_MS;
    await wantPlanUsage(KEY, { force: true });
    expect(tab.asks).toBe(6);
  });

  test("an answer that comes back after failures starts the waits over", async () => {
    let answer: () => Promise<unknown> = () => Promise.reject(new Error("timeout"));
    source(() => answer());
    await wantPlanUsage(KEY);
    expect(entry()?.failures).toBe(1);
    answer = () => Promise.resolve(LIMITS);
    now = entry()?.nextAt ?? now;
    await wantPlanUsage(KEY);
    expect(entry()?.failures).toBe(0);
    expect(entry()?.nextAt).toBe(now + FRESH_MS);
  });

  test("the waits grow 2, 4, 8, then 15 minutes, give or take a tenth", () => {
    expect([1, 2, 3, 4, 9].map((n) => backoffMs(n, 0.5) / 60_000)).toEqual([2, 4, 8, 15, 15]);
    expect(backoffMs(1, 0)).toBe(108_000);
    expect(backoffMs(1, 1)).toBe(132_000);
  });

  test("a profile without plan limits is asked again after half an hour", async () => {
    source(() => Promise.resolve({ rate_limits: null, rate_limits_available: false }));
    await wantPlanUsage(KEY);
    expect(entry()?.unavailable).toBe(true);
    expect(entry()?.nextAt).toBe(now + UNAVAILABLE_MS);
  });

  test("an idle tab asks before a busy one; one not ready, or of another profile, never", async () => {
    const notReady = source(() => Promise.resolve(LIMITS), { ready: false });
    const other = source(() => Promise.resolve(LIMITS), { key: "claude|local|work" });
    const busy = source(() => Promise.resolve(LIMITS), { busy: true });
    const idle = source(() => Promise.resolve(LIMITS));
    await wantPlanUsage(KEY);
    expect([notReady.asks, other.asks, busy.asks, idle.asks]).toEqual([0, 0, 0, 1]);
  });

  test("a tab that closes while it asks is no failure: the next tab asks at once", async () => {
    let leave = () => {};
    const closing = {
      agent: "claude" as const,
      usageKey: () => KEY,
      ready: () => true,
      busy: () => false,
      fetchUsage: () => {
        leave();
        return Promise.reject(new Error("the tab closed"));
      },
    };
    leave = registerPlanSource(closing);
    await wantPlanUsage(KEY);
    expect(entry()?.failures).toBe(0);
    const next = source(() => Promise.resolve(LIMITS));
    await wantPlanUsage(KEY);
    expect(next.asks).toBe(1);
    expect(entry()?.claude).toEqual(LIMITS);
  });

  test("with no tab that can ask, nothing happens, and it is no failure", async () => {
    source(() => Promise.resolve(LIMITS), { ready: false });
    await wantPlanUsage(KEY);
    expect(entry()).toBeUndefined();
  });

  test("an answer older than the one the profile has is left out", () => {
    ingestClaudeUsage(KEY, LIMITS, now);
    ingestClaudeUsage(KEY, { rate_limits: { limits: [] } }, now - 1);
    expect(entry()?.claude).toEqual(LIMITS);
  });
});

describe("Codex's limits", () => {
  const CODEX = "codex|local|codex-default";
  const window = (usedPercent: number) => ({ usedPercent, windowMins: 300, resetsAt: 1 });

  test("a push lays one window over what the profile has; another bucket's is left out", () => {
    ingestCodexLimits(CODEX, { limitId: "codex", primary: window(10), secondary: window(5) }, now);
    ingestCodexPush(
      CODEX,
      {
        limitId: "codex",
        primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1 },
        secondary: null,
      },
      now + 1,
    );
    expect(entry(CODEX)?.codex?.primary?.usedPercent).toBe(30);
    expect(entry(CODEX)?.codex?.secondary?.usedPercent).toBe(5);
    const before = entry(CODEX)?.codex;
    ingestCodexPush(
      CODEX,
      { limitId: "other", primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1 } },
      now + 2,
    );
    expect(entry(CODEX)?.codex).toBe(before);
  });

  test("a push counts as an answer: no read while it is fresh", async () => {
    const tab = source(() => Promise.resolve({}), { key: CODEX, agent: "codex" });
    ingestCodexPush(
      CODEX,
      { limitId: "codex", primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1 } },
      now,
    );
    await wantPlanUsage(CODEX);
    expect(tab.asks).toBe(0);
  });

  test("a sign-in without ChatGPT has no limits: no failure, asked again after half an hour", async () => {
    source(() => Promise.reject(new Error("chatgpt authentication required")), {
      key: CODEX,
      agent: "codex",
    });
    await wantPlanUsage(CODEX);
    expect(entry(CODEX)?.unavailable).toBe(true);
    expect(entry(CODEX)?.failures).toBe(0);
    expect(entry(CODEX)?.nextAt).toBe(now + UNAVAILABLE_MS);
  });
});

describe("every minute", () => {
  const CODEX = "codex|local|codex-default";
  const CODEX_LIMITS = {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 },
    },
  };
  const settle = () => Bun.sleep(0);

  test("each profile one of whose tabs can ask is asked once, whether or not a tab has a turn", async () => {
    const a = source(() => Promise.resolve(LIMITS));
    const b = source(() => Promise.resolve(LIMITS));
    const codex = source(() => Promise.resolve(CODEX_LIMITS), { key: CODEX, agent: "codex" });
    const stopped = source(() => Promise.resolve(LIMITS), {
      key: "claude|local|work",
      ready: false,
    });
    pollPlanUsage();
    await settle();
    expect(a.asks + b.asks).toBe(1);
    expect(codex.asks).toBe(1);
    expect(stopped.asks).toBe(0);
    expect(entry()?.claude).toEqual(LIMITS);
    expect(entry(CODEX)?.codex?.primary?.usedPercent).toBe(10);
  });

  test("the next minute asks again: what was heard is fresh for less than one", async () => {
    expect(FRESH_MS).toBeLessThan(POLL_MS);
    const tab = source(() => Promise.resolve(LIMITS));
    pollPlanUsage();
    await settle();
    now += POLL_MS;
    pollPlanUsage();
    await settle();
    expect(tab.asks).toBe(2);
  });

  test("an answer that shows the same leaves what the profile has, so nothing is drawn again", async () => {
    const said = (percent: number, resetsAt: string, ranMs: number) => ({
      session: { total_duration_ms: ranMs },
      rate_limits: { limits: [{ kind: "session", percent, resets_at: resetsAt }] },
    });
    let answer = said(40, "2026-11-12T01:00:00.073893+00:00", 1_000);
    source(() => Promise.resolve(answer));
    await wantPlanUsage(KEY);
    const heard = entry()?.claude;
    // How long the session ran, and a reset told a little differently, show nothing new.
    answer = said(40, "2026-11-12T01:00:00.031681+00:00", 61_000);
    now += POLL_MS;
    await wantPlanUsage(KEY);
    expect(entry()?.claude).toBe(heard as Record<string, unknown>);
    expect(entry()?.fetchedAt).toBe(now);
    // Another percent does.
    answer = said(41, "2026-11-12T01:00:00.031681+00:00", 121_000);
    now += POLL_MS;
    await wantPlanUsage(KEY);
    expect(entry()?.claude).toEqual(answer);

    const told = () => ({
      limitId: "codex",
      primary: { usedPercent: 10, windowMins: 300, resetsAt: 1 },
    });
    ingestCodexLimits(CODEX, told(), now);
    const limits = entry(CODEX)?.codex;
    ingestCodexLimits(CODEX, told(), now + 1);
    expect(entry(CODEX)?.codex).toBe(limits as NonNullable<typeof limits>);
  });

  test("none while the window is hidden; shown again, it asks at once", async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "document");
    const page = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    Object.defineProperty(globalThis, "document", { value: page, configurable: true });
    try {
      resetPlanUsage(() => now);
      const tab = source(() => Promise.resolve(LIMITS));
      pollPlanUsage();
      await settle();
      expect(tab.asks).toBe(0);
      page.visibilityState = "visible";
      page.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(tab.asks).toBe(1);
    } finally {
      resetPlanUsage(() => now);
      if (real) Object.defineProperty(globalThis, "document", real);
      else delete (globalThis as { document?: unknown }).document;
    }
  });
});
