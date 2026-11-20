/**
 * A command run in another computer's terminal for a chat there (a sign-in
 * banner, a /login) opens in the chat's profile there: by its name, or the
 * agent's only profile when the chat names none, never a guess.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cancelTabFocus } from "../../../../../src/renderer/services/tab-focus";
import { __resetAgentViewForTests } from "../../../../../src/renderer/state/stores/agent-view";
import {
  type RemoteTarget,
  useRemoteViewStore,
} from "../../../../../src/renderer/state/stores/remote-view";

const calls: { method: string; args: Record<string, unknown> }[] = [];
let profiles: { id: string; name: string }[] = [];

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (channel: string, method: string, args: Record<string, unknown>) => {
    if (channel !== "remote") return Promise.resolve({ ok: true as const, value: undefined });
    calls.push({ method, args });
    if (method === "peerProfiles")
      return Promise.resolve({ ok: true as const, value: { profiles } });
    if (method === "peerTerminalOpen")
      return Promise.resolve({ ok: true as const, value: { tabId: "t-new" } });
    return Promise.resolve({ ok: true as const, value: undefined });
  },
}));

const { runInPeerTerminal } = await import(
  "../../../../../src/renderer/components/agent-view/remote-pane"
);
const { watchToasts } = await import("../../../../../src/renderer/components/ui/toast");

const chat = (profile?: string): RemoteTarget => ({
  deviceId: "d",
  deviceName: "PC",
  workspaceId: "w",
  workspaceName: "ws",
  path: "C:/ws",
  tabId: "c",
  kind: "codex",
  title: "Codex",
  ...(profile ? { profile } : {}),
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

async function run(target: RemoteTarget): Promise<string[]> {
  const errors: string[] = [];
  const stop = watchToasts((toast) => {
    if (toast.kind === "error") errors.push(toast.message);
  });
  runInPeerTerminal(target, "codex login --device-auth");
  await settled();
  await settled();
  stop();
  return errors;
}

const opened = () => calls.filter((call) => call.method === "peerTerminalOpen");

describe("a command run in a terminal of a chat's computer", () => {
  beforeEach(() => {
    calls.length = 0;
    resetPanels();
  });
  afterEach(resetPanels);

  test("with one profile of its agent there and no name, opens in that one", async () => {
    profiles = [{ id: "codex-default", name: "default" }];
    expect(await run(chat())).toEqual([]);
    expect(calls[0]).toEqual({ method: "peerProfiles", args: { deviceId: "d", agent: "codex" } });
    expect(opened()).toEqual([
      {
        method: "peerTerminalOpen",
        args: {
          deviceId: "d",
          workspaceId: "w",
          command: "codex login --device-auth",
          profile: "codex-default",
        },
      },
    ]);
  });

  test("by the chat's profile's name where there are more", async () => {
    profiles = [
      { id: "codex-default", name: "default" },
      { id: "codex-ab12", name: "Work" },
    ];
    expect(await run(chat("Work"))).toEqual([]);
    expect(opened().map((call) => call.args.profile)).toEqual(["codex-ab12"]);
  });

  test("with more than one and no name, opens nothing and says so", async () => {
    profiles = [
      { id: "codex-default", name: "default" },
      { id: "codex-ab12", name: "Work" },
    ];
    const errors = await run(chat());
    expect(opened()).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not known here");
  });
});

function resetPanels() {
  __resetAgentViewForTests();
  useRemoteViewStore.setState({ targets: new Map() });
  cancelTabFocus();
}
