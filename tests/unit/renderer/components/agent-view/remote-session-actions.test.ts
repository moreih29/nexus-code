import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
let answers: Record<string, unknown[]> = {};
const confirms: { title: string; description: string; confirmLabel?: string }[] = [];
let confirmed: boolean[] = [];

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (channel: string, method: string, args: Record<string, unknown>) => {
    if (channel !== "remote") return Promise.resolve({ ok: true as const, value: undefined });
    calls.push({ method, args });
    const next = answers[method]?.shift();
    return Promise.resolve(next ?? { ok: true as const, value: {} });
  },
}));
mock.module("../../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: (request: { title: string; description: string; confirmLabel?: string }) => {
    confirms.push(request);
    return Promise.resolve(confirmed.shift() ?? true);
  },
}));

const {
  closePeerSession,
  newPeerChat,
  newPeerTerminal,
  renamePeerSession,
  reorderPeerSessions,
  runningProgramOf,
} = await import("../../../../../src/renderer/components/agent-view/remote-session-actions");
const { __resetAgentViewForTests, useAgentViewStore } = await import(
  "../../../../../src/renderer/state/stores/agent-view"
);
const { useRemoteViewStore } = await import("../../../../../src/renderer/state/stores/remote-view");
const { Grid } = await import("../../../../../src/renderer/engine");
const { remoteSessionKey } = await import("../../../../../src/renderer/services/agent-view/layout");
const { watchToasts } = await import("../../../../../src/renderer/components/ui/toast");

const where = {
  deviceId: "d2",
  deviceName: "Work PC",
  workspaceId: "w1",
  workspaceName: "api",
  path: "/src/api",
};
const ok = (value: unknown) => ({ ok: true as const, value });
const refused = (kind: string, message: string) => ({ ok: false as const, kind, message });

const held = () => Grid.allLeaves(useAgentViewStore.getState().root).flatMap((l) => l.tabIds);

function errorsWhile(run: () => Promise<unknown>): Promise<string[]> {
  const errors: string[] = [];
  const stop = watchToasts((toast) => {
    if (toast.kind === "error") errors.push(toast.message);
  });
  return run().then(
    () => {
      stop();
      return errors;
    },
    (error) => {
      stop();
      throw error;
    },
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetAgentViewForTests();
  useRemoteViewStore.setState({ targets: new Map() });
  calls.length = 0;
  confirms.length = 0;
  answers = {};
  confirmed = [];
});

afterEach(() => {
  __resetAgentViewForTests();
  jest.useRealTimers();
});

describe("reordering another computer's sessions", () => {
  test.each([
    true,
    false,
  ])("shows the order before the RPC and keeps it on success=%s", async (ok) => {
    const tabIds = ["t2", "t1"];
    const preview = mock((_order: readonly string[] | undefined) => {});
    const reply = Promise.withResolvers<unknown>();
    answers.peerSessionsReorder = [reply.promise];
    const request = reorderPeerSessions("d2", "w1", tabIds, preview);
    expect(preview.mock.calls).toEqual([[tabIds]]);
    expect(calls).toEqual([
      { method: "peerSessionsReorder", args: { deviceId: "d2", workspaceId: "w1", tabIds } },
    ]);
    reply.resolve(ok ? { ok: true, value: {} } : refused("unavailable", "Device offline"));
    await expect(request).resolves.toBe(ok);
    expect(preview.mock.calls).toEqual(ok ? [[tabIds]] : [[tabIds], [undefined]]);
  });
});

describe("a new session on another computer", () => {
  test("a chat opens there with the profile picked, and shows in a panel as its row would", async () => {
    answers.peerChatNew = [ok({ tabId: "c9" })];
    expect(await newPeerChat(where, "codex", { id: "codex-ab12", name: "Work" })).toBe(true);
    expect(calls[0]).toEqual({
      method: "peerChatNew",
      args: { deviceId: "d2", workspaceId: "w1", agent: "codex", profile: "codex-ab12" },
    });
    const key = remoteSessionKey({ ...where, tabId: "c9" });
    expect(held()).toEqual([key]);
    expect(useRemoteViewStore.getState().targets.get(key)).toEqual({
      ...where,
      tabId: "c9",
      kind: "codex",
      title: "Codex",
      state: "idle",
      profile: "Work",
    });
  });

  test("with no profile picked, the workspace's own: none is named", async () => {
    answers.peerChatNew = [ok({ tabId: "c1" })];
    await newPeerChat(where, "claude");
    expect(calls[0]?.args).toEqual({ deviceId: "d2", workspaceId: "w1", agent: "claude" });
    expect(
      useRemoteViewStore.getState().targets.get(remoteSessionKey({ ...where, tabId: "c1" })),
    ).not.toHaveProperty("profile");
  });

  test("a terminal opens with the shell asked for, or its computer's default", async () => {
    answers.peerTerminalOpen = [ok({ tabId: "t7" }), ok({ tabId: "t8" })];
    await newPeerTerminal(where, { id: "pwsh", name: "PowerShell" });
    await newPeerTerminal(where);
    expect(calls.map((c) => c.args)).toEqual([
      { deviceId: "d2", workspaceId: "w1", shell: "pwsh" },
      { deviceId: "d2", workspaceId: "w1" },
    ]);
    expect(
      useRemoteViewStore.getState().targets.get(remoteSessionKey({ ...where, tabId: "t7" })),
    ).toMatchObject({ kind: "terminal", title: "PowerShell" });
    expect(held()).toHaveLength(2);
  });

  test("one that did not open says why, and no panel shows it", async () => {
    answers.peerChatNew = [refused("permission-denied", "control of the chats is off there")];
    const errors = await errorsWhile(() => newPeerChat(where, "claude"));
    expect(errors).toEqual(["Didn't go through: control of the chats is off there"]);
    expect(held()).toEqual([]);
  });
});

describe("renaming another computer's session", () => {
  test("a chat as a chat, a terminal as a terminal, its title trimmed", async () => {
    const chat = { ...where, tabId: "c1", kind: "claude" as const, title: "Fix" };
    expect(await renamePeerSession(chat, "  Fix the build  ")).toBe(true);
    expect(await renamePeerSession({ ...chat, kind: "terminal" }, "dev server")).toBe(true);
    expect(calls).toEqual([
      {
        method: "peerChatRename",
        args: { deviceId: "d2", workspaceId: "w1", tabId: "c1", title: "Fix the build" },
      },
      {
        method: "peerTerminalRename",
        args: { deviceId: "d2", workspaceId: "w1", tabId: "c1", title: "dev server" },
      },
    ]);
  });
});

describe("closing another computer's session", () => {
  const chat = { ...where, tabId: "c1", kind: "claude" as const, title: "Fix" };
  const terminal = { ...where, tabId: "t1", kind: "terminal" as const, title: "vim" };
  const running = refused("unavailable", "vim is running there; add --force to close it anyway");

  test("a chat closes once the user says so, as /exit does, and its tab goes", async () => {
    useRemoteViewStore.getState().open(chat);
    expect(await closePeerSession(chat)).toBe(true);
    expect(confirms[0]).toMatchObject({
      title: "Close the chat's tab on Work PC?",
      confirmLabel: "Close tab",
    });
    expect(calls).toEqual([
      { method: "peerChatClose", args: { deviceId: "d2", workspaceId: "w1", tabId: "c1" } },
    ]);
    expect(held()).toEqual([]);
  });

  test("nothing goes when the user says no", async () => {
    useRemoteViewStore.getState().open(chat);
    confirmed = [false];
    expect(await closePeerSession(chat)).toBe(false);
    expect(calls).toEqual([]);
    expect(held()).toEqual([remoteSessionKey(chat)]);
  });

  test("a terminal running a program asks again, naming it, then closes it anyway", async () => {
    useRemoteViewStore.getState().open(terminal);
    const view = useAgentViewStore.getState();
    const account = "terminal-account";
    view.setPeerOrderAccount(account);
    view.updateRemoteSeen(account, new Map([[remoteSessionKey(terminal), { at: 10 }]]));
    expect(useAgentViewStore.getState().remoteSeen?.entries.size).toBe(1);
    answers.peerTerminalClose = [running];
    expect(await closePeerSession(terminal)).toBe(true);
    expect(confirms.map((c) => c.title)).toEqual([
      "Close the terminal on Work PC?",
      "Terminate the running process?",
    ]);
    expect(confirms[1]?.description).toContain("“vim”");
    expect(calls.map((c) => c.args)).toEqual([
      { deviceId: "d2", workspaceId: "w1", tabId: "t1" },
      { deviceId: "d2", workspaceId: "w1", tabId: "t1", force: true },
    ]);
    expect(held()).toEqual([]);
    expect(useAgentViewStore.getState().remoteSeen).toBeUndefined();
  });

  test("told no the second time, the terminal stays, and nothing is forced", async () => {
    useRemoteViewStore.getState().open(terminal);
    answers.peerTerminalClose = [running];
    confirmed = [true, false];
    expect(await closePeerSession(terminal)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(held()).toEqual([remoteSessionKey(terminal)]);
  });

  test("any other refusal is told, and forces nothing", async () => {
    useRemoteViewStore.getState().open(terminal);
    answers.peerTerminalClose = [refused("unavailable", "peer.close: no answer in time")];
    const errors = await errorsWhile(() => closePeerSession(terminal));
    expect(errors).toEqual(["Didn't go through: peer.close: no answer in time"]);
    expect(confirms).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(held()).toEqual([remoteSessionKey(terminal)]);
  });

  test("one already gone there goes from here too", async () => {
    useRemoteViewStore.getState().open(chat);
    answers.peerChatClose = [refused("not-found", "no such tab")];
    const errors = await errorsWhile(() => closePeerSession(chat));
    expect(errors).toEqual([]);
    expect(held()).toEqual([]);
  });

  test("the program is read from what its computer says, and nothing else is taken for one", () => {
    expect(runningProgramOf("vim is running there; add --force to close it anyway")).toBe("vim");
    expect(runningProgramOf("npm run dev is running there; add --force")).toBe("npm run dev");
    expect(runningProgramOf("not in the room")).toBeNull();
    expect(runningProgramOf("terminal.close: no answer in time")).toBeNull();
  });
});
