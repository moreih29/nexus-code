import { describe, expect, test } from "bun:test";
import {
  type EndedAgent,
  endedAgents,
  endedFromStore,
  endedToRemove,
  endedToStore,
  noteSeen,
  resumeLine,
  type SeenAgents,
  sameEnded,
  withKept,
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

describe("withKept", () => {
  const kept = new Map<string, EndedAgent>([
    ["w:a", { agent: "claude", sessionId: "s-1", prompted: true }],
    ["w:b", { agent: "codex", sessionId: undefined, prompted: false }],
  ]);

  test("adds what a panel showed ended before a restart", () => {
    const seen = withKept(NONE, kept);
    expect([...seen.keys()]).toEqual(["w:a", "w:b"]);
    expect(seen.get("w:a")).toEqual({ agent: "claude", sessionId: "s-1", prompted: true });
  });

  test("keeps what was seen this run over what was kept", () => {
    const now: SeenAgents = new Map([
      ["w:a", { agent: "claude", sessionId: "s-2", prompted: false }],
    ]);
    expect(withKept(now, kept).get("w:a")?.sessionId).toBe("s-2");
  });

  test("returns the same map when it adds nothing", () => {
    const seen = withKept(NONE, kept);
    expect(withKept(seen, kept)).toBe(seen);
    expect(withKept(NONE, new Map())).toBe(NONE);
  });
});

describe("endedToStore / endedFromStore", () => {
  const ended = new Map<string, EndedAgent>([
    ["w:a", { agent: "claude", sessionId: "s-1", prompted: true }],
    ["w:b", { agent: undefined, sessionId: undefined, prompted: false }],
  ]);

  test("stores each ended agent without the fields it lacks", () => {
    expect(endedToStore(ended)).toEqual({
      "w:a": { agent: "claude", sessionId: "s-1", prompted: true },
      "w:b": { prompted: false },
    });
  });

  test("restores the ended agents of the terminals the panels still hold", () => {
    const restored = endedFromStore(endedToStore(ended), new Set(["w:a"]));
    expect([...restored.entries()]).toEqual([
      ["w:a", { agent: "claude", sessionId: "s-1", prompted: true }],
    ]);
    expect(endedFromStore(undefined, new Set(["w:a"])).size).toBe(0);
  });

  test("restores what a panel can show again", () => {
    const restored = endedFromStore(endedToStore(ended), new Set(["w:a", "w:b"]));
    expect(sameEnded(restored, ended)).toBe(true);
  });
});
