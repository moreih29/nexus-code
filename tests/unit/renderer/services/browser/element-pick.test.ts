/**
 * Where a browser tab's pick button sends the picked element: the live agent
 * sessions of the tab's own workspace, and the text as the terminal's prompt
 * takes it with and without bracketed paste.
 */
import { describe, expect, it } from "bun:test";
import {
  pasteForTerminal,
  pickTargets,
} from "../../../../../src/renderer/services/browser/element-pick";
import type { FamilyInput } from "../../../../../src/renderer/services/sessions/model";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";
import type { StatusEntry } from "../../../../../src/shared/claude/status";
import type { TabActivity } from "../../../../../src/shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const ROOT = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000002";

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
    now: 100_000,
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

  it("lists a task's sessions when the tab is in the task", () => {
    const targets = pickTargets(
      input({
        workspaceId: TASK,
        tabsByWorkspace: {
          [ROOT]: { a: terminal("a", "claude") },
          [TASK]: { d: terminal("d", "x") },
        },
        claudeByWorkspace: { [ROOT]: { a: claude("idle") }, [TASK]: { d: claude("running") } },
      }),
    );
    expect(targets.map((s) => s.tabId)).toEqual(["d"]);
  });

  it("is empty for an unknown workspace", () => {
    expect(pickTargets(input({ workspaceId: "nope" }))).toEqual([]);
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
});
