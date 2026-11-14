/** Waiting on a chat or a terminal for another device, a request at a time. */
import { describe, expect, test } from "bun:test";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { waitOnChat, waitOnTerminalFor } from "../../../../../src/main/features/remote/waits";

interface Fake {
  tabs: { id: string; type: string; title: string; dead?: boolean }[];
  chat?: { state: string; since?: number; message?: string };
  claude?: { status: string; message?: string; turnStartedAt?: number } | null;
  /** Changes the fake as time goes. */
  onSleep?: (now: number) => void;
}

function services(fake: Fake, start = 100_000) {
  let now = start;
  const s = {
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        fake.onSleep?.(now);
      },
    },
    listWorkspaces: () => [{ id: "w1", name: "app", rootPath: "/src/app" }],
    managerWorkspace: () => null,
    startedAgents: { since: () => undefined },
    claudeStatus: () => fake.claude ?? null,
    activity: () => null,
    foregroundProcess: async () => null,
    waits: { begin: () => () => {} },
    ui: async (op: string) => {
      if (op === "tabs.list") return { tabs: fake.tabs };
      if (op === "chat.state") return { agent: "claude", ...fake.chat };
      if (op === "terminal.read") return { text: "building\nready on :3000\n" };
      throw new Error(`unexpected ${op}`);
    },
  } as unknown as CliServices;
  return { s, now: () => now };
}

const chat = { workspaceId: "w1", tabId: "c1" };
const term = { workspaceId: "w1", tabId: "t1" };

describe("waiting on a chat", () => {
  test("done when it is no longer working, with what it said", async () => {
    const fake: Fake = {
      tabs: [{ id: "c1", type: "claude", title: "Fix" }],
      chat: { state: "working" },
    };
    fake.onSleep = (now) => {
      if (now >= 101_500) fake.chat = { state: "idle", since: now, message: "All fixed." };
    };
    const { s } = services(fake);
    expect(await waitOnChat(s, chat)).toEqual({ done: true, state: "idle", message: "All fixed." });
  });

  test("not done after its time, so the device asks again", async () => {
    const fake: Fake = {
      tabs: [{ id: "c1", type: "claude", title: "Fix" }],
      chat: { state: "working" },
    };
    const { s, now } = services(fake);
    expect(await waitOnChat(s, { ...chat, timeoutMs: 2000 })).toEqual({
      done: false,
      state: "working",
    });
    expect(now()).toBe(102_000);
  });

  test("a message not shown yet counts as working, until the turn shows it", async () => {
    const fake: Fake = {
      tabs: [{ id: "c1", type: "claude", title: "Fix" }],
      chat: { state: "idle", since: 50_000, message: "an older answer" },
    };
    fake.onSleep = (now) => {
      if (now >= 101_000) fake.chat = { state: "idle", since: now, message: "the new one" };
    };
    const { s } = services(fake);
    expect(await waitOnChat(s, { ...chat, after: 100_000 })).toMatchObject({
      message: "the new one",
    });
  });

  test("a message no turn took ends the wait after a while", async () => {
    const fake: Fake = {
      tabs: [{ id: "c1", type: "claude", title: "Fix" }],
      chat: { state: "idle", since: 50_000 },
    };
    const { s } = services(fake, 111_000);
    expect(await waitOnChat(s, { ...chat, after: 100_000 })).toEqual({ done: true, state: "idle" });
  });

  test("closed while waiting; NotFound for no such chat", async () => {
    const fake: Fake = {
      tabs: [{ id: "c1", type: "codex", title: "R" }],
      chat: { state: "working" },
    };
    fake.onSleep = () => {
      fake.tabs = [];
    };
    const { s } = services(fake);
    expect(await waitOnChat(s, chat)).toEqual({ done: true, state: "closed" });
    await expect(waitOnChat(s, chat)).rejects.toMatchObject({ code: 1001 });
  });
});

describe("waiting on a terminal", () => {
  test("its Claude Code done with the turn the input started", async () => {
    const fake: Fake = {
      tabs: [{ id: "t1", type: "terminal", title: "claude" }],
      claude: { status: "running", turnStartedAt: 100_100 },
    };
    fake.onSleep = (now) => {
      if (now >= 103_000)
        fake.claude = { status: "completed", message: "Done.", turnStartedAt: 100_100 };
    };
    const { s } = services(fake, 100_500);
    expect(await waitOnTerminalFor(s, { ...term, after: 100_000 })).toEqual({
      done: true,
      state: "completed",
      message: "Done.",
    });
  });

  test("a turn from before the input is not the one waited on", async () => {
    const fake: Fake = {
      tabs: [{ id: "t1", type: "terminal", title: "claude" }],
      claude: { status: "completed", message: "old", turnStartedAt: 90_000 },
    };
    const { s } = services(fake, 100_500);
    expect(await waitOnTerminalFor(s, { ...term, after: 100_000, timeoutMs: 3000 })).toEqual({
      done: false,
      state: "waiting",
    });
  });

  test("a line that matches; a pattern that is no regex refused", async () => {
    const fake: Fake = { tabs: [{ id: "t1", type: "terminal", title: "dev" }] };
    const { s } = services(fake);
    expect(await waitOnTerminalFor(s, { ...term, match: "^ready" })).toEqual({
      done: true,
      state: "matched",
      message: "ready on :3000",
    });
    await expect(waitOnTerminalFor(s, { ...term, match: "(" })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(waitOnTerminalFor(s, { ...term, match: "x", exit: true })).rejects.toMatchObject({
      code: -32602,
    });
  });

  test("its program's end; only a terminal", async () => {
    const fake: Fake = { tabs: [{ id: "t1", type: "terminal", title: "top" }] };
    fake.onSleep = () => {
      fake.tabs = [{ id: "t1", type: "terminal", title: "top", dead: true }];
    };
    const { s } = services(fake);
    expect(await waitOnTerminalFor(s, { ...term, exit: true })).toMatchObject({
      done: true,
      state: "exited",
    });
    await expect(waitOnTerminalFor(s, { workspaceId: "w1", tabId: "c1" })).rejects.toMatchObject({
      code: 1001,
    });
  });
});
