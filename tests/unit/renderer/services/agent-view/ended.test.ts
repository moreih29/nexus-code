import { describe, expect, test } from "bun:test";
import {
  type EndedAgent,
  endedAgents,
  endedToRemove,
  noteSeen,
  resumeLine,
  type SeenAgents,
  sameEnded,
} from "../../../../../src/renderer/services/agent-view/ended";
import type { AgentSession } from "../../../../../src/renderer/services/sessions/model";

function session(key: string, over: Partial<AgentSession> = {}): AgentSession {
  const [workspaceId, tabId] = key.split(":") as [string, string];
  return {
    key,
    workspaceId,
    tabId,
    title: "t",
    kind: "terminal",
    agent: "claude",
    state: "idle",
    phase: "idle",
    estimated: false,
    since: undefined,
    message: undefined,
    prompt: undefined,
    ...over,
  };
}

const NONE: SeenAgents = new Map();
const noId = () => undefined;

describe("noteSeen", () => {
  test("keeps the terminal agents with the session id told, not the conversation tabs", () => {
    const seen = noteSeen(
      NONE,
      [session("w:a"), session("w:b", { agent: "codex" }), session("w:c", { kind: "claude" })],
      (key) => (key === "w:a" ? "s-1" : undefined),
    );
    expect([...seen]).toEqual([
      ["w:a", { agent: "claude", sessionId: "s-1", prompted: false }],
      ["w:b", { agent: "codex", sessionId: undefined, prompted: false }],
    ]);
  });

  test("keeps the id told before once no longer told, and the same map when nothing is new", () => {
    const seen = noteSeen(NONE, [session("w:a")], () => "s-1");
    const again = noteSeen(seen, [session("w:a")], noId);
    expect(again).toBe(seen);
    expect(noteSeen(seen, [session("w:a")], () => "s-2").get("w:a")?.sessionId).toBe("s-2");
  });

  test("a session prompted in stays so once its prompt is no longer told, until a new session", () => {
    const prompted = noteSeen(NONE, [session("w:a", { prompt: "hi" })], () => "s-1");
    expect(prompted.get("w:a")?.prompted).toBe(true);
    expect(noteSeen(prompted, [session("w:a")], noId).get("w:a")?.prompted).toBe(true);
    expect(noteSeen(prompted, [session("w:a")], () => "s-2").get("w:a")?.prompted).toBe(false);
  });

  test("an agent other than Claude or Codex is kept as none the panel can start", () => {
    expect(noteSeen(NONE, [session("w:a", { agent: undefined })], noId).get("w:a")).toEqual({
      agent: undefined,
      sessionId: undefined,
      prompted: false,
    });
  });
});

describe("endedAgents", () => {
  const seen: SeenAgents = new Map([
    ["w:a", { agent: "claude", sessionId: "s-1", prompted: false }],
    ["w:b", { agent: "codex", sessionId: undefined, prompted: false }],
  ]);
  const open = (key: string) => key !== "w:gone";

  test("a held terminal seen running, no agent now, still open", () => {
    const ended = endedAgents(["w:a", "w:b"], seen, (key) => key === "w:b", open);
    expect([...ended.keys()]).toEqual(["w:a"]);
  });

  test("not a terminal never seen running, as one not read yet after launch", () => {
    expect(endedAgents(["w:x"], seen, () => false, open).size).toBe(0);
  });

  test("not a terminal closed or ended", () => {
    const gone: SeenAgents = new Map([
      ["w:gone", { agent: "claude", sessionId: undefined, prompted: false }],
    ]);
    expect(endedAgents(["w:gone"], gone, () => false, open).size).toBe(0);
  });
});

describe("endedToRemove", () => {
  const ended = new Map<string, EndedAgent>([
    ["w:a", { agent: "claude", sessionId: undefined, prompted: false }],
    ["w:b", { agent: "claude", sessionId: undefined, prompted: false }],
  ]);

  test("lets go of those no panel has in front", () => {
    expect(endedToRemove(ended, (key) => key === "w:a", true)).toEqual(["w:b"]);
  });

  test("lets go of all once the panels are left", () => {
    expect(endedToRemove(ended, () => true, false)).toEqual(["w:a", "w:b"]);
  });
});

describe("sameEnded", () => {
  test("tells the same agents and ids", () => {
    const a = new Map<string, EndedAgent>([
      ["w:a", { agent: "claude", sessionId: "s", prompted: false }],
    ]);
    expect(sameEnded(a, new Map(a))).toBe(true);
    expect(
      sameEnded(a, new Map([["w:a", { agent: "claude", sessionId: "t", prompted: false }]])),
    ).toBe(false);
    expect(sameEnded(a, new Map())).toBe(false);
  });
});

describe("resumeLine", () => {
  test("Claude's session by its id, once prompted in", () => {
    expect(resumeLine({ agent: "claude", sessionId: "0b5c-11ef", prompted: true })).toBe(
      "claude --resume 0b5c-11ef",
    );
  });

  test("Claude's picker for a session quit before a prompt, which Claude Code keeps not", () => {
    expect(resumeLine({ agent: "claude", sessionId: "0b5c-11ef", prompted: false })).toBe(
      "claude --resume",
    );
  });

  test("Claude's picker when the id is unknown, or not one to type into a shell", () => {
    expect(resumeLine({ agent: "claude", sessionId: undefined, prompted: false })).toBe(
      "claude --resume",
    );
    expect(resumeLine({ agent: "claude", sessionId: "x; rm -rf ~", prompted: true })).toBe(
      "claude --resume",
    );
  });

  test("Codex's picker; none for another agent", () => {
    expect(resumeLine({ agent: "codex", sessionId: undefined, prompted: false })).toBe(
      "codex resume",
    );
    expect(resumeLine({ agent: undefined, sessionId: undefined, prompted: false })).toBeNull();
  });
});
