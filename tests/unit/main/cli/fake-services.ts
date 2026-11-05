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
import type { ConsoleEntry } from "../../../../src/main/features/cli/browser/console-log";
import type {
  BrowserDriver,
  PageDialog,
  PageInfo,
  RequestDetails,
} from "../../../../src/main/features/cli/browser/driver";
import type { NetworkEntry } from "../../../../src/main/features/cli/browser/network-log";
import type { PickedElement, PickResult } from "../../../../src/main/features/cli/browser/pick";
import {
  type CliContext,
  CliError,
  type CliServices,
} from "../../../../src/main/features/cli/context";
import { listedAt } from "../../../../src/main/features/cli/listed";
import { StartedAgents } from "../../../../src/main/features/cli/started-agents";
import { WaitRegistry } from "../../../../src/main/features/cli/waits";
import type { AgentRun } from "../../../../src/shared/claude/activity";
import type { ClaudeStatus } from "../../../../src/shared/claude/status";
import { parseSettingValue } from "../../../../src/shared/cli/settings";
import type {
  CliConsentAnswer,
  CliLayoutNode,
  CliPanels,
  CliProblem,
  CliSettingInfo,
  CliTabInfo,
  CliUiOp,
  CliUiOps,
} from "../../../../src/shared/cli/ui";
import type { ListeningPort, PortForward } from "../../../../src/shared/pty/ports";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../../src/shared/types/workspace";

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
/** The id of a workspace nexus workspace add makes. */
export const ADDED = "44444444-4444-4444-8444-444444444444";

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
    tab(EDITOR_TAB, "editor", "index.ts", { filePath: "/w/app/index.ts", groupId: "g2" }),
    tab(BROWSER_TAB, "browser", "Vite App", { url: "http://localhost:5173/", groupId: "g2" }),
  ],
  [API]: [tab(CODEX_TAB, "terminal", "codex", { cwd: "/w/api", groupId: "g3" })],
  [FIX]: [],
};

const group = (id: string, tabIds: string[], shownTabId: string | null = tabIds[0] ?? null) => ({
  kind: "group" as const,
  id,
  tabIds,
  shownTabId,
});

/** The editor areas: "app" split in two columns, the others one group. */
const LAYOUTS: Record<string, { root: CliLayoutNode; activeGroupId: string }> = {
  [APP]: {
    root: {
      kind: "split",
      id: "s1",
      direction: "columns",
      ratio: 0.5,
      first: group("g1", [SHELL_TAB, CLAUDE_TAB]),
      second: group("g2", [EDITOR_TAB, BROWSER_TAB]),
    },
    activeGroupId: "g1",
  },
  [API]: { root: group("g3", [CODEX_TAB]), activeGroupId: "g3" },
  [FIX]: { root: group("g4", []), activeGroupId: "g4" },
};

/** What is on disk, by workspace and path from its root. */
const FILES: Record<string, Record<string, "file" | "dir">> = {
  [APP]: { "index.ts": "file", src: "dir", "src/login.ts": "file" },
};

export interface FakeApp {
  services: CliServices;
  /** The app's workspaces; a test may add or change them. */
  workspaces: WorkspaceMeta[];
  /** What addWorkspace was asked for. */
  added: Array<{ location: WorkspaceLocation; name: string | undefined }>;
  /** This app's tabs, by workspace; a test may add or change them. */
  tabs: Record<string, CliTabInfo[]>;
  uiCalls: Array<{ op: string; args: unknown }>;
  notified: Array<{ workspaceId: string; tabId: string; title: string; body: string }>;
  claude: Map<
    string,
    { status: ClaudeStatus; message?: string; since: number; turnStartedAt?: number }
  >;
  activity: Map<string, TabActivity>;
  /** The agents of each terminal's Claude session, by "workspace:tab". */
  agents: Map<string, AgentRun[]>;
  /** The agents stop was asked of, by id; a run in `stoppable` is stopped. */
  stops: string[];
  stoppable: Set<string>;
  /** The waits on terminals listed while they run. */
  waits: WaitRegistry;
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
  /** What was asked of the browser driver, and what it answers. */
  browser: FakeBrowser;
  /** Each workspace's editor area; a test may replace one. */
  layouts: Record<string, { root: CliLayoutNode; activeGroupId: string }>;
  panels: CliPanels;
  /** What problems.list gives. */
  problems: CliProblem[];
  /** The ports each workspace's terminals listen on; an Error fails the look. */
  ports: Record<string, ListeningPort[] | Error>;
  /**
   * Each workspace's forwards. A forward set up listens at `to[port]`, or at
   * the port itself; `error` fails it instead.
   */
  forwarding: {
    forwards: Record<string, PortForward[]>;
    to: Record<number, number>;
    error?: Error;
  };
  /** The app's settings, as settings.list gives them. */
  appSettings: CliSettingInfo[];
}

/** Some of the app's settings: one only the user changes, one with many choices. */
const APP_SETTINGS: CliSettingInfo[] = [
  {
    key: "editor.fontSize",
    summary: "The editor's font size, in pixels",
    type: "integer",
    min: 8,
    max: 32,
    value: 16,
    changed: false,
  },
  {
    key: "terminal.ligatures",
    summary: "Whether the terminal joins characters into ligatures",
    type: "boolean",
    value: true,
    changed: true,
  },
  {
    key: "agentCli.crossWorkspace",
    summary: "Whether nexus may change other workspaces",
    type: "choice",
    choices: ["ask", "allow", "deny"],
    value: "ask",
    changed: false,
    readOnly: true,
  },
  {
    key: "appearance.theme",
    summary: "The color theme",
    type: "choice",
    choices: Array.from({ length: 12 }, (_, i) => (i === 0 ? "dark" : `a-long-theme-name-${i}`)),
    value: "dark",
    changed: false,
  },
];

const SETTING_DEFAULTS: Record<string, CliSettingInfo["value"]> = {
  "editor.fontSize": 16,
  "terminal.ligatures": false,
};

export interface FakeBrowser {
  calls: Array<{ op: string; tabId: string; args: unknown[] }>;
  console: ConsoleEntry[];
  /** What evaluate gives. */
  value: unknown;
  /** Whether waitFor finds its condition. */
  met: boolean;
  /** What pick gives. */
  pick: PickResult;
  /** What settle finds in place of the Vite page, when set. */
  settled?: PageInfo | null;
  /** The dialog the page shows, when set. */
  dialog?: PageDialog;
  /** The requests the page made. */
  network: NetworkEntry[];
  /** What request gives for each. */
  requests: Record<number, RequestDetails>;
}

function fakeBrowserDriver(state: FakeBrowser): BrowserDriver {
  const page = { url: "http://localhost:5173/", title: "Vite App" };
  const record = (op: string, tabId: string, ...args: unknown[]) => {
    state.calls.push({ op, tabId, args });
  };
  const acted = (text: string) => ({ ...page, text, navigated: false });
  return {
    snapshot: async (tabId, options) => {
      record("snapshot", tabId, options);
      return { ...page, text: '- button "Sign in" [ref=e1]', omitted: 0 };
    },
    click: async (tabId, target, options) => {
      record("click", tabId, target, options);
      return acted(`Clicked ${target}.`);
    },
    hover: async (tabId, target, options) => {
      record("hover", tabId, target, options);
      return acted(`Hovered over ${target}.`);
    },
    drag: async (tabId, from, to) => {
      record("drag", tabId, from, to);
      return acted(`Dragged ${from} onto ${to}.`);
    },
    scroll: async (tabId, scroll, within) => {
      record("scroll", tabId, scroll, within);
      return acted("Scrolled.");
    },
    fill: async (tabId, target, text) => {
      record("fill", tabId, target, text);
      return acted(`Filled ${target}.`);
    },
    type: async (tabId, text, target) => {
      record("type", tabId, text, target);
      return acted("Typed.");
    },
    press: async (tabId, keys) => {
      record("press", tabId, keys);
      return acted(`Pressed ${keys.join(" ")}.`);
    },
    screenshot: async (tabId, options) => {
      record("screenshot", tabId, options);
      return "cG5n";
    },
    evaluate: async (tabId, expression) => {
      record("evaluate", tabId, expression);
      return state.value;
    },
    console: (tabId, clear) => {
      record("console", tabId, clear);
      return state.console;
    },
    network: (tabId, clear) => {
      record("network", tabId, clear);
      return state.network;
    },
    request: async (tabId, id, maxBody) => {
      record("request", tabId, id, maxBody);
      const details = state.requests[id];
      if (!details) throw new CliError(`no request ${id}; nexus browser network lists them`);
      return details;
    },
    waitFor: async (tabId, condition, timeoutMs) => {
      record("waitFor", tabId, condition, timeoutMs);
      return state.met;
    },
    settle: async (tabId) => {
      record("settle", tabId);
      return state.settled === undefined ? page : state.settled;
    },
    pick: async (tabId, options) => {
      record("pick", tabId, options);
      return state.pick;
    },
    upload: async (tabId, target, files) => {
      record("upload", tabId, target, files);
      return acted(`Gave ${target} ${files.length} files.`);
    },
    dialog: async (tabId) => {
      record("dialog", tabId);
      return state.dialog ?? null;
    },
    answerDialog: async (tabId, accept) => {
      record("answerDialog", tabId, accept);
      return acted(accept ? "Answered OK." : "Answered Cancel.");
    },
    inspect: async (tabId, target) => {
      record("inspect", tabId, target);
      return { ...PICKED, ref: target.startsWith("e") ? target : PICKED.ref };
    },
  };
}

/** The element a pick gives unless a test says otherwise. */
export const PICKED: PickedElement = {
  url: "http://localhost:5173/login",
  title: "Vite App",
  tag: "button",
  role: "button",
  name: "Sign in",
  ref: "e7",
  selector: "#login > button.primary",
  inShadow: false,
  text: "Sign in",
  html: '<button class="primary" type="submit">Sign in</button>',
  box: { x: 412, y: 388, width: 120, height: 32 },
  clip: { x: 404, y: 380, width: 136, height: 48 },
  png: "cG5n",
};

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
  const agents: FakeApp["agents"] = new Map();
  const stops: string[] = [];
  const stoppable = new Set<string>();
  const screens = new Map([[CODEX_TAB, "› Summarize the API\n\n• Working (12s)"]]);
  const workspaces = [...WORKSPACES];
  const added: FakeApp["added"] = [];
  const tabs: FakeApp["tabs"] = Object.fromEntries(
    Object.entries(TABS).map(([id, list]) => [id, list.map((t) => ({ ...t }))]),
  );
  const foreground: FakeApp["foreground"] = new Map();
  const settings: FakeApp["settings"] = { crossWorkspace: "ask", agentContext: true };
  const answers: CliConsentAnswer[] = [];
  const asked: ChangeRequest[] = [];
  const time: FakeApp["time"] = { now };
  const browser: FakeBrowser = {
    calls: [],
    console: [],
    value: undefined,
    met: true,
    pick: { picked: PICKED },
    network: [],
    requests: {},
  };
  const layouts: FakeApp["layouts"] = { ...LAYOUTS };
  const panels: CliPanels = {
    sidebar: { visible: true, width: 240 },
    files: { visible: true, width: 240, mode: "tree" },
  };
  const problems: CliProblem[] = [];
  const ports: FakeApp["ports"] = {};
  const forwarding: FakeApp["forwarding"] = { forwards: {}, to: {} };
  const forward = async (workspaceId: string, port: number): Promise<PortForward> => {
    if (forwarding.error) throw forwarding.error;
    forwarding.forwards[workspaceId] ??= [];
    const list = forwarding.forwards[workspaceId];
    const found = list.find((f) => f.remotePort === port);
    if (found) return found;
    const made = { remotePort: port, localPort: forwarding.to[port] ?? port, active: true };
    list.push(made);
    return made;
  };
  const appSettings = APP_SETTINGS.map((setting) => ({ ...setting }));
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
    if (op === "terminal.shells") {
      return {
        shells: [
          { name: "zsh", kind: "detected", id: "/bin/zsh", path: "/bin/zsh", isDefault: true },
          { name: "Fish", kind: "custom", id: "fish-1", path: "fish", isDefault: false },
        ],
      } as CliUiOps[K]["result"];
    }
    // An editor saves or reverts what is unsaved in it; any other tab has no file.
    if (op === "tab.save" || op === "tab.revert") {
      const { workspaceId, tabId } = args as CliUiOps["tab.save"]["args"];
      const found = (tabs[workspaceId] ?? []).find((t) => t.id === tabId);
      if (!found?.filePath) throw new CliError("only an editor or a diff has a file to save");
      const done = found.unsaved === true;
      return (
        op === "tab.save"
          ? { filePath: found.filePath, saved: done }
          : { filePath: found.filePath, reverted: done }
      ) as CliUiOps[K]["result"];
    }
    if (op === "editor.open" || op === "diff.open" || op === "terminal.open") {
      return { tabId: NEW_TAB } as CliUiOps[K]["result"];
    }
    if (op === "commit.open") {
      return {
        tabId: NEW_TAB,
        sha: "4f2a9c1e0b7d3a5f6e8c9b0a1d2e3f4a5b6c7d8e",
        subject: "Fix the login redirect",
      } as CliUiOps[K]["result"];
    }
    // Any worktree made is "fix-login".
    if (op === "task.create") {
      const { command } = args as CliUiOps["task.create"]["args"];
      return {
        workspaceId: FIX,
        tabId: NEW_TAB,
        command: command ?? "claude",
      } as CliUiOps[K]["result"];
    }
    if (op === "browser.open") {
      const { url } = args as CliUiOps["browser.open"]["args"];
      return { tabId: NEW_TAB, url: `http://${url}/` } as CliUiOps[K]["result"];
    }
    if (op === "layout.get") {
      const { workspaceId } = args as CliUiOps["layout.get"]["args"];
      return layouts[workspaceId] as CliUiOps[K]["result"];
    }
    if (op === "layout.split") return { groupId: "g9" } as CliUiOps[K]["result"];
    if (op === "group.close") {
      const { workspaceId, groupId } = args as CliUiOps["group.close"]["args"];
      const closed = (tabs[workspaceId] ?? []).filter((t) => t.groupId === groupId).length;
      return { closed } as CliUiOps[K]["result"];
    }
    if (op === "tab.rename") {
      const { title } = args as CliUiOps["tab.rename"]["args"];
      return { title: title || "zsh" } as CliUiOps[K]["result"];
    }
    if (op === "panels.set") {
      const { panel, visible, width, mode } = args as CliUiOps["panels.set"]["args"];
      if (visible !== undefined) panels[panel].visible = visible;
      if (width !== undefined) panels[panel].width = Math.min(600, Math.max(160, width));
      if (mode !== undefined) panels.files.mode = mode;
      return panels as CliUiOps[K]["result"];
    }
    if (op === "panels.get") return panels as CliUiOps[K]["result"];
    if (op === "problems.list") return { problems } as CliUiOps[K]["result"];
    if (op === "settings.list") return { settings: appSettings } as CliUiOps[K]["result"];
    if (op === "settings.set") {
      const { key, value } = args as CliUiOps["settings.set"]["args"];
      const index = appSettings.findIndex((s) => s.key.toLowerCase() === key.toLowerCase());
      const setting = appSettings[index];
      if (!setting) throw new CliError(`no setting "${key}"; nexus settings list shows them`);
      if (setting.readOnly) {
        throw new CliError(`${setting.key} is the user's to change, in Settings`);
      }
      const parsed =
        value === null
          ? { value: SETTING_DEFAULTS[setting.key] as CliSettingInfo["value"] }
          : parseSettingValue(setting, value);
      if ("error" in parsed) throw new CliError(`${setting.key}: ${parsed.error}`);
      const next = { ...setting, value: parsed.value, changed: value !== null };
      appSettings[index] = next;
      return { setting: next } as CliUiOps[K]["result"];
    }
    if (op === "browser.navigate") {
      const { url } = args as CliUiOps["browser.navigate"]["args"];
      return (url === undefined ? {} : { url }) as CliUiOps[K]["result"];
    }
    return {} as CliUiOps[K]["result"];
  };
  const waits = new WaitRegistry();
  const services: CliServices = {
    appVersion: "1.2.3",
    listWorkspaces: () => workspaces,
    addWorkspace: async (location, name) => {
      added.push({ location, name });
      const listed = await listedAt(workspaces, location, async (path) => path);
      if (listed) return { workspace: listed, added: false };
      const rootPath = location.kind === "local" ? location.rootPath : location.remotePath;
      const made = {
        ...workspace(ADDED, name ?? rootPath.split("/").pop() ?? rootPath, rootPath),
        location,
      };
      workspaces.push(made);
      return { workspace: made, added: true };
    },
    shownTab: () => ({ workspaceId: APP, tabId: SHELL_TAB }),
    claudeStatus: (ws, t) => claude.get(`${ws}:${t}`) ?? null,
    activity: (ws, t) => activity.get(`${ws}:${t}`) ?? null,
    claudeAgents: {
      list: (ws, t) => agents.get(`${ws}:${t}`) ?? [],
      stop: async (_ws, _t, agentId) => {
        stops.push(agentId);
        return stoppable.has(agentId);
      },
    },
    waits,
    ui,
    notify: (workspaceId, tabId, title, body) => {
      notified.push({ workspaceId, tabId, title, body });
      return true;
    },
    stat: async (workspaceId, relPath) => FILES[workspaceId]?.[relPath] ?? null,
    allowChange: (request) => consent.check(request),
    agentContextEnabled: () => settings.agentContext,
    foregroundProcess: async (_workspaceId, tabId) => foreground.get(tabId) ?? null,
    listeningPorts: async (workspaceId) => {
      const found = ports[workspaceId] ?? [];
      if (found instanceof Error) throw found;
      return found;
    },
    startedAgents: new StartedAgents(),
    clock: {
      now: () => time.now,
      sleep: async (ms) => {
        time.now += ms;
        time.onTick?.(time.now);
      },
    },
    browser: fakeBrowserDriver(browser),
    forwards: {
      list: (workspaceId) => forwarding.forwards[workspaceId] ?? [],
      forward,
      stop: async (workspaceId, port) => {
        forwarding.forwards[workspaceId] = (forwarding.forwards[workspaceId] ?? []).filter(
          (f) => f.remotePort !== port,
        );
      },
      localUrl: async (workspaceId, url) => {
        const parsed = new URL(url);
        const made = await forward(workspaceId, Number(parsed.port || 80));
        parsed.port = String(made.localPort);
        return parsed.toString();
      },
    },
  };
  return {
    services,
    workspaces,
    added,
    tabs,
    uiCalls,
    notified,
    claude,
    activity,
    agents,
    stops,
    stoppable,
    waits,
    screens,
    foreground,
    settings,
    answers,
    asked,
    time,
    browser,
    layouts,
    panels,
    problems,
    ports,
    forwarding,
    appSettings,
  };
}

/** A command run from the plain shell in "app". */
export function contextFor(
  app: FakeApp,
  argv: string[],
  caller = { workspaceId: APP, tabId: SHELL_TAB },
  invocation: { cwd?: string; tempDir?: string; stdin?: string; msysRoot?: string } = {},
): CliContext {
  return {
    caller,
    invocation: { argv, cwd: "/w/app", tempDir: "/tmp", ...invocation },
    services: app.services,
  };
}
