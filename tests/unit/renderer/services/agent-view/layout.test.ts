import { describe, expect, it } from "bun:test";
import { Grid, type SplitNode } from "../../../../../src/renderer/engine";
import {
  type AgentLayout,
  activeKey,
  cycleTab,
  emptyLayout,
  isRemoteKey,
  moveKey,
  openKey,
  parseSessionKey,
  pruneKeys,
  remoteSessionKey,
  removeKey,
  sanitizeLayout,
  selectHeldKey,
  showBeside,
  splitLeaf,
} from "../../../../../src/renderer/services/agent-view/layout";
import { parseRemoteFileKey, remoteFileKey } from "../../../../../src/shared/fs/remote-file-key";

const A = "ws-a:t1";
const B = "ws-a:t2";
const C = "ws-b:t3";

function leaves(layout: AgentLayout) {
  return Grid.allLeaves(layout.root).map((leaf) => ({
    id: leaf.id,
    tabIds: leaf.tabIds,
    activeTabId: leaf.activeTabId,
  }));
}

describe("parseSessionKey", () => {
  it("splits at the first colon", () => {
    expect(parseSessionKey("ws:tab")).toEqual({ workspaceId: "ws", tabId: "tab" });
  });

  it("names nothing without both parts", () => {
    expect(parseSessionKey("ws")).toBeNull();
    expect(parseSessionKey(":tab")).toBeNull();
    expect(parseSessionKey("ws:")).toBeNull();
  });

  it("names no tab of this computer for another computer's session", () => {
    const key = remoteSessionKey({ deviceId: "d2", workspaceId: "w1", tabId: "t1" });
    expect(isRemoteKey(key)).toBe(true);
    expect(isRemoteKey("ws:tab")).toBe(false);
    expect(parseSessionKey(key)).toBeNull();
  });
});

describe("peer file keys", () => {
  it.each(["/w/a #한글%:10.md", "D:\\Work\\a b.txt"])("round-trips %s", (path) => {
    const file = { deviceId: "peer-1", workspaceId: "ws_1", path };
    const key = remoteFileKey(file);
    expect(parseRemoteFileKey(key)).toEqual(file);
    expect(parseSessionKey(key)).toBeNull();
    expect(isRemoteKey(key)).toBe(false);
    expect(remoteFileKey({ ...file, deviceId: "peer-2" })).not.toBe(key);
  });

  it("rejects malformed and relative file keys", () => {
    for (const key of [A, "remote-file:d/w/%", "remote-file:d/w/relative", "remote-file:d/w//a"]) {
      expect(parseRemoteFileKey(key)).toBeNull();
    }
  });
});

describe("file placement", () => {
  const from = "p1";
  const local = "ws-a:editor";
  const remote = remoteFileKey({ deviceId: "d", workspaceId: "w", path: "/a.md" });
  const initial: AgentLayout = {
    root: { kind: "leaf", id: from, tabIds: [A], activeTabId: A },
    activeLeafId: from,
  };
  const beside = () => {
    const ids = ["p2", "split"];
    return showBeside(initial, local, from, () => ids.shift() as string);
  };

  it("splits to the right once, then adds files to the panel beside the session", () => {
    const split = beside();
    const next = showBeside(split, remote, from);
    expect(leaves(next)).toEqual([
      { id: from, tabIds: [A], activeTabId: A },
      { id: split.activeLeafId, tabIds: [local, remote], activeTabId: remote },
    ]);
    expect(selectHeldKey(next, B)).toBeNull();
    const reopened = selectHeldKey(openKey(next, A), local);
    expect(reopened?.activeLeafId).toBe(split.activeLeafId);
    expect(reopened && leaves(reopened)[1]).toEqual({
      id: split.activeLeafId,
      tabIds: [local, remote],
      activeTabId: local,
    });
  });

  it("keeps both files when their source session disappears", () => {
    const next = pruneKeys(showBeside(beside(), remote, from), (key) => key !== A);
    expect(leaves(next)).toEqual([
      { id: next.activeLeafId, tabIds: [local, remote], activeTabId: remote },
    ]);
  });
});

describe("sanitizeLayout", () => {
  it("keeps each agent in one panel, a front agent the panel holds, and an active panel that exists", () => {
    const root: SplitNode = {
      kind: "split",
      id: "s1",
      orientation: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", id: "p1", tabIds: [A, "bad", B], activeTabId: "gone" },
      second: { kind: "leaf", id: "p2", tabIds: [A, C], activeTabId: A },
    };
    const layout = sanitizeLayout(root, "missing");
    expect(leaves(layout)).toEqual([
      { id: "p1", tabIds: [A, B], activeTabId: A },
      { id: "p2", tabIds: [C], activeTabId: C },
    ]);
    expect(layout.activeLeafId).toBe("p1");
  });
});

describe("panel tab activation history", () => {
  const D = "ws-b:t4";

  function openKeys(...keys: string[]): AgentLayout {
    return keys.reduce(
      (layout, key) => openKey(layout, key),
      emptyLayout(() => "p1"),
    );
  }

  it("returns from C to B to A as the active tabs close", () => {
    const next = removeKey(openKeys(A, B, C), C);
    expect(activeKey(next)).toBe(B);
    expect(activeKey(removeKey(next, B))).toBe(A);
  });

  it("uses activation order after keyboard cycling, regardless of tab position", () => {
    const next = cycleTab(openKeys(A, B, C, D), 1);
    expect(activeKey(next)).toBe(A);
    expect(activeKey(removeKey(next, A))).toBe(D);
  });

  it("forgets a background tab without changing the active tab", () => {
    const next = removeKey(openKeys(A, B, C), B);
    expect(activeKey(next)).toBe(C);
    expect(activeKey(removeKey(next, C))).toBe(A);
  });

  it("restores the source tab and activates the moved tab in the destination", () => {
    const E = "ws-b:t5";
    const source = openKey(openKeys(A, B, C), A);
    const split = splitLeaf(source, "p1", "right", D);
    const destination = split.activeLeafId;
    const prepared = openKey(openKey(split, E), D);
    const moved = moveKey(prepared, A, destination);
    expect(Grid.findLeaf(moved.root, "p1")?.activeTabId).toBe(C);
    expect(activeKey(moved)).toBe(A);

    const closedSource = removeKey(moved, C);
    expect(Grid.findLeaf(closedSource.root, "p1")?.activeTabId).toBe(B);
    expect(activeKey(removeKey(closedSource, A))).toBe(D);
  });

  it("ends a prune on the most recently active survivor", () => {
    let layout = openKeys(A, B, C, D);
    for (const key of [A, B, D]) layout = openKey(layout, key);
    const pruned = pruneKeys(layout, (key) => key !== B && key !== D);
    expect(leaves(pruned)[0]).toEqual({ id: "p1", tabIds: [A, C], activeTabId: A });
  });

  it("uses the right neighbor until the restored panel has new activation history", () => {
    const { root, activeLeafId } = openKey(openKeys(A, B, C, D), B);
    const restored = sanitizeLayout(root, activeLeafId);
    expect(activeKey(removeKey(restored, B))).toBe(C);
    expect(activeKey(removeKey(openKey(restored, D), D))).toBe(B);
  });
});
