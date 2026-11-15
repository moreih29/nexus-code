/** The agent lists' groups: an agent whose terminal ended is not listed. */
import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../../../../../src/renderer/services/agent-sessions/model";
import {
  listed,
  ROW_GROUPS,
  sessionsByGroup,
} from "../../../../../src/renderer/services/agent-sessions/rows";

const session = (key: string, over: Partial<AgentSession>): AgentSession => ({
  key,
  workspaceId: "w1",
  tabId: key,
  title: key,
  kind: "terminal",
  agent: "claude",
  state: "idle",
  phase: "idle",
  estimated: false,
  since: undefined,
  message: undefined,
  prompt: undefined,
  ...over,
});

describe("the agent lists", () => {
  test("leave out an agent whose terminal ended, and have no group for it", () => {
    const ended = session("t1", { state: "exited", phase: "idle" });
    const idle = session("t2", {});
    const running = session("t3", { state: "running", phase: "running" });
    expect(listed(ended)).toBe(false);
    expect(sessionsByGroup([ended, idle, running], "").map((s) => s.key)).toEqual(["t3", "t2"]);
    expect(ROW_GROUPS).not.toContain("ended" as never);
  });
});
