/**
 * nexus device list, session list --device, and how a command names and
 * asks another computer of the user's: its failures and their exit codes.
 */
import { describe, expect, test } from "bun:test";
import type { RemoteSession } from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { chatAgentContext } from "../../../../src/main/features/cli/commands/agent-context";
import type { CliDevice } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { agentSenderOf, askDevice, resolveDevice } from "../../../../src/main/features/cli/remote";
import { APP, CLAUDE_TAB, contextFor, type FakeApp, fakeApp, SHELL_TAB } from "./fake-services";

const NOW = 1_700_000_000_000;
const SELF = "3f2a91c0-0000-4000-8000-000000000001";
const MINI = "9b1e44d2-0000-4000-8000-000000000002";
const OFFICE = "c07a1e55-0000-4000-8000-000000000003";
const PEER_WS = "dddddddd-0000-4000-8000-0000000000aa";
const PEER_TAB = "1a2b3c4d-0000-4000-8000-0000000000bb";
const PEER_TERM = "5e6f7a8b-0000-4000-8000-0000000000cc";

function device(over: Partial<CliDevice> & Pick<CliDevice, "id" | "name">): CliDevice {
  return { platform: "macos", self: false, online: true, serves: [], ...over };
}

const SESSIONS: RemoteSession[] = [
  {
    workspaceId: PEER_WS,
    tabId: PEER_TAB,
    kind: "claude",
    title: "Review",
    state: "running",
    since: NOW - 60_000,
    last: "Reading the diff",
  },
  { workspaceId: PEER_WS, tabId: PEER_TERM, kind: "terminal", title: "zsh", state: "idle" },
];

/** An app on "MacBook" whose account has "Mac mini" (online, taking agents) and "Office PC" (offline). */
function withDevices(): FakeApp {
  const app = fakeApp(NOW);
  app.peers.devices = [
    device({ id: SELF, name: "MacBook", self: true, serves: ["sessions", "agents"] }),
    device({
      id: MINI,
      name: "Mac mini",
      serves: ["sessions", "chat.read", "agents"],
      schema: "0.2.0",
    }),
    device({
      id: OFFICE,
      name: "Office PC",
      platform: "windows",
      online: false,
      lastSeen: NOW - 2 * 3_600_000,
    }),
  ];
  app.peers.answer = async (_d, method) => {
    if (method === "sessions.list") {
      return {
        workspaces: [{ id: PEER_WS, name: "site", path: "/Users/me/site" }],
        sessions: SESSIONS,
      };
    }
    throw new Error(`no answer for ${method}`);
  };
  return app;
}

async function nexus(
  app: FakeApp,
  argv: string[],
  caller = { workspaceId: APP, tabId: SHELL_TAB },
) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller));
}

/** A failure as the room rejects a request with. */
function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("nexus device list", () => {
  test("lists the account's computers, this one first as the server has them", async () => {
    const result = await nexus(withDevices(), ["device", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "ID        NAME       PLATFORM  STATE             AGENTS",
        "3f2a91c0  MacBook    macos     this computer     -",
        "9b1e44d2  Mac mini   macos     online            yes",
        "c07a1e55  Office PC  windows   offline · 2h ago  -",
        "",
      ].join("\n"),
    );
  });

  test("a computer with an alias is named by it, the name it signed in with beside it", async () => {
    const app = withDevices();
    app.peers.devices = app.peers.devices.map((d) =>
      d.id === MINI ? { ...d, name: "Studio", hostName: "Mac mini" } : d,
    );
    const result = await nexus(app, ["device", "list"]);
    expect(result.stdout).toContain("9b1e44d2  Studio (Mac mini)");
    const listed = JSON.parse((await nexus(app, ["device", "list", "--json"])).stdout);
    expect(listed[1]).toMatchObject({ name: "Studio", hostName: "Mac mini" });
  });

  test("--json has each one's serves and when an offline one was last seen", async () => {
    const result = await nexus(withDevices(), ["device", "list", "--json"]);
    const listed = JSON.parse(result.stdout);
    expect(listed[1]).toEqual({
      id: MINI,
      name: "Mac mini",
      platform: "macos",
      self: false,
      online: true,
      serves: ["sessions", "chat.read", "agents"],
    });
    expect(listed[2]).toMatchObject({ online: false, lastSeen: NOW - 2 * 3_600_000 });
  });

  test("out of the room, it says so with exit 3", async () => {
    const app = withDevices();
    app.peers.inRoom = false;
    const result = await nexus(app, ["device", "list", "--json"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe(
      "nexus: this computer is not in the remote room (Settings › Remote)\n",
    );
    expect(JSON.parse(result.stdout)).toEqual({ error: "not-in-room" });
  });
});

describe("--device", () => {
  const ctx = (app: FakeApp, tabId = SHELL_TAB) => contextFor(app, [], { workspaceId: APP, tabId });

  test("names a computer by id, id prefix or name, case aside; none when left out", async () => {
    const app = withDevices();
    expect(await resolveDevice(ctx(app), undefined)).toBeNull();
    expect((await resolveDevice(ctx(app), MINI))?.name).toBe("Mac mini");
    expect((await resolveDevice(ctx(app), "9b1e"))?.name).toBe("Mac mini");
    expect((await resolveDevice(ctx(app), "office pc"))?.name).toBe("Office PC");
    await expect(resolveDevice(ctx(app), "Laptop")).rejects.toThrow('no device "Laptop"');
  });

  test("a computer with an alias goes by it, and by the name it signed in with", async () => {
    const app = withDevices();
    app.peers.devices = app.peers.devices.map((d) =>
      d.id === MINI ? { ...d, name: "Studio", hostName: "Mac mini" } : d,
    );
    expect((await resolveDevice(ctx(app), "studio"))?.id).toBe(MINI);
    expect((await resolveDevice(ctx(app), "mac mini"))?.id).toBe(MINI);
  });

  test("naming this computer is a usage error", async () => {
    await expect(resolveDevice(ctx(withDevices()), "MacBook")).rejects.toMatchObject({
      message: '"MacBook" is this computer: leave --device out',
      exitCode: 2,
    });
  });

  test("an offline computer is not asked: exit 3, with when it was last seen", async () => {
    const app = withDevices();
    const office = app.peers.devices[2] as CliDevice;
    await expect(askDevice(ctx(app), office, "sessions.list", {})).rejects.toMatchObject({
      message: '"Office PC" is offline (last seen 2h ago)',
      exitCode: 3,
      json: {
        error: "offline",
        device: { id: OFFICE, name: "Office PC" },
        lastSeen: NOW - 7_200_000,
      },
    });
    expect(app.peers.requests).toEqual([]);
  });

  test("the other computer's refusal and silence, as the command tells them", async () => {
    const app = withDevices();
    const mini = app.peers.devices[1] as CliDevice;
    const failWith = (error: Error) => {
      app.peers.answer = async () => {
        throw error;
      };
      return askDevice(ctx(app), mini, "chat.interrupt", { workspaceId: PEER_WS, tabId: PEER_TAB });
    };
    await expect(failWith(rpcError(-32601, "no method chat.interrupt"))).rejects.toMatchObject({
      message: '"Mac mini" runs an older NexusCode (no chat.interrupt)',
      exitCode: 3,
    });
    await expect(failWith(rpcError(1002, "the user there did not allow it"))).rejects.toMatchObject(
      {
        message: '"Mac mini" refused: the user there did not allow it',
        exitCode: 1,
        json: { error: "refused", device: { id: MINI, name: "Mac mini" } },
      },
    );
    await expect(failWith(rpcError(1003, "that device is not in the room"))).rejects.toMatchObject({
      message: '"Mac mini" is offline',
      exitCode: 3,
    });
    await expect(failWith(rpcError(1003, "not in the room"))).rejects.toMatchObject({
      message: "this computer is not in the remote room (Settings › Remote)",
      exitCode: 3,
    });
    await expect(
      failWith(rpcError(1003, "chat.interrupt: no answer in time")),
    ).rejects.toMatchObject({
      message: '"Mac mini" did not answer in time (chat.interrupt)',
      exitCode: 3,
    });
    await expect(failWith(rpcError(1001, "no tab 1a2b3c4d"))).rejects.toMatchObject({
      message: 'on "Mac mini": no tab 1a2b3c4d',
      exitCode: 1,
    });
  });

  test("an agent's request waits on the user there; a wait on its own time", async () => {
    const app = withDevices();
    const mini = app.peers.devices[1] as CliDevice;
    app.peers.answer = async () => ({ done: true, state: "idle" });
    const from = { kind: "terminal" as const, workspaceId: APP, tabId: CLAUDE_TAB };
    await askDevice(ctx(app), mini, "chat.interrupt", {
      workspaceId: PEER_WS,
      tabId: PEER_TAB,
      from,
    });
    await askDevice(ctx(app), mini, "chat.wait", { workspaceId: PEER_WS, tabId: PEER_TAB });
    await askDevice(ctx(app), mini, "sessions.list", {});
    expect(app.peers.requests.map((r) => r.timeoutMs)).toEqual([100_000, 15_000, undefined]);
  });

  test("an agent's request goes only to a computer that takes them", async () => {
    const app = withDevices();
    const from = { kind: "terminal" as const, workspaceId: APP, tabId: CLAUDE_TAB };
    const params = { workspaceId: PEER_WS, tabId: PEER_TAB, from };
    const deny = device({ id: MINI, name: "Mac mini", serves: ["sessions"], schema: "0.2.0" });
    await expect(askDevice(ctx(app), deny, "chat.interrupt", params)).rejects.toMatchObject({
      message: '"Mac mini" does not take requests from agents (Settings › Remote)',
      exitCode: 1,
    });
    // A read, too, says who reads: refused there the same.
    await expect(askDevice(ctx(app), deny, "sessions.list", {})).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(app.peers.requests).toEqual([]);
  });

  test("the sender a request goes with: its tab, the manager's own, the user's terminal", async () => {
    const app = withDevices();
    // The user at a shell is not told from an agent there: it goes as one in that terminal.
    expect(await agentSenderOf(ctx(app))).toEqual({
      kind: "terminal",
      workspaceId: APP,
      tabId: SHELL_TAB,
    });
    expect(await agentSenderOf(ctx(app, CLAUDE_TAB))).toMatchObject({
      kind: "terminal",
      agent: "claude",
      workspaceId: APP,
      tabId: CLAUDE_TAB,
    });
  });
});

describe("nexus session list", () => {
  test("ends with the other computers' agent sessions, a command away", async () => {
    const result = await nexus(withDevices(), ["session", "list"]);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      "+ 1 session on 1 other computer: nexus session list --device all",
    );
    // The JSON stays this computer's alone.
    const json = await nexus(withDevices(), ["session", "list", "--json"]);
    expect(JSON.parse(json.stdout).some((s: { device?: unknown }) => s.device)).toBe(false);
  });

  test("no hint out of the room, or when the others have no agent at work", async () => {
    const app = withDevices();
    app.peers.inRoom = false;
    expect((await nexus(app, ["session", "list"])).stdout).not.toContain("other computer");
    const idle = withDevices();
    idle.peers.answer = async () => ({ workspaces: [], sessions: [] });
    expect((await nexus(idle, ["session", "list"])).stdout).not.toContain("other computer");
  });

  test("--device lists another computer's sessions with a DEVICE column and device in JSON", async () => {
    const app = withDevices();
    const result = await nexus(app, ["session", "list", "--device", "Mac mini"]);
    expect(result.stdout).toBe(
      [
        "ID        DEVICE    WORKSPACE  TITLE   AGENT       STATE    SINCE   LAST",
        "1a2b3c4d  Mac mini  site       Review  claude-tab  running  1m ago  Reading the diff",
        "",
      ].join("\n"),
    );
    const json = JSON.parse(
      (await nexus(app, ["session", "list", "--device", "Mac mini", "--json"])).stdout,
    );
    expect(json).toEqual([
      {
        id: PEER_TAB,
        device: { id: MINI, name: "Mac mini" },
        workspaceId: PEER_WS,
        workspace: "site",
        title: "Review",
        tab: "claude",
        state: "running",
        since: NOW - 60_000,
        message: "Reading the diff",
      },
    ]);
  });

  test("--device names an offline computer: exit 3", async () => {
    const result = await nexus(withDevices(), ["session", "list", "--device", "Office PC"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('nexus: "Office PC" is offline (last seen 2h ago)\n');
  });

  test("--device all has this computer's too, and the offline ones counted in a line", async () => {
    const result = await nexus(withDevices(), ["session", "list", "--device", "all"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+DEVICE\s+WORKSPACE/);
    expect(lines.some((l) => /^\w{8}\s+MacBook\s+app\s/.test(l))).toBe(true);
    expect(
      lines.some((l) => /^1a2b3c4d\s+Mac mini\s+site\s+Review\s+claude-tab\s+running/.test(l)),
    ).toBe(true);
    expect(lines.at(-1)).toBe("1 other computer offline: nexus device list");
  });
});

describe("nexus agent-context", () => {
  test("Codex chat guidance uses the hosting workspace, tab, room and current settings", () => {
    const app = withDevices();
    const tab = "abcdead1-1111-4111-8111-111111111111";
    const current = { enabled: true, agentContext: true };
    const note = () => chatAgentContext(current, app.services, APP, tab);
    expect(note()?.status).toContain('workspace "app", Codex chat tab abcdead1');
    expect(note()?.commands).toContain(
      "Make worktrees with nexus worktree new, not git worktree add",
    );
    expect(note()?.status).toContain("--device NAME");
    app.peers.inRoom = false;
    expect(note()?.status).toContain("outside a Nexus remote room");
    current.agentContext = false;
    expect(note()).toBeUndefined();
    current.agentContext = true;
    current.enabled = false;
    expect(note()).toBeUndefined();
    expect(
      chatAgentContext({ enabled: true, agentContext: true }, app.services, PEER_WS, tab),
    ).toBeUndefined();
  });

  test("delivers a terminal's instruction layers independently of CLI guidance", async () => {
    const app = withDevices();
    app.settings.agentContext = false;
    app.services.terminalClaudeInstructions = (workspaceId, profileId) =>
      `instructions for ${workspaceId}/${profileId}`;
    const ctx = contextFor(app, ["agent-context", "--profile=personal", "-"]);
    const result = await runCli(CLI_COMMANDS, {
      ...ctx,
      invocation: { ...ctx.invocation, stdin: JSON.stringify({ hook_event_name: "SessionStart" }) },
    });
    expect(result.stdout).toBe(`instructions for ${APP}/personal\n`);
  });

  test("returns structured additional context for a tab's updates and compaction", async () => {
    const app = withDevices();
    app.settings.agentContext = false;
    app.services.claudeInstructions = (_workspaceId, _tabId, _launch, compacting) =>
      compacting ? "restore updates" : "updated instructions";
    const ctx = contextFor(app, ["agent-context", "--launch=test", "-"]);
    for (const [event, source, text] of [
      ["UserPromptSubmit", undefined, "updated instructions"],
      ["SessionStart", "compact", "restore updates"],
    ] as const) {
      const result = await runCli(CLI_COMMANDS, {
        ...ctx,
        invocation: {
          ...ctx.invocation,
          stdin: JSON.stringify({ hook_event_name: event, source }),
        },
      });
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: event, additionalContext: text },
      });
    }
  });

  test("tells a session that the user's notes are the app's", async () => {
    const app = withDevices();
    app.settings.agentContext = true;
    expect((await nexus(app, ["agent-context"])).stdout).toContain("nexus note read");
  });
  test("tells a session of the other computers only when this one is in the room", async () => {
    const app = withDevices();
    app.settings.agentContext = true;
    expect((await nexus(app, ["agent-context"])).stdout).toContain("--device NAME");
    app.peers.inRoom = false;
    expect((await nexus(app, ["agent-context"])).stdout).not.toContain("--device");
  });
});
