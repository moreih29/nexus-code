/**
 * The agent view's panels: agents held by session key in a split tree, each
 * change a new layout. Taking an agent out never closes its session; a
 * panel left empty closes unless it is the only one.
 */
import { describe, expect, it } from "bun:test";
import { Grid, type SplitNode } from "../../../../../src/renderer/engine";
import {
  type AgentLayout,
  isRemoteKey,
  openKey,
  parseSessionKey,
  pruneKeys,
  remoteSessionKey,
  sanitizeLayout,
  selectHeldKey,
  showBeside,
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
