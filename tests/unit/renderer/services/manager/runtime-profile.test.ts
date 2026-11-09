/**
 * The agent manager runs with the profile its settings choose, or else the
 * agent's default; a change of that profile starts it over in a new
 * conversation, since another profile's folder has not got its session.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface Opened {
  readonly agent: "claude" | "codex";
  readonly props: Record<string, unknown>;
  closed: boolean;
}

const opened: Opened[] = [];

function fakeController(agent: Opened["agent"]) {
  return (props: Record<string, unknown>) => {
    const entry: Opened = { agent, props, closed: false };
    opened.push(entry);
    return {
      open: async () => {},
      close: async () => {
        entry.closed = true;
      },
      send: async () => {},
    };
  };
}

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string) =>
    Promise.resolve(
      channel === "manager" && method === "prepare"
        ? { ok: true, value: { workspaceId: "w-manager", tabId: "t-manager", cwd: "/manager" } }
        : { ok: true, value: undefined },
    ),
  unwrapIpcResult: (result: { ok: boolean; value?: unknown }) => {
    if (!result.ok) throw new Error("failed");
    return result.value;
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
  mustSucceed: (result: { value?: unknown }) => result.value,
}));
mock.module("../../../../../src/renderer/services/chat/controller", () => ({
  chatController: fakeController("claude"),
}));
mock.module("../../../../../src/renderer/services/chat/codex-controller", () => ({
  codexController: fakeController("codex"),
}));
mock.module("../../../../../src/renderer/services/sessions/session-events", () => ({
  onSessionEvents: () => () => {},
}));

const { startManager, managerClaudeHooks } = await import(
  "../../../../../src/renderer/services/manager/runtime"
);
const { useManagerStore } = await import("../../../../../src/renderer/state/stores/manager");
const { useAgentProfilesStore } = await import(
  "../../../../../src/renderer/state/stores/agent-profiles"
);
const { EMPTY_AGENT_PROFILES } = await import("../../../../../src/shared/agent-profiles/profiles");

const WORK = {
  id: "work",
  agent: "claude" as const,
  name: "Work",
  color: "violet",
  dir: "~/.claude-work",
};

/** Lets the manager's start, which waits on main, get to its controller. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function last(): Opened {
  const entry = opened.at(-1);
  if (!entry) throw new Error("the manager did not start");
  return entry;
}

let stopManager: (() => void) | undefined;

beforeEach(() => {
  opened.length = 0;
  useAgentProfilesStore.setState({
    config: { profiles: [WORK], rules: [], defaults: { claude: "work" } },
  });
  useManagerStore.setState({
    enabled: false,
    agent: "claude",
    profiles: {},
    session: undefined,
    live: undefined,
  });
});

afterEach(() => {
  useManagerStore.setState({ enabled: false });
  stopManager?.();
  stopManager = undefined;
  useAgentProfilesStore.setState({ config: EMPTY_AGENT_PROFILES });
});

async function run(): Promise<void> {
  useManagerStore.setState({ enabled: true });
  stopManager = startManager();
  await settle();
}

describe("the manager's profile", () => {
  test("is the agent's default profile when none is chosen", async () => {
    await run();
    expect(last().props.profileId).toBe("work");
    expect(useManagerStore.getState().live?.profileId).toBe("work");
  });

  test("is the one chosen, and the default folder sets none", async () => {
    useManagerStore.setState({ profiles: { claude: "claude-default" } });
    await run();
    expect(last().props.profileId).toBeUndefined();
    expect(useManagerStore.getState().live?.profileId).toBe("claude-default");
  });

  test("a session it made is kept with its profile", async () => {
    await run();
    managerClaudeHooks.onSession?.("s-work");
    expect(useManagerStore.getState().session).toEqual({
      agent: "claude",
      id: "s-work",
      profileId: "work",
    });
  });

  test("another profile chosen starts it over in a new conversation", async () => {
    useManagerStore.setState({ session: { agent: "claude", id: "s-work", profileId: "work" } });
    await run();
    expect(last().props.sessionId).toBe("s-work");
    const first = last();

    useManagerStore.getState().setSettings({ profiles: { claude: "claude-default" } });
    await settle();
    expect(first.closed).toBe(true);
    expect(opened).toHaveLength(2);
    expect(last().props.profileId).toBeUndefined();
    expect(last().props.sessionId).toBeUndefined();
    expect(useManagerStore.getState().session).toBeUndefined();
  });

  test("goes on with its session when chosen back as it was", async () => {
    useManagerStore.setState({ session: { agent: "claude", id: "s-work", profileId: "work" } });
    useManagerStore.setState({ profiles: { claude: "work" } });
    await run();
    expect(last().props.sessionId).toBe("s-work");
    // Choosing the default, which is the same profile, does not start it over.
    useManagerStore.getState().setSettings({ profiles: {} });
    await settle();
    expect(opened).toHaveLength(1);
  });

  test("follows a change of the default profile, unless one is chosen", async () => {
    await run();
    useAgentProfilesStore.setState({
      config: { profiles: [WORK], rules: [], defaults: {} },
    });
    await settle();
    expect(opened).toHaveLength(2);
    expect(last().props.profileId).toBeUndefined();

    useManagerStore.getState().setSettings({ profiles: { claude: "claude-default" } });
    await settle();
    useAgentProfilesStore.setState({
      config: { profiles: [WORK], rules: [], defaults: { claude: "work" } },
    });
    await settle();
    expect(opened).toHaveLength(2);
  });

  test("goes back to the default when the one chosen is removed", async () => {
    useManagerStore.setState({ profiles: { claude: "work" } });
    useAgentProfilesStore.setState({
      config: { profiles: [WORK], rules: [], defaults: {} },
    });
    await run();
    expect(last().props.profileId).toBe("work");
    useAgentProfilesStore.setState({ config: { profiles: [], rules: [], defaults: {} } });
    await settle();
    expect(opened).toHaveLength(2);
    expect(last().props.profileId).toBeUndefined();
  });

  test("a session saved before sessions kept their profile is taken, and given it", async () => {
    useManagerStore.setState({ session: { agent: "claude", id: "s-old" } });
    await run();
    expect(last().props.sessionId).toBe("s-old");
    expect(useManagerStore.getState().session).toEqual({
      agent: "claude",
      id: "s-old",
      profileId: "work",
    });
    // So another profile chosen now leaves it.
    useManagerStore.getState().setSettings({ profiles: { claude: "claude-default" } });
    await settle();
    expect(last().props.sessionId).toBeUndefined();
  });
});
