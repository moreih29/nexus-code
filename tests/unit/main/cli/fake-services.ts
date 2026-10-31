/**
 * A made-up app for the nexus CLI's tests: two workspaces, one with a
 * worktree, and terminals running Claude Code, Codex and a plain shell.
 */

import type { TabActivity } from "../../../../src/main/features/cli/activity";
import {
  type ChangeRequest,
  CrossWorkspaceConsent,
  type CrossWorkspacePolicy,
} from "../../../../src/main/features/cli/consent";
import type { CliContext, CliServices } from "../../../../src/main/features/cli/context";
import type { ClaudeStatus } from "../../../../src/shared/claude/status";
import type {
  CliConsentAnswer,
  CliTabInfo,
  CliUiOp,
  CliUiOps,
} from "../../../../src/shared/cli/ui";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

export const APP = "11111111-1111-4111-8111-111111111111";
export const API = "22222222-2222-4222-8222-222222222222";
export const FIX = "33333333-3333-4333-8333-333333333333";

export const SHELL_TAB = "aaaaaaaa-0000-4000-8000-000000000001";
export const CLAUDE_TAB = "aaaaaaaa-0000-4000-8000-000000000002";
export const CODEX_TAB = "bbbbbbbb-0000-4000-8000-000000000003";
export const EDITOR_TAB = "aaaaaaaa-0000-4000-8000-000000000004";
export const BROWSER_TAB = "aaaaaaaa-0000-4000-8000-000000000005";
/** The id of any tab a command opens. */
export const NEW_TAB = "cccccccc-0000-4000-8000-000000000006";

function workspace(
  id: string,
  name: string,
  rootPath: string,
  extra: Partial<WorkspaceMeta> = {},
): WorkspaceMeta {
  return {
    id,
    name,
    location: { kind: "local", rootPath },
    rootPath,
    colorTone: "default",
    pinned: false,
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
    ...extra,
  } as WorkspaceMeta;
}

export const WORKSPACES: WorkspaceMeta[] = [
  workspace(APP, "app", "/w/app"),
  workspace(API, "api", "/w/api"),
  workspace(FIX, "fix-login", "/home/u/.nexus-code/worktrees/app/fix-login", {
    task: {
      parentId: APP,
      branch: "fix-login",
      worktreePath: "/home/u/.nexus-code/worktrees/app/fix-login",
    },
  }),
];

const tab = (
  id: string,
  type: string,
  title: string,
  extra: Partial<CliTabInfo> = {},
): CliTabInfo => ({
  id,
  type,
  title,
  groupId: "g1",
  shown: false,
  ...extra,
});

export const TABS: Record<string, CliTabInfo[]> = {
  [APP]: [
    tab(SHELL_TAB, "terminal", "zsh", { cwd: "/w/app", shown: true }),
    tab(CLAUDE_TAB, "terminal", "✳ Claude Code", { cwd: "/w/app" }),
    tab(EDITOR_TAB, "editor", "index.ts", { filePath: "/w/app/index.ts" }),
    tab(BROWSER_TAB, "browser", "Vite App", { url: "http://localhost:5173/" }),
  ],
  [API]: [tab(CODEX_TAB, "terminal", "codex", { cwd: "/w/api" })],
  [FIX]: [],
};

/** What is on disk, by workspace and path from its root. */
const FILES: Record<string, Record<string, "file" | "dir">> = {
  [APP]: { "index.ts": "file", src: "dir", "src/login.ts": "file" },
};

export interface FakeApp {
  services: CliServices;
  /** This app's tabs, by workspace; a test may add or change them. */
  tabs: Record<string, CliTabInfo[]>;
  uiCalls: Array<{ op: string; args: unknown }>;
  notified: Array<{ workspaceId: string; tabId: string; title: string; body: string }>;
  claude: Map<string, { status: ClaudeStatus; message?: string; since: number }>;
  activity: Map<string, TabActivity>;
  screens: Map<string, string>;
  /** The foreground program of each terminal, by tab id; unknown when absent. */
  foreground: Map<string, string>;
  /** The Agent CLI settings. */
  settings: { crossWorkspace: CrossWorkspacePolicy; agentContext: boolean };
  /** The answers the user gives to consent prompts, in turn; "deny" when none is left. */
  answers: CliConsentAnswer[];
  /** The consent prompts shown. */
  asked: ChangeRequest[];
  /** Virtual time: sleeping advances it and then runs `onTick`. */
  time: { now: number; onTick?: (now: number) => void };
}

export function fakeApp(now = Date.now()): FakeApp {
  const uiCalls: FakeApp["uiCalls"] = [];
  const notified: FakeApp["notified"] = [];
  const claude: FakeApp["claude"] = new Map([
    [
      `${APP}:${CLAUDE_TAB}`,
      { status: "completed", message: "Fixed the login bug.", since: now - 30_000 },
    ],
  ]);
  const activity: FakeApp["activity"] = new Map([
    [
      `${API}:${CODEX_TAB}`,
      { lastOutputAt: now - 500, lastNotice: { body: "Agent turn complete", at: now - 120_000 } },
    ],
    [`${APP}:${SHELL_TAB}`, { lastOutputAt: now - 60_000 }],
  ]);
  const screens = new Map([[CODEX_TAB, "› Summarize the API\n\n• Working (12s)"]]);
  const tabs: FakeApp["tabs"] = Object.fromEntries(
    Object.entries(TABS).map(([id, list]) => [id, list.map((t) => ({ ...t }))]),
  );
  const foreground: FakeApp["foreground"] = new Map();
  const settings: FakeApp["settings"] = { crossWorkspace: "ask", agentContext: true };
  const answers: CliConsentAnswer[] = [];
  const asked: ChangeRequest[] = [];
  const time: FakeApp["time"] = { now };
  const consent = new CrossWorkspaceConsent({
    policy: () => settings.crossWorkspace,
    ask: async (request) => {
      asked.push(request);
      return answers.shift() ?? "deny";
    },
  });
  const ui = async <K extends CliUiOp>(op: K, args: CliUiOps[K]["args"]) => {
    uiCalls.push({ op, args });
    if (op === "tabs.list") {
      const { workspaceId } = args as CliUiOps["tabs.list"]["args"];
      return { tabs: tabs[workspaceId] ?? [] } as CliUiOps[K]["result"];
    }
    if (op === "terminal.read") {
      const { tabId, lines } = args as CliUiOps["terminal.read"]["args"];
      const text = (screens.get(tabId) ?? "").split("\n").slice(-lines).join("\n");
      return { text } as CliUiOps[K]["result"];
    }
    if (op === "editor.open" || op === "diff.open" || op === "terminal.open") {
      return { tabId: NEW_TAB } as CliUiOps[K]["result"];
    }
    if (op === "browser.open") {
      const { url } = args as CliUiOps["browser.open"]["args"];
      return { tabId: NEW_TAB, url: `http://${url}/` } as CliUiOps[K]["result"];
    }
    if (op === "browser.navigate") {
      const { url } = args as CliUiOps["browser.navigate"]["args"];
      return (url === undefined ? {} : { url }) as CliUiOps[K]["result"];
    }
    return {} as CliUiOps[K]["result"];
  };
  const services: CliServices = {
    appVersion: "1.2.3",
    listWorkspaces: () => WORKSPACES,
    shownTab: () => ({ workspaceId: APP, tabId: SHELL_TAB }),
    claudeStatus: (ws, t) => claude.get(`${ws}:${t}`) ?? null,
    activity: (ws, t) => activity.get(`${ws}:${t}`) ?? null,
    ui,
    notify: (workspaceId, tabId, title, body) => {
      notified.push({ workspaceId, tabId, title, body });
      return true;
    },
    stat: async (workspaceId, relPath) => FILES[workspaceId]?.[relPath] ?? null,
    allowChange: (request) => consent.check(request),
    agentContextEnabled: () => settings.agentContext,
    foregroundProcess: async (_workspaceId, tabId) => foreground.get(tabId) ?? null,
    clock: {
      now: () => time.now,
      sleep: async (ms) => {
        time.now += ms;
        time.onTick?.(time.now);
      },
    },
  };
  return {
    services,
    tabs,
    uiCalls,
    notified,
    claude,
    activity,
    screens,
    foreground,
    settings,
    answers,
    asked,
    time,
  };
}

/** A command run from the plain shell in "app". */
export function contextFor(
  app: FakeApp,
  argv: string[],
  caller = { workspaceId: APP, tabId: SHELL_TAB },
  invocation: { cwd?: string; stdin?: string } = {},
): CliContext {
  return {
    caller,
    invocation: { argv, cwd: "/w/app", tempDir: "/tmp", ...invocation },
    services: app.services,
  };
}
