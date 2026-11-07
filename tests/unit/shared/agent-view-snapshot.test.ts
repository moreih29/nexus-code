import { describe, expect, test } from "bun:test";
import { AgentViewSnapshotSchema } from "../../../src/shared/types/agent-view";

const LEAF = "00000000-0000-4000-8000-0000000000a1";
const base = {
  mode: "agents",
  root: { kind: "leaf", id: LEAF, tabIds: ["ws:t1"], activeTabId: "ws:t1" },
  activeLeafId: LEAF,
};

describe("AgentViewSnapshotSchema", () => {
  test("reads a snapshot stored before ended agents were", () => {
    const parsed = AgentViewSnapshotSchema.parse(base);
    expect(parsed.ended).toBeUndefined();
  });

  test("reads the ended agents the panels show", () => {
    const ended = {
      "ws:t1": { agent: "claude", sessionId: "s-1", prompted: true },
      "ws:t2": { prompted: false },
    };
    expect(AgentViewSnapshotSchema.parse({ ...base, ended }).ended).toEqual(ended);
  });

  test("drops ended agents it cannot read, keeping the panels", () => {
    const parsed = AgentViewSnapshotSchema.parse({
      ...base,
      ended: { "ws:t1": { agent: "gemini", prompted: true } },
    });
    expect(parsed.ended).toBeUndefined();
    expect(parsed.root).toEqual(base.root);
  });
});
