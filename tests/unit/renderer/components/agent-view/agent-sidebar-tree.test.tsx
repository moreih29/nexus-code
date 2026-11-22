import { expect, spyOn, test } from "bun:test";
import type { KeyboardEvent, MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StatusGroups,
  stepRows,
  WorkspaceGroups,
} from "../../../../../src/renderer/components/agent-view/agent-sidebar";
import * as iconButtons from "../../../../../src/renderer/components/ui/icon-button";
import type {
  AgentSession,
  SessionPhase,
} from "../../../../../src/renderer/services/agent-sessions/model";
import { NO_FACTS } from "../../../../../src/renderer/services/agent-sessions/rows";
import * as rowFacts from "../../../../../src/renderer/services/agent-sessions/use-row-facts";
import type { Agents } from "../../../../../src/renderer/services/agent-view/agents";
import type { AgentOrder } from "../../../../../src/renderer/services/agent-view/order";
import { RemoteResults } from "../../../../../src/renderer/services/agent-view/remote-results";
import * as agentView from "../../../../../src/renderer/state/stores/agent-view";
import { useSessionSeenStore } from "../../../../../src/renderer/state/stores/session-seen";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

function workspace(id: string, task?: WorkspaceMeta["task"]): WorkspaceMeta {
  return {
    id,
    name: id,
    rootPath: "/repo",
    location: { kind: "local", rootPath: "/repo" },
    pinned: false,
    color: "auto",
    sortOrder: 0,
    pinnedSortOrder: 0,
    tabs: [],
    ...(task ? { task } : {}),
  };
}

const home = workspace("repo");
const task = workspace("task", {
  parentId: home.id,
  branch: "feature/test",
  worktreePath: "/task",
});
const states = { attention: "needsInput", running: "running", done: "completed", idle: "idle" };

function session(
  tabId: string,
  title: string,
  phase: SessionPhase,
  fields: Partial<AgentSession> = {},
): AgentSession {
  const workspaceId = fields.workspaceId ?? home.id;
  return {
    key: `${workspaceId}:${tabId}`,
    workspaceId,
    tabId,
    title,
    kind: "codex",
    agent: "codex",
    state: states[phase],
    phase,
    estimated: false,
    since: undefined,
    message: undefined,
    prompt: undefined,
    ...fields,
  };
}

const parent = (tabId: string, name = "Saved title") => ({ kind: "tab" as const, tabId, name });
const plan = session("plan", "Release plan", "running");
const question = session("question", "Review tests", "attention", {
  workspaceId: task.id,
  parent: parent(plan.tabId),
  since: 10,
  openedAt: 1,
});
const result = session("result", "Test report", "done", { parent: parent(question.tabId) });
const deep = session("deep", "Deeper result", "running", { parent: parent(result.tabId) });
const quiet = session("quiet", "Quiet draft", "idle", { parent: parent(plan.tabId), openedAt: 2 });
const billing = session("billing", "Billing results", "done");
const notes = session("notes", "Billing notes", "done", {
  workspaceId: task.id,
  parent: parent(billing.tabId),
});
const human = session("human", "Human fork", "idle");
const closed = session("closed", "Orphan draft", "idle", { parent: parent("gone", "Old plan") });
const peer = session("peer", "Local result from peer", "idle", {
  parent: { ...parent(plan.tabId, "Peer plan"), device: { id: "other", name: "Office" } },
});
const local = [plan, question, result, deep, quiet, billing, notes, human, closed, peer];

function agents(sessions = local): Agents {
  const worktrees = [home, task].map((workspace) => ({
    workspace,
    isRoot: workspace === home,
    branch: workspace.task?.branch,
    sessions: sessions.filter((s) => s.workspaceId === workspace.id),
  }));
  return {
    families: [{ root: home, worktrees }],
    byKey: new Map(
      worktrees.flatMap(({ workspace, sessions }) =>
        sessions.map((session) => [session.key, { workspace, root: home, session }]),
      ),
    ),
  };
}

function render(view: ReactElement, folded: string[] = [], order: AgentOrder = {}): string {
  const state = agentView.useAgentViewStore.getInitialState();
  const viewStore = spyOn(agentView, "useAgentViewStore").mockImplementation((select) =>
    select({ ...state, order, folded: new Set(folded) }),
  );
  const facts = spyOn(rowFacts, "useRowFacts").mockReturnValue(NO_FACTS);
  try {
    return renderToStaticMarkup(view);
  } finally {
    viewStore.mockRestore();
    facts.mockRestore();
  }
}

function status(query = "", sessions = local) {
  return (
    <StatusGroups
      agents={agents(sessions)}
      activity={new Map()}
      query={query}
      remote={[]}
      results={new RemoteResults()}
    />
  );
}

function sections(html: string): string[] {
  return [...html.matchAll(/<section\b.*?<\/section>/g)].map(([section]) => section);
}

function rows(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]+)"[^>]*data-agent-row=""/g)].map(
    ([, title]) => title!,
  );
}

test("status counts families, shows differing glyphs and discloses idle children", () => {
  const [attention, running, done, idle] = sections(render(status()));
  expect(rows(attention ?? "")).toEqual([plan.title, question.title, result.title, deep.title]);
  expect(attention).toContain('class="tabular-nums">1</span>');
  expect(attention).toContain(">4 under it<");
  expect(attention).toContain("1 idle");
  expect(attention).toContain("↳ Test report");
  expect(attention).toContain('title="Parent · Test report"');
  expect(attention?.match(/data-testid="agent-sidebar-tree-line"/g)).toHaveLength(3);
  expect(attention?.match(/data-testid="agent-sidebar-state"/g)).toHaveLength(3);
  expect(rows(running ?? "")).toEqual([]);
  expect(rows(done ?? "")).toEqual([billing.title, notes.title]);
  expect(rows(idle ?? "")).toEqual([human.title, closed.title, peer.title]);
  expect(idle).toContain("↳ Old plan · closed");
  expect(idle).toContain("↳ Office · Peer plan");
  expect(idle).not.toContain('data-testid="agent-sidebar-tree-line"');
});

test("workspace shows relocated rows once, keeps their worktree labels and uses drag order for roots only", () => {
  const html = render(<WorkspaceGroups agents={agents()} activity={new Map()} query="" />, [], {
    [home.id]: [billing.key, result.key, plan.key],
  });
  expect(rows(html).slice(0, 7)).toEqual([
    billing.title,
    notes.title,
    plan.title,
    question.title,
    result.title,
    deep.title,
    quiet.title,
  ]);
  expect(html).toContain('draggable="true" aria-label="Release plan"');
  expect(html).toContain('draggable="false" aria-label="Review tests"');
  expect(html).toContain(">↳ 1 under Release plan<");
  expect(html).toContain(">↳ 1 under Billing results<");
  expect(html.match(/data-testid="agent-sidebar-branch"/g)).toHaveLength(2);
  expect(html).not.toContain('data-testid="agent-sidebar-idle"');
});

test("status reordering moves a root with its whole family", () => {
  const first = session("first", "First request", "attention", { since: 1 });
  const initial = render(status("", [first, ...local]));
  expect(rows(sections(initial)[0] ?? "")[0]).toBe(first.title);
  const reordered = render(status("", [first, ...local]), [], {
    "status:attention": [plan.key, first.key],
  });
  expect(rows(sections(reordered)[0] ?? "")).toEqual([
    plan.title,
    question.title,
    result.title,
    deep.title,
    first.title,
  ]);
});

test("search exposes matching children and their ancestors through both saved folds", () => {
  const folds = ["status:attention", `family:${plan.key}`];
  const folded = render(status(), folds.slice(1));
  expect(rows(sections(folded)[0] ?? "")).toEqual([plan.title]);
  const summary = sections(folded)[0]?.match(/data-testid="agent-sidebar-summary"/g);
  expect(summary).toHaveLength(3);
  const found = render(status(" quiet "), folds);
  expect(rows(found)).toEqual([plan.title, quiet.title]);
  const workspace = render(
    <WorkspaceGroups agents={agents()} activity={new Map()} query="review tests" />,
    [`workspace:${home.id}`, ...folds],
  );
  expect(rows(workspace)).toEqual([plan.title, question.title]);
});

test("mark all read includes a folded done branch and leaves results in other groups alone", () => {
  const buttons = spyOn(iconButtons, "IconButton");
  const before = useSessionSeenStore.getState().byWorkspace;
  try {
    const html = render(status(), [`family:${billing.key}`]);
    expect(rows(html)).not.toContain(notes.title);
    const props = buttons.mock.calls.find(
      ([props]) =>
        (props as { "data-testid"?: string })["data-testid"] === "agent-sidebar-mark-read",
    )?.[0];
    if (!props?.onClick) throw new Error("missing mark-all button");
    props.onClick({} as MouseEvent<HTMLButtonElement>);
    const seen = useSessionSeenStore.getState().byWorkspace;
    expect(seen[home.id]?.[billing.tabId]).toBeNumber();
    expect(seen[task.id]?.[notes.tabId]).toBeNumber();
    expect(seen[home.id]?.[result.tabId]).toBeUndefined();
  } finally {
    buttons.mockRestore();
    useSessionSeenStore.setState({ byWorkspace: before });
  }
});

test("keyboard moves through visible tree rows in order and skips folded children", () => {
  const titles = rows(render(status(), [`family:${billing.key}`]));
  expect(titles).toEqual([
    plan.title,
    question.title,
    result.title,
    deep.title,
    billing.title,
    human.title,
    closed.title,
    peer.title,
  ]);
  const buttons = titles.map((title) => ({
    title,
    matches: () => true,
    focus: spyOn({ focus() {} }, "focus"),
  }));
  const search = { focus: spyOn({ focus() {} }, "focus") };
  const keydown = (key: string, index: number) =>
    stepRows(
      {
        key,
        target: buttons[index],
        currentTarget: { querySelectorAll: () => buttons },
        preventDefault() {},
      } as unknown as KeyboardEvent<HTMLDivElement>,
      search as unknown as HTMLElement,
    );
  keydown("ArrowDown", 0);
  expect(buttons[1]?.focus).toHaveBeenCalledTimes(1);
  keydown("ArrowDown", 4);
  expect(buttons[5]?.focus).toHaveBeenCalledTimes(1);
  keydown("ArrowUp", 0);
  expect(search.focus).toHaveBeenCalledTimes(1);
});

test("old layouts keep flat status order and row appearance", () => {
  const a = session("a", "Earlier", "attention", { since: 10 });
  const b = session("b", "Later", "attention", { since: 20 });
  const html = render(status("", [b, a, human]));
  expect(rows(html)).toEqual([a.title, b.title, human.title]);
  expect(html).not.toContain('data-testid="agent-sidebar-fold-family"');
  expect(html).not.toContain('data-testid="agent-sidebar-state"');
  expect(html).not.toContain('data-testid="agent-sidebar-tree-line"');
});
