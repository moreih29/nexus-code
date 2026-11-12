/**
 * The tabs store's setters change one tab, or nothing: a setter that has
 * nothing to change leaves the state as it was, so nothing re-renders, and
 * one that moves a chat tab to another session keeps what else it has.
 */

import { describe, expect, it } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

import { useTabsStore } from "../../../../../../src/renderer/state/stores/tabs";

const tabs = () => useTabsStore.getState();
const WS = "ws-setters";

function editor(path = "/p/a.ts") {
  return tabs().createTab(WS, { type: "editor", props: { workspaceId: WS, filePath: path } }, true);
}

function current(id: string) {
  return tabs().byWorkspace[WS]?.[id];
}

describe("a setter with nothing to change", () => {
  it("leaves the state as it was", () => {
    const tab = editor();
    tabs().renameTab(WS, tab.id, "named");
    const before = tabs().byWorkspace;
    tabs().renameTab(WS, tab.id, "named");
    tabs().setBrowserLastUrl(WS, tab.id, "https://example.com");
    tabs().setClaudeSession(WS, tab.id, "s1");
    tabs().renameTab(WS, "missing", "x");
    expect(tabs().byWorkspace).toBe(before);
  });
});

describe("pinning", () => {
  it("makes a preview tab permanent, and unpinning keeps it so", () => {
    const tab = editor("/p/b.ts");
    expect(current(tab.id)?.isPreview).toBe(true);
    tabs().togglePin(WS, tab.id);
    expect(current(tab.id)).toMatchObject({ isPinned: true, isPreview: false });
    tabs().togglePin(WS, tab.id);
    expect(current(tab.id)).toMatchObject({ isPinned: false, isPreview: false });
  });
});

describe("a Claude tab moved to another session", () => {
  it("keeps its profile, moves, senders and picks, and drops the fork", () => {
    const tab = tabs().createTab(WS, {
      type: "claude",
      props: {
        cwd: "/p",
        fork: { sessionId: "old", at: "u1" },
        profileId: "work",
        moves: [{ after: "u0", profileId: "home", at: 1 }],
        relayed: [{ id: "m1", from: { kind: "tab", agent: "claude", name: "lead" }, at: 1 }],
        chosen: { model: "haiku", effort: "low" },
      },
    });
    tabs().setClaudeSession(WS, tab.id, "copy");
    expect(current(tab.id)?.props).toEqual({
      cwd: "/p",
      sessionId: "copy",
      profileId: "work",
      moves: [{ after: "u0", profileId: "home", at: 1 }],
      relayed: [{ id: "m1", from: { kind: "tab", agent: "claude", name: "lead" }, at: 1 }],
      chosen: { model: "haiku", effort: "low" },
    });
    tabs().setClaudeTarget(WS, tab.id, { fork: { sessionId: "copy", at: "u2" } });
    expect(current(tab.id)?.props).toEqual({
      cwd: "/p",
      fork: { sessionId: "copy", at: "u2" },
      profileId: "work",
      moves: [{ after: "u0", profileId: "home", at: 1 }],
      relayed: [{ id: "m1", from: { kind: "tab", agent: "claude", name: "lead" }, at: 1 }],
      chosen: { model: "haiku", effort: "low" },
    });
  });
});
