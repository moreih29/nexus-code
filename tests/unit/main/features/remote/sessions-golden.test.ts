/**
 * The sessions' list another device is sent, pinned for one fixed state of
 * the app: how the renderer is read may change, what goes over the network
 * may not.
 */
import { afterEach, expect, test } from "bun:test";
import {
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  type SessionsUpdate,
} from "../../../../../packages/remote-protocol/src";
import type {
  CliServices,
  PendingConsent,
  SessionsRenderer,
} from "../../../../../src/main/features/cli/context";
import { fitsInFrame, MAX_MESSAGE_BYTES } from "../../../../../src/main/features/remote/room";
import { serveWith } from "../../../../../src/main/features/remote/serve";
import { snapshotSessions } from "../../../../../src/main/features/remote/serving/sessions";
import { SessionWatches } from "../../../../../src/main/features/remote/session-watches";
import {
  MAX_SESSION_SNAPSHOT_TABS,
  type SessionsSnapshotReaders,
  sessionsSnapshot,
} from "../../../../../src/renderer/services/cli/sessions-snapshot";
import type { TerminalOpener } from "../../../../../src/shared/chat/relay";
import type { AgentRun } from "../../../../../src/shared/claude/activity";
import { testSessionsRevision } from "../../../../helpers/sessions-snapshot";

const LONG = `First line of a long answer\n\n${"word ".repeat(80)}\tend`;

const WORKSPACES = [
  { id: "w-root", name: "root", rootPath: "/src/root", pinned: false, sortOrder: 1 },
  { id: "w-pin", name: "pinned", rootPath: "/src/pin", pinned: true, sortOrder: 0 },
  {
    id: "w-task",
    name: "task",
    rootPath: "/src/root-task",
    pinned: false,
    sortOrder: 0,
    task: { parentId: "w-root", branch: "feat" },
  },
  { id: "w-gone", name: "gone", rootPath: "/src/gone", pinned: false, sortOrder: 2 },
  { id: "w-chatfail", name: "chatfail", rootPath: "/src/chatfail", pinned: false, sortOrder: 3 },
];

type Tab = {
  id: string;
  type: string;
  title: string;
  dead?: true;
  unstarted?: true;
  openedBy?: TerminalOpener;
};

const CHAT_OPENER = {
  workspaceId: "peer-workspace",
  tabId: "peer-opener",
  kind: "terminal",
  agent: "codex",
  name: `${"a".repeat(119)}😀tail`,
  device: { id: "peer-device", name: `${"한".repeat(118)}😀tail` },
} as const;
const TERMINAL_OPENER = {
  workspaceId: "w-root",
  tabId: "c-ask",
  kind: "tab",
  agent: "claude",
} as const;
const CLIPPED_OPENER = {
  ...CHAT_OPENER,
  name: "a".repeat(119),
  device: { id: "peer-device", name: `${"한".repeat(118)}😀` },
};

/** Each workspace's tabs as the renderer lists them for the remote list (agent order). */
const TABS: Record<string, Tab[]> = {
  "w-root": [
    { id: "c-ask", type: "claude", title: "Asks", openedBy: CHAT_OPENER },
    {
      id: "x-perm",
      type: "terminal",
      title: "claude",
      openedBy: { ...TERMINAL_OPENER, name: "Asks" },
    },
    { id: "c-idle", type: "claude", title: "Idle unread" },
    { id: "e-1", type: "editor", title: "a.ts" },
    { id: "c-err", type: "claude", title: "Failed" },
    { id: "x-done", type: "terminal", title: "done" },
    { id: "x-read", type: "terminal", title: "read" },
    { id: "x-dead", type: "terminal", title: "dead claude", dead: true },
    { id: "x-cold", type: "terminal", title: "cold", unstarted: true },
    { id: "x-shell", type: "terminal", title: "zsh" },
  ],
  "w-pin": [
    { id: "o-work", type: "codex", title: "Codex works" },
    { id: "c-limit", type: "claude", title: "Limit" },
    { id: "x-codex", type: "terminal", title: "codex" },
    { id: "x-quiet", type: "terminal", title: "quiet codex" },
  ],
  "w-task": [
    {
      id: "o-idle",
      type: "codex",
      title: "Codex idle",
      openedBy: { kind: "manager", workspaceId: "manager", tabId: "old-manager" },
    },
    { id: "c-plan", type: "claude", title: "Plan" },
  ],
  "w-chatfail": [
    { id: "c-broken", type: "claude", title: "Broken" },
    { id: "x-other", type: "terminal", title: "other" },
  ],
};

/** Each chat as chat.state (peek, includeWaitingId) tells it. */
const CHATS: Record<string, ReturnType<SessionsSnapshotReaders["peekChat"]>> = {
  "c-ask": {
    agent: "claude",
    state: "asking",
    message: `May I run\n  bun test? ${LONG}`,
    since: 10,
    profile: "work",
    cwd: "/src/root/sub",
    request: { id: "r1", tool: "Bash", input: "bun test" },
    waiting: { kind: "permission", text: `Bash bun\ntest ${LONG}` },
    waitingId: "perm-1",
  },
  "c-idle": { agent: "claude", state: "idle", message: LONG, since: 20 },
  "c-err": {
    agent: "claude",
    state: "error",
    message: "Turn failed\nbadly",
    since: 30,
    failure: "transient",
  },
  "o-work": { agent: "codex", state: "working", message: "Partial", since: 40 },
  "c-limit": {
    agent: "claude",
    state: "idle",
    message: "Hit the limit",
    since: 50,
    limitResume: { state: "waiting", at: 9_000, resetsAt: 8_000, tries: 1 },
  },
  "o-idle": { agent: "codex", state: "idle", since: 60 },
  "c-plan": {
    agent: "claude",
    state: "asking",
    message: "Approve the plan?",
    since: 70,
    waiting: { kind: "plan", text: "1. Do it" },
    goal: { objective: "ship", status: "active" },
  },
};

/** The finished turns the user has not looked at, by workspace and tab. */
const UNREAD = {
  "w-root": { "c-idle": 21, "c-err": 31, "x-done": 81 },
  "w-pin": { "c-limit": 51, "x-codex": 1_001 },
};

const CLAUDE: Record<string, { status: string; message?: string; since: number }> = {
  "x-perm": { status: "permissionPending", message: "Allow rm?", since: 5 },
  "x-done": { status: "completed", message: "All done", since: 80 },
  "x-read": { status: "completed", message: "Read it", since: 90 },
  "x-dead": { status: "running", since: 95 },
  "x-other": { status: "running", message: "Working", since: 99 },
};

/** Terminals without Claude's hooks, as their output tells them: long quiet. */
const ACTIVITY: Record<string, unknown> = {
  "x-codex": {
    lastOutputAt: 1_000,
    program: "codex",
    lastNotice: { title: "Codex", body: "Finished\nthe task", at: 1_000 },
  },
  "x-quiet": { lastOutputAt: 2_000, program: "codex" },
};

const AGENTS: Record<string, AgentRun[]> = {
  "c-ask": [
    {
      id: "s1",
      kind: "subagent",
      type: "Explore",
      description: "Find the\n  loader",
      start: 1,
      state: "running",
      tools: [],
      toolCount: 0,
      failedCount: 0,
    },
  ],
  "x-perm": [
    {
      id: "p1",
      kind: "print",
      program: "codex",
      prompt: "Review it",
      start: 2,
      state: "running",
      tools: [],
      toolCount: 0,
      failedCount: 0,
    },
  ],
  "x-dead": [
    {
      id: "s2",
      kind: "subagent",
      start: 3,
      state: "running",
      tools: [],
      toolCount: 0,
      failedCount: 0,
    },
  ],
};

const CONSENTS: PendingConsent[] = [
  {
    id: "consent-1",
    at: 100,
    expiresAt: Date.now() + 60_000,
    request: {
      id: "req-1",
      timeoutMs: 60_000,
      fromWorkspaceId: "w-root",
      fromTabId: "x-perm",
      toWorkspaceId: "w-pin",
      change: { kind: "terminalNew" },
    },
  },
  {
    id: "consent-2",
    at: 101,
    expiresAt: Date.now() + 60_000,
    request: {
      id: "req-2",
      timeoutMs: 60_000,
      fromWorkspaceId: "w-gone",
      fromTabId: "nowhere",
      toWorkspaceId: "w-root",
      change: { kind: "chatInput", body: "hello" },
    },
  },
] as unknown as PendingConsent[];

/** What the renderer reads of this fixed app state. */
const readers: SessionsSnapshotReaders = {
  readRevision: () => 1,
  listTabs(workspaceId) {
    const tabs = TABS[workspaceId];
    if (!tabs) throw new Error("not open");
    return tabs;
  },
  peekChat(_workspaceId, tabId) {
    const info = CHATS[tabId];
    if (!info) throw new Error(`no chat ${tabId}`);
    return info;
  },
  readUnread: () => UNREAD,
};

const recovered: SessionsSnapshotReaders = {
  ...readers,
  listTabs: (id) => (id === "w-gone" ? [] : readers.listTabs(id)),
  peekChat(workspaceId, tabId) {
    if (tabId === "c-broken") {
      return { agent: "claude", state: "idle", message: "Fixed", since: 111 };
    }
    if (tabId === "o-work") return { agent: "codex", state: "idle", message: "Done", since: 112 };
    return readers.peekChat(workspaceId, tabId);
  },
};

function services(
  snapshot: SessionsRenderer["snapshot"] = async (args) => sessionsSnapshot(args, readers),
): CliServices {
  return {
    listWorkspaces: () => WORKSPACES,
    claudeStatus: (_w: string, tab: string) => CLAUDE[tab] ?? null,
    activity: (_w: string, tab: string) => ACTIVITY[tab] ?? null,
    claudeAsks: (_w: string, tab: string) =>
      tab === "x-perm"
        ? [{ id: "ask-1", tool: "Bash", target: "rm -rf\n dist", always: ["Bash(rm:*)"], since: 5 }]
        : [],
    claudeAgents: { list: (_w: string, tab: string) => AGENTS[tab] ?? [], stop: async () => false },
    consents: { list: () => CONSENTS, answer: async () => false },
    ui: (op: string, args: Parameters<typeof snapshot>[0], timeoutMs: number) => {
      if (op !== "sessions.snapshot") throw new Error(`unexpected ${op}`);
      return snapshot(args, timeoutMs);
    },
  } as unknown as CliServices;
}

const GIT = (w: { id: string }) =>
  w.id === "w-task" ? { branch: "feat", ahead: 1, behind: 2, uncommitted: 3 } : undefined;
const NOTES = { recording: () => ({ noteId: "n1", startedAt: 5 }) } as never;
const CONTROLS = { chat: true, terminal: false };

/** Drops what moves with the clock: a prompt's time left. */
function steady<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, v) => (key === "expiresInMs" || key === "expiresAt" ? 0 : v)),
  );
}

let watches: SessionWatches | undefined;
afterEach(() => watches?.dropAll());

function fullServices(titleLength: number, opener?: "same-list" | "other-device", count = 500) {
  const parentId = "parent".padEnd(64, "t");
  const many: SessionsSnapshotReaders = {
    ...readers,
    listTabs(workspaceId) {
      if (workspaceId !== "w-root") return [];
      return Array.from({ length: count }, (_, i) => ({
        id: i === 0 ? parentId : `session-${i}`.padEnd(64, "t"),
        type: "codex",
        title: "界".repeat(titleLength),
        ...(i > 0 && opener
          ? {
              openedBy: {
                workspaceId: opener === "same-list" ? "w-root" : "p".repeat(64),
                tabId: parentId,
                kind: "tab",
                agent: "codex",
                name: "界".repeat(120),
                ...(opener === "other-device"
                  ? { device: { id: "d".repeat(64), name: "한".repeat(120) } }
                  : {}),
              },
            }
          : {}),
      }));
    },
    peekChat: () => ({
      agent: "codex",
      state: "working",
      message: "한".repeat(200),
      since: 1234567890000,
      profile: "Work",
      cwd: "/src/root/release",
    }),
  };
  return services(async (args) => sessionsSnapshot(args, many));
}

async function fullWatch(titleLength: number, opener?: "same-list" | "other-device") {
  const { list } = await snapshotSessions(fullServices(titleLength, opener), undefined);
  return RPC_METHODS["sessions.watch"].result.parse({ ...list, watchId: "watch" });
}

function replyBytes(result: Awaited<ReturnType<typeof fullWatch>>): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), "utf8");
}

test("500 sessions with long CJK titles and results fit when their opener is in the listing", async () => {
  const result = await fullWatch(120, "same-list");
  expect(result.sessions).toHaveLength(500);
  expect(
    result.sessions.slice(1).every((row) => row.openedBy?.tabId && row.openedBy.name === undefined),
  ).toBe(true);
  expect(replyBytes(result)).toBeLessThan(MAX_MESSAGE_BYTES);
});

test("sessions.list retains names in small replies and falls back to references or no opener only as needed", async () => {
  const id = "목록";
  const request = { from: "phone", method: "sessions.list", params: {}, id } as const;
  const read = async (titleLength: number, count = 500) => {
    const service = fullServices(titleLength, "other-device", count);
    const result = await serveWith(() => service)(request);
    expect(fitsInFrame({ jsonrpc: "2.0", id, result })).toBe(true);
    return RPC_METHODS["sessions.list"].result.parse(result);
  };
  const small = await read(120, 3);
  expect(small.sessions[1]?.openedBy?.name).toHaveLength(120);
  expect(small.sessions[1]?.openedBy?.device?.name).toHaveLength(120);

  const original = await fullWatch(120, "other-device");
  expect(replyBytes(original)).toBeGreaterThan(MAX_MESSAGE_BYTES);
  const references = await read(120);
  expect(references.sessions).toHaveLength(500);
  expect(references.sessions[1]?.openedBy).toEqual({
    workspaceId: "p".repeat(64),
    tabId: "parent".padEnd(64, "t"),
    kind: "tab",
    agent: "codex",
    device: { id: "d".repeat(64) },
  });
  expect(references.sessions.map(({ openedBy: _opener, ...row }) => row)).toEqual(
    original.sessions.map(({ openedBy: _opener, ...row }) => row),
  );

  const removed = await read(180);
  expect(removed.sessions).toHaveLength(500);
  expect(removed.sessions.every((row) => row.openedBy === undefined)).toBe(true);
});

test("a watch starts compact, compares what it sent, and keeps its reduction through updates", async () => {
  const [original, longer] = await Promise.all([
    fullWatch(120, "other-device"),
    fullWatch(180, "other-device"),
  ]);
  let { watchId: _id, ...list } = original;
  const sent: SessionsUpdate[] = [];
  let accept = true;
  watches = new SessionWatches({
    snapshot: async () => ({ list, incompleteWorkspaces: new Set(), forDevice: async () => list }),
    notify: async (_to, params) => {
      expect(fitsInFrame({ jsonrpc: "2.0", method: "sessions.update", params })).toBe(true);
      sent.push(RPC_NOTIFICATIONS["sessions.update"].parse(params));
      return accept;
    },
    pollMs: 60_000,
  });
  const serve = serveWith(() => fullServices(120), { sessions: watches });
  const id = "감시";
  const result = await serve({ from: "phone", method: "sessions.watch", params: {}, id });
  expect(fitsInFrame({ jsonrpc: "2.0", id, result })).toBe(true);
  const first = RPC_METHODS["sessions.watch"].result.parse(result);
  expect(first.sessions).toHaveLength(500);
  expect(first.sessions[1]?.openedBy?.device).toEqual({ id: "d".repeat(64) });
  expect(first.sessions[1]?.openedBy?.name).toBeUndefined();
  await watches.poll();
  expect(sent).toHaveLength(0);

  list = { ...list, sessions: original.sessions.slice(0, 3) };
  await watches.poll();
  expect(sent[0]?.watchId).toBe(first.watchId);
  expect(sent[0]?.sessions).toHaveLength(3);
  expect(sent[0]?.sessions[1]?.openedBy?.device).toEqual({ id: "d".repeat(64) });

  accept = false;
  list = longer;
  await watches.poll();
  expect(sent[1]?.sessions).toHaveLength(500);
  expect(sent[1]?.sessions[1]?.openedBy).toBeUndefined();
  // A rejected update did not commit a stronger reduction.
  list = { ...list, sessions: original.sessions.slice(0, 4) };
  accept = true;
  await watches.poll();
  expect(sent[2]?.sessions[1]?.openedBy?.device).toEqual({ id: "d".repeat(64) });

  list = longer;
  await watches.poll();
  list = { ...list, sessions: original.sessions.slice(0, 2) };
  await watches.poll();
  expect(sent[4]?.sessions).toHaveLength(2);
  expect(sent[4]?.sessions[1]?.openedBy).toBeUndefined();
});

test("a 500-session reply that was already oversized without any opener is still oversized", async () => {
  const service = fullServices(500);
  const read = serveWith(() => service);
  const result = await read({ from: "phone", method: "sessions.list", params: {}, id: 1 });
  expect(fitsInFrame({ jsonrpc: "2.0", id: 1, result })).toBe(false);
  expect(RPC_METHODS["sessions.list"].result.parse(result).sessions).toHaveLength(500);
});

test("only opener references with both IDs are sent and unlisted parents keep their saved names", async () => {
  const extra: SessionsSnapshotReaders = {
    ...readers,
    listTabs: (id) => [
      ...readers.listTabs(id),
      ...(id === "w-root"
        ? [
            {
              id: "missing-ws",
              type: "terminal",
              title: "Shell",
              openedBy: { kind: "tab", tabId: "c-ask" } as const,
            },
            {
              id: "missing-tab",
              type: "terminal",
              title: "Shell",
              openedBy: { kind: "tab", workspaceId: id } as const,
            },
            {
              id: "parent-omitted",
              type: "terminal",
              title: "Shell",
              openedBy: {
                kind: "tab",
                workspaceId: id,
                tabId: "e-1",
                name: "Named opener",
              } as const,
            },
          ]
        : []),
    ],
  };
  const service = services(async (args) => sessionsSnapshot(args, extra));
  const { list } = await snapshotSessions(service, undefined);
  const rows = new Map(list.sessions.map((row) => [row.tabId, row]));
  for (const id of ["missing-ws", "missing-tab"]) {
    expect(rows.has(id)).toBe(true);
    expect(rows.get(id)?.openedBy).toBeUndefined();
  }
  expect(rows.get("parent-omitted")?.openedBy?.name).toBe("Named opener");
});

test("the sessions' list, its consents and its waiting requests stay as they were", async () => {
  const s = services();
  const plain = await snapshotSessions(s, GIT, NOTES, "sessions.list", "phone");
  const waiting = await snapshotSessions(s, GIT, NOTES, "sessions.watch", undefined, true);
  const served = await serveWith(() => s, { git: GIT, notes: NOTES, controls: () => CONTROLS })({
    from: "phone",
    method: "sessions.list",
    params: {},
    id: 1,
  });
  expect(steady(served)).toEqual(EXPECTED.list);
  expect(steady(plain.list)).toEqual(steady(waiting.list));
  expect(
    steady({
      list: await plain.forDevice(CONTROLS),
      incomplete: [...plain.incompleteWorkspaces],
      waitingRequests: waiting.waitingRequests,
      plainWaiting: plain.waitingRequests,
    }),
  ).toEqual(EXPECTED);
});

test("a watch is sent what it was before", async () => {
  let source = readers;
  const s = services(async (args) => sessionsSnapshot(args, source));
  const sent: SessionsUpdate[] = [];
  watches = new SessionWatches({
    snapshot: async (from) => {
      const snapshot = await snapshotSessions(
        s as unknown as CliServices,
        GIT,
        NOTES,
        "sessions.watch",
        from,
      );
      return { ...snapshot, forDevice: () => snapshot.forDevice(CONTROLS) };
    },
    notify: async (_to, update) => {
      sent.push(update);
      return true;
    },
    pollMs: 60_000,
  });
  const first = await watches.watch("phone");
  // The workspace and chat that failed to read read now; the codex chat finished.
  source = recovered;
  await watches.poll();
  await watches.poll();
  expect(sent).toHaveLength(1);
  const { watchId: _first, ...firstList } = first;
  const { watchId: _sent, ...update } = sent[0] as SessionsUpdate;
  expect(steady({ first: firstList, update })).toEqual(EXPECTED_WATCH);
});

test("push reads the same golden list and waiting requests from the watch's cached snapshot", async () => {
  let reads = 0;
  const s = {
    ...services(),
    sessionsRevision: testSessionsRevision(async (args) => {
      reads++;
      return sessionsSnapshot(args, recovered);
    }),
  };
  const watched = await snapshotSessions(s, GIT, NOTES, "sessions.watch", "phone");
  const push = await snapshotSessions(s, GIT, NOTES, "sessions.watch", undefined, true);
  expect(reads).toBe(1);
  expect(steady(await watched.forDevice(CONTROLS))).toEqual(EXPECTED_WATCH.update);
  expect(steady(await push.forDevice(CONTROLS))).toEqual(EXPECTED_WATCH.update);
  expect(push.waitingRequests).toEqual(EXPECTED.waitingRequests);
});

test("the renderer keeps whitespace-only messages and leaves a failed unread read absent", async () => {
  const snapshot = sessionsSnapshot(
    { workspaceIds: ["w-root", "w-gone", "w-chatfail"] },
    {
      ...readers,
      peekChat: (workspaceId, tabId) => ({
        ...readers.peekChat(workspaceId, tabId),
        ...(tabId === "c-idle" ? { message: " \n\t " } : {}),
      }),
      readUnread() {
        throw new Error("unread failed");
      },
    },
  );
  expect(snapshot.unread).toBeUndefined();
  expect(snapshot.workspaces[0]?.tabs?.find(({ id }) => id === "c-idle")?.chat?.message).toBe("");
  expect(snapshot.workspaces[0]?.tabs?.find(({ id }) => id === "x-dead")?.dead).toBe(true);
  expect(snapshot.workspaces[0]?.tabs?.find(({ id }) => id === "x-cold")?.unstarted).toBe(true);
  expect(snapshot.workspaces[1]?.tabs).toBeUndefined();
  expect(snapshot.workspaces[2]?.tabs?.find(({ id }) => id === "c-broken")?.chat).toBeUndefined();
});

test("large renderer replies keep the tab cap without dropping ordered rows or shortening titles", async () => {
  const title = "A title ".repeat(100);
  const source = {
    ...recovered,
    listTabs(workspaceId: string) {
      if (workspaceId !== "w-pin") return recovered.listTabs(workspaceId);
      return [
        ...recovered.listTabs(workspaceId),
        ...Array.from({ length: MAX_SESSION_SNAPSHOT_TABS }, (_, i) => ({
          id: `editor-${i}`,
          type: "editor",
          title: "editor",
        })),
        { id: "after-cap", type: "terminal", title },
      ];
    },
  };
  const sizes: number[] = [];
  const s = services(async (args) => {
    const snapshot = sessionsSnapshot(args, source);
    sizes.push(
      snapshot.workspaces.reduce((count, workspace) => count + (workspace.tabs?.length ?? 0), 0),
    );
    return snapshot;
  });
  const snapshot = await snapshotSessions(s, GIT, NOTES);
  expect(sizes[0]).toBe(MAX_SESSION_SNAPSHOT_TABS);
  expect(sizes).toHaveLength(2);
  expect(snapshot.incompleteWorkspaces.size).toBe(0);
  expect(snapshot.list.sessions[4]).toMatchObject({ tabId: "after-cap", title });
  expect(snapshot.list.sessions[5]?.tabId).toBe("c-ask");
});

test("a renderer revision change during pagination leaves the split workspace incomplete", async () => {
  const large = {
    ...recovered,
    listTabs(workspaceId: string) {
      const tabs = recovered.listTabs(workspaceId);
      return workspaceId === "w-root"
        ? [
            ...tabs,
            ...Array.from({ length: MAX_SESSION_SNAPSHOT_TABS }, (_, i) => ({
              id: `editor-${i}`,
              type: "editor",
              title: "editor",
            })),
          ]
        : tabs;
    },
  };
  const s = services(async (args) =>
    sessionsSnapshot(args, { ...large, readRevision: () => (args.cursor ? 2 : 1) }),
  );
  const snapshot = await snapshotSessions(s, GIT, NOTES);
  expect([...snapshot.incompleteWorkspaces]).toEqual(["w-root", "w-task", "w-gone", "w-chatfail"]);
  expect(snapshot.list.sessions).toHaveLength(4);
  expect(snapshot.list.sessions.every((row) => row.workspaceId === "w-pin")).toBe(true);
});

const EXPECTED = {
  list: {
    workspaces: [
      {
        id: "w-pin",
        name: "pinned",
        path: "/src/pin",
        pinned: true,
      },
      {
        id: "w-root",
        name: "root",
        path: "/src/root",
      },
      {
        id: "w-task",
        name: "task",
        path: "/src/root-task",
        parentId: "w-root",
        git: {
          branch: "feat",
          ahead: 1,
          behind: 2,
          uncommitted: 3,
        },
      },
      {
        id: "w-gone",
        name: "gone",
        path: "/src/gone",
      },
      {
        id: "w-chatfail",
        name: "chatfail",
        path: "/src/chatfail",
      },
    ],
    sessions: [
      {
        workspaceId: "w-pin",
        tabId: "o-work",
        kind: "codex",
        title: "Codex works",
        state: "running",
        since: 40,
        last: "Partial",
      },
      {
        workspaceId: "w-pin",
        tabId: "c-limit",
        kind: "claude",
        title: "Limit",
        state: "idle",
        since: 50,
        last: "Hit the limit",
        limitWait: {
          at: 9000,
        },
      },
      {
        workspaceId: "w-pin",
        tabId: "x-codex",
        kind: "terminal",
        title: "codex",
        state: "new-result",
        agent: "codex",
        since: 1001,
        last: "Codex: Finished the task",
      },
      {
        workspaceId: "w-pin",
        tabId: "x-quiet",
        kind: "terminal",
        title: "quiet codex",
        state: "idle",
        agent: "codex",
        since: 2000,
      },
      {
        workspaceId: "w-root",
        tabId: "c-ask",
        kind: "claude",
        title: "Asks",
        openedBy: CLIPPED_OPENER,
        state: "needs-you",
        since: 10,
        last: "May I run bun test? First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word w…",
        profile: "work",
        cwd: "/src/root/sub",
        waiting: {
          kind: "permission",
          text: "Bash bun test First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word wo…",
        },
        agents: [
          {
            id: "s1",
            kind: "subagent",
            type: "Explore",
            description: "Find the loader",
            state: "running",
            start: 1,
          },
        ],
      },
      {
        workspaceId: "w-root",
        tabId: "x-perm",
        kind: "terminal",
        title: "claude",
        openedBy: TERMINAL_OPENER,
        state: "needs-you",
        agent: "claude",
        since: 5,
        last: "Allow rm?",
        waiting: {
          kind: "permission",
          text: "Bash rm -rf dist",
          requestId: "ask-1",
          always: true,
          subagent: false,
        },
        agents: [
          {
            id: "p1",
            kind: "print",
            program: "codex",
            description: "Review it",
            state: "running",
            start: 2,
          },
        ],
      },
      {
        workspaceId: "w-root",
        tabId: "c-idle",
        kind: "claude",
        title: "Idle unread",
        state: "new-result",
        since: 21,
        last: "First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word w…",
      },
      {
        workspaceId: "w-root",
        tabId: "c-err",
        kind: "claude",
        title: "Failed",
        state: "idle",
        failed: true,
        since: 30,
        last: "Turn failed badly",
      },
      {
        workspaceId: "w-root",
        tabId: "x-done",
        kind: "terminal",
        title: "done",
        state: "new-result",
        agent: "claude",
        since: 81,
        last: "All done",
      },
      {
        workspaceId: "w-root",
        tabId: "x-read",
        kind: "terminal",
        title: "read",
        state: "idle",
        agent: "claude",
        since: 90,
        last: "Read it",
      },
      {
        workspaceId: "w-root",
        tabId: "x-dead",
        kind: "terminal",
        title: "dead claude",
        state: "ended",
        agent: "claude",
        since: 95,
      },
      {
        workspaceId: "w-root",
        tabId: "x-shell",
        kind: "terminal",
        title: "zsh",
        state: "idle",
      },
      {
        workspaceId: "w-task",
        tabId: "o-idle",
        kind: "codex",
        title: "Codex idle",
        state: "idle",
        since: 60,
      },
      {
        workspaceId: "w-task",
        tabId: "c-plan",
        kind: "claude",
        title: "Plan",
        state: "needs-you",
        since: 70,
        last: "Approve the plan?",
        waiting: {
          kind: "plan",
          text: "1. Do it",
        },
      },
      {
        workspaceId: "w-chatfail",
        tabId: "x-other",
        kind: "terminal",
        title: "other",
        state: "running",
        agent: "claude",
        since: 99,
        last: "Working",
      },
    ],
    incompleteWorkspaces: ["w-gone", "w-chatfail"],
    recording: {
      noteId: "n1",
      startedAt: 5,
    },
    consents: [
      {
        id: "consent-1",
        at: 100,
        expiresAt: 0,
        expiresInMs: 0,
        from: {
          workspaceId: "w-root",
          workspaceName: "root",
          tabId: "x-perm",
          name: "claude",
        },
        workspaceId: "w-pin",
        change: {
          kind: "terminalNew",
        },
        eachTime: false,
        answerable: false,
      },
      {
        id: "consent-2",
        at: 101,
        expiresAt: 0,
        expiresInMs: 0,
        from: {
          workspaceId: "w-gone",
          workspaceName: "gone",
          tabId: "nowhere",
        },
        workspaceId: "w-root",
        change: {
          kind: "chatInput",
          body: "hello",
        },
        eachTime: false,
        answerable: true,
      },
    ],
  },
  incomplete: ["w-gone", "w-chatfail"],
  waitingRequests: [
    {
      workspaceId: "w-root",
      key: '["w-root","c-ask","claude","perm-1"]',
    },
    {
      workspaceId: "w-root",
      key: '["w-root","x-perm","terminal","ask-1"]',
    },
  ],
  plainWaiting: [],
};
const EXPECTED_WATCH = {
  first: {
    workspaces: [
      {
        id: "w-pin",
        name: "pinned",
        path: "/src/pin",
        pinned: true,
      },
      {
        id: "w-root",
        name: "root",
        path: "/src/root",
      },
      {
        id: "w-task",
        name: "task",
        path: "/src/root-task",
        parentId: "w-root",
        git: {
          branch: "feat",
          ahead: 1,
          behind: 2,
          uncommitted: 3,
        },
      },
      {
        id: "w-gone",
        name: "gone",
        path: "/src/gone",
      },
      {
        id: "w-chatfail",
        name: "chatfail",
        path: "/src/chatfail",
      },
    ],
    sessions: [
      {
        workspaceId: "w-pin",
        tabId: "o-work",
        kind: "codex",
        title: "Codex works",
        state: "running",
        since: 40,
        last: "Partial",
      },
      {
        workspaceId: "w-pin",
        tabId: "c-limit",
        kind: "claude",
        title: "Limit",
        state: "idle",
        since: 50,
        last: "Hit the limit",
        limitWait: {
          at: 9000,
        },
      },
      {
        workspaceId: "w-pin",
        tabId: "x-codex",
        kind: "terminal",
        title: "codex",
        state: "new-result",
        agent: "codex",
        since: 1001,
        last: "Codex: Finished the task",
      },
      {
        workspaceId: "w-pin",
        tabId: "x-quiet",
        kind: "terminal",
        title: "quiet codex",
        state: "idle",
        agent: "codex",
        since: 2000,
      },
      {
        workspaceId: "w-root",
        tabId: "c-ask",
        kind: "claude",
        title: "Asks",
        openedBy: CLIPPED_OPENER,
        state: "needs-you",
        since: 10,
        last: "May I run bun test? First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word w…",
        profile: "work",
        cwd: "/src/root/sub",
        waiting: {
          kind: "permission",
          text: "Bash bun test First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word wo…",
        },
        agents: [
          {
            id: "s1",
            kind: "subagent",
            type: "Explore",
            description: "Find the loader",
            state: "running",
            start: 1,
          },
        ],
      },
      {
        workspaceId: "w-root",
        tabId: "x-perm",
        kind: "terminal",
        title: "claude",
        openedBy: TERMINAL_OPENER,
        state: "needs-you",
        agent: "claude",
        since: 5,
        last: "Allow rm?",
        waiting: {
          kind: "permission",
          text: "Bash rm -rf dist",
          requestId: "ask-1",
          always: true,
          subagent: false,
        },
        agents: [
          {
            id: "p1",
            kind: "print",
            program: "codex",
            description: "Review it",
            state: "running",
            start: 2,
          },
        ],
      },
      {
        workspaceId: "w-root",
        tabId: "c-idle",
        kind: "claude",
        title: "Idle unread",
        state: "new-result",
        since: 21,
        last: "First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word w…",
      },
      {
        workspaceId: "w-root",
        tabId: "c-err",
        kind: "claude",
        title: "Failed",
        state: "idle",
        failed: true,
        since: 30,
        last: "Turn failed badly",
      },
      {
        workspaceId: "w-root",
        tabId: "x-done",
        kind: "terminal",
        title: "done",
        state: "new-result",
        agent: "claude",
        since: 81,
        last: "All done",
      },
      {
        workspaceId: "w-root",
        tabId: "x-read",
        kind: "terminal",
        title: "read",
        state: "idle",
        agent: "claude",
        since: 90,
        last: "Read it",
      },
      {
        workspaceId: "w-root",
        tabId: "x-dead",
        kind: "terminal",
        title: "dead claude",
        state: "ended",
        agent: "claude",
        since: 95,
      },
      {
        workspaceId: "w-root",
        tabId: "x-shell",
        kind: "terminal",
        title: "zsh",
        state: "idle",
      },
      {
        workspaceId: "w-task",
        tabId: "o-idle",
        kind: "codex",
        title: "Codex idle",
        state: "idle",
        since: 60,
      },
      {
        workspaceId: "w-task",
        tabId: "c-plan",
        kind: "claude",
        title: "Plan",
        state: "needs-you",
        since: 70,
        last: "Approve the plan?",
        waiting: {
          kind: "plan",
          text: "1. Do it",
        },
      },
      {
        workspaceId: "w-chatfail",
        tabId: "x-other",
        kind: "terminal",
        title: "other",
        state: "running",
        agent: "claude",
        since: 99,
        last: "Working",
      },
    ],
    incompleteWorkspaces: ["w-gone", "w-chatfail"],
    recording: {
      noteId: "n1",
      startedAt: 5,
    },
    consents: [
      {
        id: "consent-1",
        at: 100,
        expiresAt: 0,
        expiresInMs: 0,
        from: {
          workspaceId: "w-root",
          workspaceName: "root",
          tabId: "x-perm",
          name: "claude",
        },
        workspaceId: "w-pin",
        change: {
          kind: "terminalNew",
        },
        eachTime: false,
        answerable: false,
      },
      {
        id: "consent-2",
        at: 101,
        expiresAt: 0,
        expiresInMs: 0,
        from: {
          workspaceId: "w-gone",
          workspaceName: "gone",
          tabId: "nowhere",
        },
        workspaceId: "w-root",
        change: {
          kind: "chatInput",
          body: "hello",
        },
        eachTime: false,
        answerable: true,
      },
    ],
  },
  update: {
    workspaces: [
      {
        id: "w-pin",
        name: "pinned",
        path: "/src/pin",
        pinned: true,
      },
      {
        id: "w-root",
        name: "root",
        path: "/src/root",
      },
      {
        id: "w-task",
        name: "task",
        path: "/src/root-task",
        parentId: "w-root",
        git: {
          branch: "feat",
          ahead: 1,
          behind: 2,
          uncommitted: 3,
        },
      },
      {
        id: "w-gone",
        name: "gone",
        path: "/src/gone",
      },
      {
        id: "w-chatfail",
        name: "chatfail",
        path: "/src/chatfail",
      },
    ],
    sessions: [
      {
        workspaceId: "w-pin",
        tabId: "o-work",
        kind: "codex",
        title: "Codex works",
        state: "idle",
        since: 112,
        last: "Done",
      },
      {
        workspaceId: "w-pin",
        tabId: "c-limit",
        kind: "claude",
        title: "Limit",
        state: "idle",
        since: 50,
        last: "Hit the limit",
        limitWait: {
          at: 9000,
        },
      },
      {
        workspaceId: "w-pin",
        tabId: "x-codex",
        kind: "terminal",
        title: "codex",
        state: "new-result",
        agent: "codex",
        since: 1001,
        last: "Codex: Finished the task",
      },
      {
        workspaceId: "w-pin",
        tabId: "x-quiet",
        kind: "terminal",
        title: "quiet codex",
        state: "idle",
        agent: "codex",
        since: 2000,
      },
      {
        workspaceId: "w-root",
        tabId: "c-ask",
        kind: "claude",
        title: "Asks",
        openedBy: CLIPPED_OPENER,
        state: "needs-you",
        since: 10,
        last: "May I run bun test? First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word w…",
        profile: "work",
        cwd: "/src/root/sub",
        waiting: {
          kind: "permission",
          text: "Bash bun test First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word wo…",
        },
        agents: [
          {
            id: "s1",
            kind: "subagent",
            type: "Explore",
            description: "Find the loader",
            state: "running",
            start: 1,
          },
        ],
      },
      {
        workspaceId: "w-root",
        tabId: "x-perm",
        kind: "terminal",
        title: "claude",
        openedBy: TERMINAL_OPENER,
        state: "needs-you",
        agent: "claude",
        since: 5,
        last: "Allow rm?",
        waiting: {
          kind: "permission",
          text: "Bash rm -rf dist",
          requestId: "ask-1",
          always: true,
          subagent: false,
        },
        agents: [
          {
            id: "p1",
            kind: "print",
            program: "codex",
            description: "Review it",
            state: "running",
            start: 2,
          },
        ],
      },
      {
        workspaceId: "w-root",
        tabId: "c-idle",
        kind: "claude",
        title: "Idle unread",
        state: "new-result",
        since: 21,
        last: "First line of a long answer word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word w…",
      },
      {
        workspaceId: "w-root",
        tabId: "c-err",
        kind: "claude",
        title: "Failed",
        state: "idle",
        failed: true,
        since: 30,
        last: "Turn failed badly",
      },
      {
        workspaceId: "w-root",
        tabId: "x-done",
        kind: "terminal",
        title: "done",
        state: "new-result",
        agent: "claude",
        since: 81,
        last: "All done",
      },
      {
        workspaceId: "w-root",
        tabId: "x-read",
        kind: "terminal",
        title: "read",
        state: "idle",
        agent: "claude",
        since: 90,
        last: "Read it",
      },
      {
        workspaceId: "w-root",
        tabId: "x-dead",
        kind: "terminal",
        title: "dead claude",
        state: "ended",
        agent: "claude",
        since: 95,
      },
      {
        workspaceId: "w-root",
        tabId: "x-shell",
        kind: "terminal",
        title: "zsh",
        state: "idle",
      },
      {
        workspaceId: "w-task",
        tabId: "o-idle",
        kind: "codex",
        title: "Codex idle",
        state: "idle",
        since: 60,
      },
      {
        workspaceId: "w-task",
        tabId: "c-plan",
        kind: "claude",
        title: "Plan",
        state: "needs-you",
        since: 70,
        last: "Approve the plan?",
        waiting: {
          kind: "plan",
          text: "1. Do it",
        },
      },
      {
        workspaceId: "w-chatfail",
        tabId: "c-broken",
        kind: "claude",
        title: "Broken",
        state: "idle",
        since: 111,
        last: "Fixed",
      },
      {
        workspaceId: "w-chatfail",
        tabId: "x-other",
        kind: "terminal",
        title: "other",
        state: "running",
        agent: "claude",
        since: 99,
        last: "Working",
      },
    ],
    recording: {
      noteId: "n1",
      startedAt: 5,
    },
    consents: [
      {
        id: "consent-1",
        at: 100,
        expiresAt: 0,
        expiresInMs: 0,
        from: {
          workspaceId: "w-root",
          workspaceName: "root",
          tabId: "x-perm",
          name: "claude",
        },
        workspaceId: "w-pin",
        change: {
          kind: "terminalNew",
        },
        eachTime: false,
        answerable: false,
      },
      {
        id: "consent-2",
        at: 101,
        expiresAt: 0,
        expiresInMs: 0,
        from: {
          workspaceId: "w-gone",
          workspaceName: "gone",
          tabId: "nowhere",
        },
        workspaceId: "w-root",
        change: {
          kind: "chatInput",
          body: "hello",
        },
        eachTime: false,
        answerable: true,
      },
    ],
  },
};
