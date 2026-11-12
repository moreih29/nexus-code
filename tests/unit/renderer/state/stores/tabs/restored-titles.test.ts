/**
 * A tab's titles across a restart: what the snapshot keeps of them, and
 * what a restored tab starts with (restoredTitles).
 */

import { describe, expect, it } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

import {
  defaultTitle,
  restoredTitles,
  useTabsStore,
} from "../../../../../../src/renderer/state/stores/tabs";
import { type SerializedTab, SerializedTabSchema } from "../../../../../../src/shared/types/layout";

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const ID = "55555555-5555-4555-a555-555555555555";
const CWD = "/home/u/project";

/** The tab as the snapshot saves it and reads it back. */
function throughSnapshot(tabId: string): SerializedTab {
  const tab = useTabsStore.getState().byWorkspace[WS]?.[tabId];
  return SerializedTabSchema.parse(JSON.parse(JSON.stringify(tab)));
}

describe("a tab's titles across a restart", () => {
  it("a renamed chat tab stays the user's name, its conversation's title under it", () => {
    useTabsStore.setState({ byWorkspace: {} });
    const tab = useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: CWD } });
    useTabsStore.getState().setProcessTitle(WS, tab.id, "Fix the login bug");
    useTabsStore.getState().renameTab(WS, tab.id, "Login");

    const restored = restoredTitles(throughSnapshot(tab.id));
    expect(restored).toEqual({
      defaultTitle: defaultTitle({ type: "claude", props: { cwd: CWD } }),
      customTitle: "Login",
      processTitle: "Fix the login bug",
      title: "Login",
    });
  });

  it("a renamed terminal keeps its own name under the user's", () => {
    useTabsStore.setState({ byWorkspace: {} });
    const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: CWD } });
    useTabsStore.getState().renameTab(WS, tab.id, "Server");

    const restored = restoredTitles(throughSnapshot(tab.id));
    expect(restored.customTitle).toBe("Server");
    expect(restored.title).toBe("Server");
    expect(restored.defaultTitle).toBe(tab.defaultTitle);
  });

  it("an older snapshot's chat tab: the shown title is its conversation's, unless it is the tab's name", () => {
    const name = defaultTitle({ type: "codex", props: { cwd: CWD } });
    const older = (title: string): SerializedTab => ({
      id: ID,
      type: "codex",
      title,
      props: { cwd: CWD },
    });
    expect(restoredTitles(older("Review the PR"))).toEqual({
      defaultTitle: name,
      customTitle: undefined,
      processTitle: "Review the PR",
      title: "Review the PR",
    });
    expect(restoredTitles(older(name))).toEqual({
      defaultTitle: name,
      customTitle: undefined,
      processTitle: undefined,
      title: name,
    });
  });

  it("an older snapshot's other tab takes the shown title for its name", () => {
    const tab: SerializedTab = { id: ID, type: "terminal", title: "vim", props: { cwd: CWD } };
    expect(restoredTitles(tab)).toEqual({
      defaultTitle: "vim",
      customTitle: undefined,
      processTitle: undefined,
      title: "vim",
    });
  });
});
