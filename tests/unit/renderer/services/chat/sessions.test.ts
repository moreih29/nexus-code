// The Claude tabs that have a session open, which the session list shows
// rather than run it twice.

import { describe, expect, test } from "bun:test";
import { sessionTabs } from "../../../../../src/renderer/services/chat/sessions";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";

function tab(id: string, extra: Partial<Tab>): Tab {
  return {
    id,
    title: id,
    defaultTitle: id,
    isPreview: false,
    isPinned: false,
    ...extra,
  } as Tab;
}

describe("sessionTabs", () => {
  test("maps each Claude tab's session to it, but the asking tab's", () => {
    const tabs = {
      a: tab("a", { type: "claude", props: { cwd: "/w", sessionId: "s1" } }),
      b: tab("b", { type: "claude", props: { cwd: "/w" } }),
      c: tab("c", { type: "claude", props: { cwd: "/w", sessionId: "s2" } }),
      d: tab("d", { type: "terminal", props: { cwd: "/w" } } as Partial<Tab>),
    };
    expect([...sessionTabs(tabs, "c")]).toEqual([["s1", "a"]]);
    expect(sessionTabs(undefined, "a").size).toBe(0);
  });
});
