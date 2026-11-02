/**
 * Where a browser tab's pick button sends the picked element: the live agent
 * sessions of the tab's own workspace, how the menu tells them apart, and
 * the text as the terminal's prompt takes it with and without bracketed
 * paste.
 */
import { describe, expect, it } from "bun:test";
import {
  pasteForTerminal,
  pickTargets,
  targetLabels,
} from "../../../../../src/renderer/services/browser/element-pick";
import type {
  AgentSession,
  FamilyInput,
} from "../../../../../src/renderer/services/sessions/model";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";
import type { StatusEntry } from "../../../../../src/shared/claude/status";
import type { TabActivity } from "../../../../../src/shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const ROOT = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000002";
const NOW = 100_000;

function workspace(id: string, task?: WorkspaceMeta["task"]): WorkspaceMeta {
  return {
    id,
    name: id === ROOT ? "app" : "fix-login",
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

function terminal(id: string, title: string, dead = false): Tab {
  return {
    id,
    type: "terminal",
    title,
    defaultTitle: title,
    isPreview: false,
    isPinned: false,
    props: { cwd: "/", ...(dead ? { dead } : {}) },
  } as Tab;
}

function claude(status: StatusEntry["status"]): StatusEntry {
  return { workspaceId: "", tabId: "", status, since: 1_000 } as StatusEntry;
}

function activity(program: string | undefined, notice = false): TabActivity {
  return {
    lastOutputAt: NOW - 60_000,
    ...(program ? { program } : {}),
    ...(notice ? { lastNotice: { at: NOW - 60_000, title: "", body: "done" } } : {}),
  } as TabActivity;
}

function input(overrides: Partial<FamilyInput> = {}): FamilyInput {
  return {
    workspaces: [
      workspace(ROOT),
      workspace(TASK, { parentId: ROOT, branch: "task/fix-login", worktreePath: "/w/t" }),
    ],
    workspaceId: ROOT,
    tabsByWorkspace: {},
    claudeByWorkspace: {},
    activity: new Map<string, TabActivity>(),
    now: NOW,
    ...overrides,
  };
}

describe("pickTargets", () => {
  it("lists the live agent sessions of the tab's own workspace only", () => {
    const targets = pickTargets(
      input({
        tabsByWorkspace: {
          [ROOT]: {
            a: terminal("a", "claude"),
            b: terminal("b", "zsh"),
            c: terminal("c", "claude old", true),
          },
          [TASK]: { d: terminal("d", "claude task") },
        },
        claudeByWorkspace: {
          [ROOT]: { a: claude("idle"), c: claude("completed") },
          [TASK]: { d: claude("running") },
        },
      }),
    );
    expect(targets.map((s) => s.tabId)).toEqual(["a"]);
  });

  it("takes an agent from Claude's hooks or the foreground program, not a title or a notice", () => {
    const targets = pickTargets(
      input({
        tabsByWorkspace: {
          [ROOT]: {
            hooks: terminal("hooks", "zsh"),
            codex: terminal("codex", "fix the login form"),
            folder: terminal("folder", "zsh ~/src/claude-proxy"),
            exited: terminal("exited", "codex"),
            notifier: terminal("notifier", "make"),
          },
        },
        claudeByWorkspace: { [ROOT]: { hooks: claude("idle") } },
        activity: new Map([
          [`${ROOT}:codex`, activity("codex")],
          [`${ROOT}:folder`, activity("zsh")],
          [`${ROOT}:exited`, activity("zsh")],
          [`${ROOT}:notifier`, activity("make", true)],
        ]),
      }),
    );
    expect(targets.map((s) => s.tabId)).toEqual(["hooks", "codex"]);
  });

  it("is empty for an unknown workspace", () => {
    expect(pickTargets(input({ workspaceId: "nope" }))).toEqual([]);
  });
});

describe("targetLabels", () => {
  function session(key: string, title: string, extra: Partial<AgentSession> = {}): AgentSession {
    return {
      key,
      workspaceId: ROOT,
      tabId: key,
      title,
      agent: "claude",
      state: "idle",
      phase: "idle",
      estimated: false,
      since: undefined,
      message: undefined,
      prompt: undefined,
      ...extra,
    };
  }

  it("tells sessions apart by their agent and last prompt, and numbers rows still alike", () => {
    const labels = targetLabels([
      session("a", "claude", { prompt: "fix the  login\nform" }),
      session("b", "claude"),
      session("c", "claude"),
      session("d", "build", { agent: "codex", message: "x".repeat(60) }),
    ]);
    expect(labels).toEqual([
      { key: "a", title: "claude", detail: "fix the login form" },
      { key: "b", title: "claude (1)", detail: "" },
      { key: "c", title: "claude (2)", detail: "" },
      { key: "d", title: "build", detail: `codex · ${"x".repeat(39)}…` },
    ]);
  });
});

describe("pasteForTerminal", () => {
  const text =
    '[element in browser tab 7c8a] http://x/\n  button "Sign in" (ref e7)\n  selector: #go';

  it("keeps the lines and ends below them with bracketed paste", () => {
    expect(pasteForTerminal(text, true)).toBe(`${text}\n`);
  });

  it("joins the lines without it, so no line break acts as Enter", () => {
    const pasted = pasteForTerminal(text, false);
    expect(pasted).toBe(
      '[element in browser tab 7c8a] http://x/ | button "Sign in" (ref e7) | selector: #go ',
    );
    expect(pasted).not.toMatch(/[\r\n]/);
  });

  it("drops what could end the paste early or press keys", () => {
    const hostile = 'html: <b title="\u001b[201~rm -rf ~\r">\u0003\u0015x\u009b2J\ty</b>';
    expect(pasteForTerminal(hostile, true)).toBe('html: <b title="[201~rm -rf ~">x2J\ty</b>\n');
    expect(pasteForTerminal(hostile, false)).toBe('html: <b title="[201~rm -rf ~">x2J y</b> ');
  });
});
