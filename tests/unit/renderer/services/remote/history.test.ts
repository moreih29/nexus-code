/** The conversations of the past another device may go on with: merged, matched and named. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  CODEX_CATALOG_TTL_MS,
  invalidateCodexHistory,
  readCodexHistoryCatalog,
} from "../../../../../src/renderer/services/chat/codex-history-catalog";
import type { ListedSession } from "../../../../../src/renderer/services/chat/sessions";
import {
  mergedSessions,
  pastSessionsOf,
  tabWithSession,
} from "../../../../../src/renderer/services/remote/history";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { EMPTY_AGENT_PROFILES } from "../../../../../src/shared/agent-profiles/profiles";

const session = (id: string, at: number, over: Partial<ListedSession> = {}): ListedSession => ({
  sessionId: id,
  title: `title ${id}`,
  lastModified: at,
  profileId: "p1",
  ...over,
});

describe("the past conversations", () => {
  test("from each profile's list, newest first, each once", () => {
    const merged = mergedSessions([
      [session("a", 1), session("b", 5)],
      [session("b", 5, { profileId: "p2" }), session("c", 3)],
    ]);
    expect(merged.map((s) => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  test("those that match, at most so many, named by their profile", () => {
    const listed = [
      session("a", 3, { title: "fix the build", size: 120 }),
      session("b", 2, { title: "docs", firstPrompt: "write the build notes" }),
      session("c", 1, { title: "other" }),
    ];
    const name = (id: string) => (id === "p1" ? "Personal" : id);
    expect(pastSessionsOf(listed, "/src/app", name, "BUILD")).toEqual([
      {
        sessionId: "a",
        title: "fix the build",
        at: 3,
        bytes: 120,
        cwd: "/src/app",
        profile: "Personal",
      },
      {
        sessionId: "b",
        title: "docs",
        at: 2,
        cwd: "/src/app",
        profile: "Personal",
        firstPrompt: "write the build notes",
      },
    ]);
    expect(pastSessionsOf(listed, "/src/app", name, undefined, 1)).toHaveLength(1);
  });

  test("with its branch, and the tab it is open in", () => {
    const listed = [
      session("a", 3, { title: "fix", firstPrompt: "fix", gitBranch: "main" }),
      session("b", 2),
    ];
    const openIn = (id: string) => (id === "a" ? "tab-1" : undefined);
    expect(pastSessionsOf(listed, "/w", () => "default", undefined, 50, openIn)).toEqual([
      {
        sessionId: "a",
        title: "fix",
        at: 3,
        cwd: "/w",
        profile: "default",
        gitBranch: "main",
        tabId: "tab-1",
      },
      { sessionId: "b", title: "title b", at: 2, cwd: "/w", profile: "default" },
    ]);
  });
});

describe("a past conversation open already", () => {
  afterEach(() => {
    useTabsStore.setState((s) => {
      const { "ws-history": _gone, ...rest } = s.byWorkspace;
      return { byWorkspace: rest };
    });
  });

  test("is the tab that has it, of its agent", () => {
    useTabsStore.setState((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        "ws-history": {
          t1: { id: "t1", type: "claude", title: "A", props: { cwd: "/p", sessionId: "s1" } },
          t2: { id: "t2", type: "codex", title: "B", props: { cwd: "/p", threadId: "th1" } },
        },
      } as never,
    }));
    expect(tabWithSession("ws-history", "claude", "s1")).toBe("t1");
    expect(tabWithSession("ws-history", "codex", "th1")).toBe("t2");
    expect(tabWithSession("ws-history", "codex", "s1")).toBeUndefined();
  });
});

describe("the peer Codex history catalog", () => {
  const scope = {
    workspaceId: "codex-history-cache",
    cwd: "/p",
    location: { kind: "ssh" as const, host: "host-a", remotePath: "/p" },
    connection: "ready",
    config: EMPTY_AGENT_PROFILES,
  };
  afterEach(() => invalidateCodexHistory(scope.workspaceId));

  test("expires on a fixed deadline and does not keep errors", async () => {
    const clock = spyOn(Date, "now");
    let now = 1;
    let loads = 0;
    clock.mockImplementation(() => now);
    const load = async () => {
      ++loads;
      if (loads === 1 || loads === 4) throw new Error("unavailable");
      return [session(`item-${loads}`, now)];
    };
    const fetch = () => readCodexHistoryCatalog(scope, "p1", false, load);
    try {
      await expect(fetch()).rejects.toThrow("unavailable");
      expect((await fetch())[0]?.sessionId).toBe("item-2");
      now += CODEX_CATALOG_TTL_MS - 1;
      expect((await fetch())[0]?.sessionId).toBe("item-2");
      now += 1;
      expect((await fetch())[0]?.sessionId).toBe("item-3");
      await expect(readCodexHistoryCatalog(scope, "p1", true, load)).rejects.toThrow("unavailable");
      expect((await fetch())[0]?.sessionId).toBe("item-5");
    } finally {
      clock.mockRestore();
    }
  });

  test("does not cross host, profile, folder, connection, or configuration boundaries", async () => {
    let loads = 0;
    const load = async () => [session(`item-${++loads}`, loads)];
    for (const [target, profile] of [
      [scope, "p1"],
      [scope, "p2"],
      [{ ...scope, location: { ...scope.location, host: "host-b" } }, "p2"],
      [{ ...scope, cwd: "/other" }, "p2"],
      [{ ...scope, cwd: "/other", connection: "reconnecting" }, "p2"],
      [{ ...scope, cwd: "/other", connection: "reconnecting", config: { ...scope.config } }, "p2"],
    ] as const) {
      await readCodexHistoryCatalog(target, profile, false, load);
    }
    expect(loads).toBe(6);
  });

  test("an invalidated in-flight read cannot replace a newer catalog", async () => {
    let release!: (list: ListedSession[]) => void;
    const pending = new Promise<ListedSession[]>((resolve) => {
      release = resolve;
    });
    const old = readCodexHistoryCatalog(scope, "p1", false, () => pending);
    invalidateCodexHistory(scope.workspaceId);
    const fresh = readCodexHistoryCatalog(scope, "p1", false, async () => [session("fresh", 2)]);
    expect((await fresh)[0]?.sessionId).toBe("fresh");
    release([session("old", 1)]);
    await old;
    expect(await readCodexHistoryCatalog(scope, "p1", false, async () => [])).toEqual(await fresh);
  });
});
