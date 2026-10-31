/**
 * Where a tab the nexus CLI opens goes: beside the terminal the command came
 * from, never over it, and never taking the active group away from it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
  findTabs,
  groupOf,
  openTab,
  showOpenTab,
} from "../../../../../src/renderer/services/cli/placement";
import { allLeaves } from "../../../../../src/renderer/state/stores/layout/helpers";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout/store";
import { type CreateTabArgs, useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "00000000-0000-4000-8000-0000000000a1";

const editor = (name: string): CreateTabArgs => ({
  type: "editor",
  props: { workspaceId: WS, filePath: `/w/${name}` },
});

let caller: string;

function layout() {
  const slice = useLayoutStore.getState().byWorkspace[WS];
  if (!slice) throw new Error("no layout");
  return slice;
}

function leaves() {
  return allLeaves(layout().root);
}

function shownIn(groupId: string): string | null {
  return leaves().find((leaf) => leaf.id === groupId)?.activeTabId ?? null;
}

beforeEach(() => {
  useLayoutStore.setState({ byWorkspace: {} });
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.getState().ensureLayout(WS);
  const tab = useTabsStore.getState().createTab(WS, { type: "terminal", props: { cwd: "/w" } });
  const group = layout().activeGroupId;
  useLayoutStore.getState().attachTab(WS, group, tab.id);
  useLayoutStore.getState().setActiveTabInGroup({ workspaceId: WS, groupId: group, tabId: tab.id });
  caller = tab.id;
});

describe("openTab", () => {
  it("splits off a group to the right when the caller's group is the only one", () => {
    const callerGroup = groupOf(WS, caller) as string;
    const tabId = openTab(WS, editor("a.ts"), { background: false, besideTabId: caller });

    expect(leaves()).toHaveLength(2);
    const group = groupOf(WS, tabId) as string;
    expect(group).not.toBe(callerGroup);
    expect(shownIn(group)).toBe(tabId);
    expect(shownIn(callerGroup)).toBe(caller);
    expect(layout().activeGroupId).toBe(callerGroup);
  });

  it("uses the other group once there is one", () => {
    const first = openTab(WS, editor("a.ts"), { background: false, besideTabId: caller });
    const second = openTab(WS, editor("b.ts"), { background: false, besideTabId: caller });

    expect(leaves()).toHaveLength(2);
    expect(groupOf(WS, second)).toBe(groupOf(WS, first));
    expect(shownIn(groupOf(WS, second) as string)).toBe(second);
  });

  it("goes in the active group when the user is in another than the caller's", () => {
    const first = openTab(WS, editor("a.ts"), { background: false, besideTabId: caller });
    const other = groupOf(WS, first) as string;
    useLayoutStore.getState().setActiveGroup(WS, other);

    const second = openTab(WS, editor("b.ts"), { background: false, besideTabId: caller });
    expect(groupOf(WS, second)).toBe(other);
  });

  it("in the background, goes behind the caller in its group", () => {
    const tabId = openTab(
      WS,
      { type: "terminal", props: { cwd: "/w" } },
      {
        background: true,
        besideTabId: caller,
      },
    );

    expect(leaves()).toHaveLength(1);
    expect(groupOf(WS, tabId)).toBe(groupOf(WS, caller));
    expect(shownIn(groupOf(WS, caller) as string)).toBe(caller);
  });
});

describe("showOpenTab", () => {
  it("shows a tab open in another group", () => {
    const first = openTab(WS, editor("a.ts"), { background: false, besideTabId: caller });
    openTab(WS, editor("b.ts"), { background: false, besideTabId: caller });
    const places = findTabs(WS, (tab) => tab.id === first);

    expect(showOpenTab(WS, places, { background: false, besideTabId: caller })).toBe(first);
    expect(shownIn(groupOf(WS, first) as string)).toBe(first);
  });

  it("leaves a tab in the caller's group alone, for a new one beside", () => {
    const behind = openTab(WS, editor("a.ts"), { background: true, besideTabId: caller });
    const places = findTabs(WS, (tab) => tab.id === behind);

    expect(showOpenTab(WS, places, { background: false, besideTabId: caller })).toBeNull();
    expect(shownIn(groupOf(WS, caller) as string)).toBe(caller);
  });
});
