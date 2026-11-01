/**
 * The title bar's inbox: the sessions of every workspace waiting on the
 * user, permissions first, longest waiting first, then the ones done and
 * not looked at since; and stepping through them.
 */
import { describe, expect, it } from "bun:test";
import {
  buildInbox,
  type InboxInput,
  isUnread,
  nextInboxItem,
  sameInbox,
} from "../../../../../src/renderer/services/sessions/inbox";
import {
  activityByKey,
  sameActivity,
  sessionKey,
} from "../../../../../src/renderer/services/sessions/model";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";
import type { StatusEntry } from "../../../../../src/shared/claude/status";
import type { TabActivity } from "../../../../../src/shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const APP = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000002";
const NOW = 100_000;

function workspace(id: string, task?: WorkspaceMeta["task"]): WorkspaceMeta {
  return {
    id,
    name: id === APP ? "app" : "fix-login",
    location: { kind: "local", rootPath: `/w/${id}` },
    rootPath: `/w/${id}`,
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date(0).toISOString(),
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
    ...(task ? { task } : {}),
  } as WorkspaceMeta;
}

function terminal(id: string, title = "zsh"): Tab {
  return {
    id,
    type: "terminal",
    title,
    defaultTitle: title,
    isPreview: false,
    isPinned: false,
    props: { cwd: "/" },
  } as Tab;
}

function claude(status: StatusEntry["status"], since: number): StatusEntry {
  return { workspaceId: "", tabId: "", status, since } as StatusEntry;
}

const workspaces = [
  workspace(APP),
  workspace(TASK, { parentId: APP, branch: "task/fix-login", worktreePath: "/w/t" }),
];

/**
 * app: a1 waits on a permission since 3_000, a2 asks a question since 1_000,
 * a3 finished at 2_000, a4 runs. fix-login: t1 errored at 4_000, t2 is
 * Codex, which notified at 5_000 and has been quiet since.
 */
function input(overrides: Partial<InboxInput> = {}): InboxInput {
  return {
    workspaces,
    tabsByWorkspace: {
      [APP]: { a1: terminal("a1"), a2: terminal("a2"), a3: terminal("a3"), a4: terminal("a4") },
      [TASK]: { t1: terminal("t1"), t2: terminal("t2", "codex") },
    },
    claudeByWorkspace: {
      [APP]: {
        a1: claude("permissionPending", 3_000),
        a2: claude("needsInput", 1_000),
        a3: claude("completed", 2_000),
        a4: claude("running", 500),
      },
      [TASK]: { t1: claude("error", 4_000) },
    },
    activity: new Map<string, TabActivity>([
      [
        sessionKey(TASK, "t2"),
        { lastOutputAt: 5_500, lastNotice: { body: "Done", at: 5_000 }, program: "codex" },
      ],
    ]),
    now: NOW,
    seenByWorkspace: {},
    viewing: null,
    ...overrides,
  };
}

function tabsOf(inputOverrides: Partial<InboxInput> = {}): string[] {
  return buildInbox(input(inputOverrides)).items.map((item) => item.session.tabId);
}

describe("buildInbox", () => {
  it("lists permissions, errors, then questions, then the done ones, oldest first", () => {
    expect(tabsOf()).toEqual(["a1", "t1", "a2", "a3", "t2"]);
  });

  it("counts those waiting on the user apart from the unread done ones", () => {
    const inbox = buildInbox(input());
    expect(inbox.attention).toBe(3);
    expect(inbox.unread).toBe(2);
  });

  it("reads the workspace and the agent of each", () => {
    const items = buildInbox(input()).items;
    const codex = items.find((item) => item.session.tabId === "t2");
    expect(codex?.workspace.id).toBe(TASK);
    expect(codex?.session.agent).toBe("codex");
    expect(codex?.session.estimated).toBe(true);
  });

  it("drops a done session once its terminal was looked at after it finished", () => {
    expect(tabsOf({ seenByWorkspace: { [APP]: { a3: 2_500 }, [TASK]: { t2: 6_000 } } })).toEqual([
      "a1",
      "t1",
      "a2",
    ]);
  });

  it("keeps a done session that finished after its terminal was last looked at", () => {
    expect(tabsOf({ seenByWorkspace: { [APP]: { a3: 1_500 }, [TASK]: { t2: 4_000 } } })).toEqual([
      "a1",
      "t1",
      "a2",
      "a3",
      "t2",
    ]);
  });

  it("never drops a session waiting on the user, seen or in front of them", () => {
    const tabs = tabsOf({
      seenByWorkspace: { [APP]: { a1: 9_000, a2: 9_000 }, [TASK]: { t1: 9_000 } },
      viewing: sessionKey(APP, "a1"),
    });
    expect(tabs).toEqual(["a1", "t1", "a2", "a3", "t2"]);
  });

  it("leaves out the done session in front of the user", () => {
    expect(tabsOf({ viewing: sessionKey(APP, "a3") })).toEqual(["a1", "t1", "a2", "t2"]);
  });

  it("leaves out a Codex turn still printing", () => {
    const activity = new Map<string, TabActivity>([
      [
        sessionKey(TASK, "t2"),
        { lastOutputAt: NOW - 500, lastNotice: { body: "Done", at: 5_000 }, program: "codex" },
      ],
    ]);
    expect(tabsOf({ activity })).toEqual(["a1", "t1", "a2", "a3"]);
  });

  it("is empty with nothing waiting", () => {
    const inbox = buildInbox(input({ claudeByWorkspace: {}, activity: new Map() }));
    expect(inbox).toEqual({ items: [], attention: 0, unread: 0 });
  });
});

describe("isUnread", () => {
  const done = buildInbox(input()).items.find((item) => item.session.tabId === "a3");
  if (!done) throw new Error("a3 should be in the inbox");

  it("is unread when never looked at, or looked at before it finished", () => {
    expect(isUnread(done.session, undefined)).toBe(true);
    expect(isUnread(done.session, 1_999)).toBe(true);
  });

  it("is read when looked at when or after it finished", () => {
    expect(isUnread(done.session, 2_000)).toBe(false);
    expect(isUnread(done.session, 3_000)).toBe(false);
  });
});

describe("sameInbox", () => {
  it("holds for a rebuild from the same records, at a later time", () => {
    expect(sameInbox(buildInbox(input()), buildInbox(input({ now: NOW + 60_000 })))).toBe(true);
  });

  it("fails once a session moved on or another came in", () => {
    const before = buildInbox(input());
    const answered = input().claudeByWorkspace[APP];
    expect(
      sameInbox(
        before,
        buildInbox(
          input({
            claudeByWorkspace: {
              ...input().claudeByWorkspace,
              [APP]: { ...answered, a2: claude("running", 6_000) },
            },
          }),
        ),
      ),
    ).toBe(false);
    expect(sameInbox(before, buildInbox(input({ viewing: sessionKey(APP, "a3") })))).toBe(false);
    expect(
      sameInbox(
        before,
        buildInbox(
          input({
            claudeByWorkspace: { [APP]: { ...answered, a1: claude("permissionPending", 3_100) } },
          }),
        ),
      ),
    ).toBe(false);
  });
});

describe("sameActivity", () => {
  const entry = (lastOutputAt: number, at = 5_000) => ({
    workspaceId: TASK,
    tabId: "t2",
    lastOutputAt,
    lastNotice: { body: "Done", at },
    program: "codex",
  });

  it("holds for two reads that tell the same", () => {
    expect(sameActivity(activityByKey([entry(5_500)]), activityByKey([entry(5_500)]))).toBe(true);
    expect(sameActivity(new Map(), activityByKey([]))).toBe(true);
  });

  it("fails on new output, a new notice, or a terminal come or gone", () => {
    const before = activityByKey([entry(5_500)]);
    expect(sameActivity(before, activityByKey([entry(6_000)]))).toBe(false);
    expect(sameActivity(before, activityByKey([entry(5_500, 5_400)]))).toBe(false);
    expect(sameActivity(before, new Map())).toBe(false);
    expect(sameActivity(new Map(), before)).toBe(false);
  });
});

describe("nextInboxItem", () => {
  const items = buildInbox(input()).items;
  const next = (current: string | null) => nextInboxItem(items, current)?.session.tabId;

  it("starts with the first from a terminal not in the inbox", () => {
    expect(next(null)).toBe("a1");
    expect(next(sessionKey(APP, "a4"))).toBe("a1");
  });

  it("steps to the one after the terminal in front of the user, and wraps", () => {
    expect(next(sessionKey(APP, "a1"))).toBe("t1");
    expect(next(sessionKey(TASK, "t1"))).toBe("a2");
    expect(next(sessionKey(TASK, "t2"))).toBe("a1");
  });

  it("is nothing with nothing waiting", () => {
    expect(nextInboxItem([], null)).toBeUndefined();
  });
});
