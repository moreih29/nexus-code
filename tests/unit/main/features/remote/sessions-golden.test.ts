/**
 * The sessions' list another device is sent, pinned for one fixed state of
 * the app: how the renderer is read may change, what goes over the network
 * may not.
 */
import { afterEach, expect, test } from "bun:test";
import type { SessionsUpdate } from "../../../../../packages/remote-protocol/src";
import type { CliServices, PendingConsent } from "../../../../../src/main/features/cli/context";
import { snapshotSessions } from "../../../../../src/main/features/remote/serving/sessions";
import { SessionWatches } from "../../../../../src/main/features/remote/session-watches";
import type { AgentRun } from "../../../../../src/shared/claude/activity";

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

type Tab = { id: string; type: string; title: string; dead?: true; unstarted?: true };

/** Each workspace's tabs as the renderer lists them for the remote list (agent order). */
const TABS: Record<string, Tab[]> = {
  "w-root": [
    { id: "c-ask", type: "claude", title: "Asks" },
    { id: "x-perm", type: "terminal", title: "claude" },
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
    { id: "o-idle", type: "codex", title: "Codex idle" },
    { id: "c-plan", type: "claude", title: "Plan" },
  ],
  "w-chatfail": [
    { id: "c-broken", type: "claude", title: "Broken" },
    { id: "x-other", type: "terminal", title: "other" },
  ],
};

/** Each chat as chat.state (peek, includeWaitingId) tells it. */
const CHATS: Record<string, Record<string, unknown>> = {
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

/** The renderer's answers, request by request, as the app was before batching. */
async function rendererUi(op: string, args: Record<string, unknown>): Promise<unknown> {
  if (op === "sessions.results") return { unread: UNREAD };
  if (op === "tabs.list") {
    const tabs = TABS[args.workspaceId as string];
    if (!tabs) throw new Error("not open");
    return { tabs: tabs.map((tab) => ({ ...tab, groupId: "g", shown: false })) };
  }
  if (op === "chat.state") {
    if (args.tabId === "c-broken") throw new Error("that tab is gone");
    const info = CHATS[args.tabId as string];
    if (!info) throw new Error(`no chat ${String(args.tabId)}`);
    if (args.includeWaitingId) return info;
    const { waitingId: _, ...rest } = info;
    return rest;
  }
  throw new Error(`unexpected ${op}`);
}

function services(ui = rendererUi): CliServices {
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
    ui,
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

test("the sessions' list, its consents and its waiting requests stay as they were", async () => {
  const s = services();
  const plain = await snapshotSessions(s, GIT, NOTES, "sessions.list", "phone");
  const waiting = await snapshotSessions(s, GIT, NOTES, "sessions.watch", undefined, true);
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
  let ui = rendererUi;
  const s = { ...services(), ui: (op: string, args: Record<string, unknown>) => ui(op, args) };
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
  ui = async (op, args) => {
    if (op === "tabs.list" && args.workspaceId === "w-gone") return { tabs: [] };
    if (op === "chat.state" && args.tabId === "c-broken") {
      return { agent: "claude", state: "idle", message: "Fixed", since: 111 };
    }
    if (op === "chat.state" && args.tabId === "o-work") {
      return { agent: "codex", state: "idle", message: "Done", since: 112 };
    }
    return rendererUi(op, args);
  };
  await watches.poll();
  await watches.poll();
  expect(sent).toHaveLength(1);
  const { watchId: _first, ...firstList } = first;
  const { watchId: _sent, ...update } = sent[0] as SessionsUpdate;
  expect(steady({ first: firstList, update })).toEqual(EXPECTED_WATCH);
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
