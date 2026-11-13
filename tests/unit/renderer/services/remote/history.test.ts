/** The conversations of the past another device may go on with: merged, matched and named. */
import { afterEach, describe, expect, test } from "bun:test";
import type { ListedSession } from "../../../../../src/renderer/services/chat/sessions";
import {
  mergedSessions,
  pastSessionsOf,
  tabWithSession,
} from "../../../../../src/renderer/services/remote/history";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

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
      { sessionId: "b", title: "docs", at: 2, cwd: "/src/app", profile: "Personal" },
    ]);
    expect(pastSessionsOf(listed, "/src/app", name, undefined, 1)).toHaveLength(1);
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
