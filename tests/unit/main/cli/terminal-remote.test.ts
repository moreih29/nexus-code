/**
 * nexus terminal ... --device and events --device: another computer's
 * terminals and session changes through the remote's room, the output as
 * the local commands print it.
 */
import { describe, expect, test } from "bun:test";
import type { RemoteSession } from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliDevice } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { APP, CLAUDE_TAB, contextFor, type FakeApp, fakeApp, SHELL_TAB } from "./fake-services";

const NOW = 1_700_000_000_000;
const MINI = "9b1e44d2-0000-4000-8000-000000000002";
const SITE = "dddddddd-0000-4000-8000-0000000000aa";
const API_WS = "eeeeeeee-0000-4000-8000-0000000000ab";
const TERM = "5e6f7a8b-0000-4000-8000-0000000000cc";

const SESSIONS: RemoteSession[] = [
  { workspaceId: SITE, tabId: TERM, kind: "terminal", title: "server", state: "idle" },
];

type Handler = (params: Record<string, unknown>) => unknown;

function withPeer(handlers: Record<string, Handler> = {}): FakeApp {
  const app = fakeApp(NOW);
  const device = (over: Partial<CliDevice> & Pick<CliDevice, "id" | "name">): CliDevice => ({
    platform: "macos",
    self: false,
    online: true,
    serves: [],
    ...over,
  });
  app.peers.devices = [
    device({ id: "3f2a91c0-0000-4000-8000-000000000001", name: "MacBook", self: true }),
    device({ id: MINI, name: "Mac mini", serves: ["sessions", "agents"], schema: "0.2.0" }),
  ];
  const all: Record<string, Handler> = {
    "sessions.list": () => ({
      workspaces: [
        { id: SITE, name: "site", path: "/Users/me/site" },
        { id: API_WS, name: "api", path: "/Users/me/api" },
      ],
      sessions: SESSIONS,
    }),
    ...handlers,
  };
  app.peers.answer = async (_d, method, params) => {
    const handler = all[method];
    if (!handler) throw new Error(`no answer for ${method}`);
    return handler(params as Record<string, unknown>);
  };
  return app;
}

const AGENT = { workspaceId: APP, tabId: CLAUDE_TAB };
const USER = { workspaceId: APP, tabId: SHELL_TAB };

async function nexus(app: FakeApp, argv: string[], caller = USER) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller));
}

function asked(app: FakeApp, method: string) {
  return app.peers.requests.filter((r) => r.method === method).map((r) => r.params);
}

describe("terminal --device", () => {
  test("read prints the terminal there; the tab is needed", async () => {
    const app = withPeer({ "terminal.read": () => ({ text: "$ npm run dev\nready" }) });
    const result = await nexus(app, [
      "terminal",
      "read",
      "server",
      "--device",
      "Mac mini",
      "--lines",
      "20",
    ]);
    expect(result.stdout).toBe("$ npm run dev\nready\n");
    expect(asked(app, "terminal.read")[0]).toEqual({ workspaceId: SITE, tabId: TERM, lines: 20 });
    const missing = await nexus(app, ["terminal", "read", "--device", "Mac mini"]);
    expect(missing.exitCode).toBe(2);
  });

  test("send types as the agent, then --wait waits after it as terminal wait does", async () => {
    let waits = 0;
    const app = withPeer({
      "terminal.input": () => ({ at: NOW + 7 }),
      "terminal.wait": () =>
        ++waits < 2
          ? { done: false, state: "waiting" }
          : { done: true, state: "completed", message: "Tests pass." },
    });
    const result = await nexus(
      app,
      [
        "terminal",
        "send",
        "server",
        "npm",
        "test",
        "--device",
        "Mac mini",
        "--wait",
        "--quiet",
        "3s",
      ],
      AGENT,
    );
    expect(result.stdout).toBe(
      'Sent to server (5e6f7a8b) on "Mac mini".\nClaude Code finished:\nTests pass.\n',
    );
    expect(asked(app, "terminal.input")[0]).toMatchObject({
      workspaceId: SITE,
      tabId: TERM,
      text: "npm test",
      enter: true,
      from: { kind: "terminal", hops: 1 },
    });
    expect(asked(app, "terminal.wait")[0]).toEqual({
      workspaceId: SITE,
      tabId: TERM,
      timeoutMs: 10_000,
      after: NOW + 7,
      quietMs: 3_000,
    });
  });

  test("key presses named keys by name, characters as text, in order", async () => {
    const app = withPeer({ "terminal.input": () => ({ at: NOW }) });
    const result = await nexus(app, [
      "terminal",
      "key",
      "server",
      "ctrl-c",
      "y",
      "Return",
      "q",
      "--device",
      "Mac mini",
    ]);
    expect(result.stdout).toBe('Pressed ctrl-c y Return q in server (5e6f7a8b) on "Mac mini".\n');
    expect(asked(app, "terminal.input")).toEqual([
      { workspaceId: SITE, tabId: TERM, keys: ["ctrl-c"] },
      { workspaceId: SITE, tabId: TERM, text: "y", keys: ["enter"] },
      { workspaceId: SITE, tabId: TERM, text: "q" },
    ]);
    expect(
      (await nexus(app, ["terminal", "key", "server", "f13", "--device", "Mac mini"])).exitCode,
    ).toBe(2);
  });

  test("wait passes --exit and --match; the sentence from there is printed", async () => {
    const app = withPeer({
      "terminal.wait": () => ({ done: true, state: "matched", message: "ready on :3000" }),
    });
    const result = await nexus(app, [
      "terminal",
      "wait",
      "server",
      "--match",
      "^ready",
      "--device",
      "Mac mini",
    ]);
    expect(result.stdout).toBe("ready on :3000\n");
    expect(asked(app, "terminal.wait")[0]).toEqual({
      workspaceId: SITE,
      tabId: TERM,
      timeoutMs: 10_000,
      match: "^ready",
    });
    const exited = withPeer({
      "terminal.wait": () => ({ done: true, state: "exited", message: "server has exited." }),
    });
    const out = await nexus(exited, [
      "terminal",
      "wait",
      "server",
      "--exit",
      "--device",
      "Mac mini",
      "--json",
    ]);
    expect(JSON.parse(out.stdout)).toEqual({
      tabId: TERM,
      workspaceId: SITE,
      device: { id: MINI, name: "Mac mini" },
      state: "exited",
      message: "server has exited.",
    });
    expect(asked(exited, "terminal.wait")[0]).toMatchObject({ exit: true });
  });

  test("new opens a terminal in a workspace there", async () => {
    const app = withPeer({
      "terminal.open": () => ({ tabId: "88888888-0000-4000-8000-000000000088" }),
    });
    const result = await nexus(
      app,
      [
        "terminal",
        "new",
        "--device",
        "Mac mini",
        "--workspace",
        "api",
        "--cwd",
        "web",
        "--command",
        "npm run dev",
      ],
      AGENT,
    );
    expect(result.stdout).toBe('Opened terminal 88888888 in web on "Mac mini".\n');
    expect(asked(app, "terminal.open")[0]).toMatchObject({
      workspaceId: API_WS,
      folder: "web",
      command: "npm run dev",
      from: { kind: "terminal" },
    });
  });
});

describe("events --device", () => {
  const event = (seq: number, workspaceId: string) => ({
    seq,
    at: NOW,
    workspaceId,
    tabId: TERM,
    title: "server",
    kind: "terminal",
    agent: "claude",
    from: "working",
    to: "completed",
    message: "Done.",
  });

  test("reads the computer's changes by its own numbers, its workspaces named", async () => {
    const app = withPeer({
      "events.read": () => ({ events: [event(4, SITE), event(5, API_WS)], cursor: 5, more: false }),
    });
    const result = await nexus(app, [
      "events",
      "--device",
      "Mac mini",
      "--since",
      "3",
      "--workspace",
      "site",
      "--jsonl",
    ]);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records).toEqual([
      expect.objectContaining({
        seq: 4,
        workspace: "site",
        device: { id: MINI, name: "Mac mini" },
      }),
    ]);
    expect(asked(app, "events.read")[0]).toEqual({ since: 3, limit: 500 });
  });

  test("--wait asks again until a change comes; --device all is refused", async () => {
    let reads = 0;
    const app = withPeer({
      "events.read": () =>
        ++reads < 3
          ? { events: [], cursor: 3, more: false }
          : { events: [event(4, SITE)], cursor: 4, more: false },
    });
    const result = await nexus(app, [
      "events",
      "--device",
      "Mac mini",
      "--since",
      "3",
      "--wait",
      "1m",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#4");
    expect(reads).toBe(3);
    expect((await nexus(app, ["events", "--device", "all"])).exitCode).toBe(2);
  });
});
