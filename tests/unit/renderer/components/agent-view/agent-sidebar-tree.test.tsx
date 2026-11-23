import { expect, spyOn, test } from "bun:test";
import type { KeyboardEvent, MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusView } from "../../../../../src/renderer/components/agent-list/status-view";
import { TaskView } from "../../../../../src/renderer/components/agent-list/task-view";
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
  createdBy: { workspaceId: home.id, tabId: "plan" },
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
  expect(attention).toContain('aria-label="4 conversations under it"');
  expect(attention).toContain("1 idle");
  expect(attention).toContain("↳ Test report");
  expect(attention).toContain('title="Parent · Test report"');
  expect(attention?.match(/data-testid="agent-sidebar-tree-line"/g)).toHaveLength(3);
  // Each row tells its own state, the group's too.
  expect(attention?.match(/data-testid="agent-sidebar-state"/g)).toHaveLength(4);
  expect(rows(running ?? "")).toEqual([]);
  expect(rows(done ?? "")).toEqual([billing.title, notes.title]);
  expect(rows(idle ?? "")).toEqual([human.title, closed.title, peer.title]);
  expect(idle).toContain("↳ Old plan · closed");
  expect(idle).toContain("↳ Office · Peer plan");
  expect(idle).not.toContain('data-testid="agent-sidebar-tree-line"');
});

const longParent = "Release checklist for the next production deployment";
test.each([
  ["closed", { ...closed, parent: parent("gone", longParent) }, `↳ ${longParent} · closed`],
  ["open", deep, "↳ Test report"],
  ["remote", peer, "↳ Office · Peer plan"],
] as const)("the %s parent label keeps capped space next to a long result", (_kind, row, label) => {
  const preview = "The checks finished and the report includes the full list of results.";
  const sessions = local.map((session) =>
    session.key === row.key
      ? { ...row, phase: "done" as const, state: "completed", message: preview }
      : session,
  );
  const html = render(status("", sessions));
  const caption = [
    ...html.matchAll(
      /<span class="([^"]+)"[^>]*data-testid="agent-sidebar-parent">([^<]+)<\/span><\/span><span class="([^"]+)">(.*?)<\/span><\/span><\/div>/g,
    ),
  ].find((match) => match[2] === label);
  expect(caption?.[1]?.split(" ")).toEqual(expect.arrayContaining(["max-w-40", "truncate"]));
  // What it last said gives way first, and goes with less than 3em left.
  expect(caption?.[3]?.split(" ")).toEqual(expect.arrayContaining(["min-w-[3em]", "flex-1"]));
  expect(caption?.[4]).toContain(preview);
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
  expect(html.match(/data-testid="agent-sidebar-branch"/g)).toHaveLength(2);
  expect(html).not.toContain('data-testid="agent-sidebar-idle"');
});

test("a worktree holding only children has no group and no line naming their parents", () => {
  const html = render(<WorkspaceGroups agents={agents()} activity={new Map()} query="" />);
  expect(html).not.toContain(`aria-label="New agent in ${task.name}"`);
  expect(html).not.toContain("under Release plan");
  expect(html).not.toContain("under Billing results");
  expect(html).not.toContain('data-testid="agent-sidebar-moved"');
  // The worktree's conversations still show, each under its parent.
  expect(rows(html)).toEqual(expect.arrayContaining([question.title, notes.title]));
});

test("a mixed worktree's group lists only its own conversations", () => {
  const own = session("own", "Own check", "done", { workspaceId: task.id });
  const html = render(
    <WorkspaceGroups agents={agents([...local, own])} activity={new Map()} query="" />,
  );
  const group = html.split(`aria-label="New agent in ${task.name}"`)[1] ?? "";
  expect(rows(group)).toEqual([own.title]);
  expect(rows(html).filter((title) => title === question.title)).toHaveLength(1);
  expect(rows(html.split(`aria-label="New agent in ${task.name}"`)[0] ?? "")).toEqual(
    expect.arrayContaining([question.title, notes.title]),
  );
  expect(html).not.toContain("under Release plan");
});

test("a folded family tells inside its chip what of it works and waits, not its new results", () => {
  const html = render(status(), [`family:${plan.key}`]);
  const chip =
    html.match(/<button[^>]*data-testid="agent-sidebar-fold-family">.*?<\/button>/)?.[0] ?? "";
  expect(chip).toContain('aria-label="4 conversations under it · Working 1 · Needs you 1"');
  expect(chip.match(/data-testid="agent-sidebar-summary"/g)).toHaveLength(2);
  expect(chip).toContain(">4<");
  expect(chip).not.toContain("lucide-circle-check");
  // Unfolded, the chip tells only how many.
  const open = render(status());
  const openChip =
    open.match(/<button[^>]*data-testid="agent-sidebar-fold-family">.*?<\/button>/)?.[0] ?? "";
  expect(openChip).not.toContain('data-testid="agent-sidebar-summary"');
});

test("a row raised into a group by its children still tells its own state", () => {
  const idlePlan = { ...plan, state: "idle", phase: "idle" as const };
  const sessions = local.map((session) => (session.key === plan.key ? idlePlan : session));
  const [attention = ""] = sections(render(status("", sessions)));
  const row = attention.split('data-testid="agent-sidebar-item"')[1] ?? "";
  expect(row).toContain('aria-label="Release plan"');
  expect(row).toMatch(/role="img" aria-label="Idle"[^>]*data-testid="agent-sidebar-state"/);
});

test("by state, a root tells its place once and a child only a place elsewhere", () => {
  const [attention = ""] = sections(render(status()));
  const [, root = "", child = ""] = attention.split('data-testid="agent-sidebar-item"');
  expect(root).toContain('data-testid="agent-sidebar-workspace"');
  expect(child).toContain('data-testid="agent-sidebar-branch"');
  expect(child).toContain(">feature/test<");
  const workspace = render(<WorkspaceGroups agents={agents()} activity={new Map()} query="" />);
  expect(workspace).not.toContain('data-testid="agent-sidebar-workspace"');
});

test("rows that need the user tell what for: a permission, a question, a plan, or a failure", () => {
  const ask = session("ask", "Run the checks", "attention", { state: "permissionPending" });
  const asked = session("asked", "Pick a cache key", "attention", { state: "needsInput" });
  const plans = session("plans", "Roll back in steps", "attention", { state: "permissionPending" });
  const broke = session("broke", "Status test", "attention", { state: "error" });
  const working = session("working", "Release notes", "running");
  const state = agentView.useAgentViewStore.getInitialState();
  const viewStore = spyOn(agentView, "useAgentViewStore").mockImplementation((select) =>
    select({ ...state, order: {}, folded: new Set() }),
  );
  const facts = spyOn(rowFacts, "useRowFacts").mockImplementation((row) =>
    row.key === plans.key ? { ...NO_FACTS, wait: { kind: "plan", text: "Three steps" } } : NO_FACTS,
  );
  try {
    const html = renderToStaticMarkup(status("", [ask, asked, plans, broke, working]));
    const sign = (title: string) => {
      const row = html
        .split(`aria-label="${title}"`)[1]
        ?.split('data-testid="agent-sidebar-item"')[0];
      return row?.match(/<span role="img" aria-label="([^"]+)"[^>]*data-wait="([^"]+)"/)?.slice(1);
    };
    expect(sign(ask.title)).toEqual(["Permission request", "permission"]);
    expect(sign(asked.title)).toEqual(["Question", "question"]);
    expect(sign(plans.title)).toEqual(["Plan to approve", "plan"]);
    expect(html).toContain("lucide-shield");
    expect(html).toContain("lucide-message-circle-question");
    expect(html).toContain("lucide-list-todo");
    const failed = html.split(`aria-label="${broke.title}"`)[1] ?? "";
    expect(failed).toMatch(/^[\s\S]*?text-\(--state-error-fg\)">Failed<\/span>/);
    expect(sign(working.title)).toBeUndefined();
    // By workspace too.
    const byWorkspace = renderToStaticMarkup(
      <WorkspaceGroups agents={agents([ask, plans])} activity={new Map()} query="" />,
    );
    expect(byWorkspace).toContain('data-wait="permission"');
    expect(byWorkspace).toContain('data-wait="plan"');
  } finally {
    viewStore.mockRestore();
    facts.mockRestore();
  }
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
  // The folded chip tells what of the family works and waits on the user, not new results.
  const summary = sections(folded)[0]?.match(/data-testid="agent-sidebar-summary"/g);
  expect(summary).toHaveLength(2);
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
  expect(html.match(/data-testid="agent-sidebar-state"/g)).toHaveLength(3);
  expect(html).not.toContain('data-testid="agent-sidebar-tree-line"');
});

function workspaceList(view: "status" | "task", query = "", sessions = local) {
  const common = {
    family: agents(sessions).families[0]!,
    changes: new Map(),
    activity: new Map(),
    selection: null,
    onSelect: () => {},
    query,
  };
  return view === "status" ? <StatusView {...common} /> : <TaskView {...common} waits={[]} />;
}

test("local trees dim the closed conversation label when the opener has no name", () => {
  const missingId = "1a2b3c4d-missing";
  const child = {
    ...closed,
    parent: { kind: "tab" as const, agent: "codex" as const, tabId: missingId },
  };
  for (const view of [
    status("", [child]),
    workspaceList("status", "", [child]),
    workspaceList("task", "", [child]),
    <WorkspaceGroups key="sidebar" agents={agents([child])} activity={new Map()} query="" />,
  ]) {
    const html = render(view);
    expect(html).toMatch(/opacity-70"[^>]*>↳ Closed conversation<\/span>/);
    expect(html).not.toContain(missingId.slice(0, 8));
  }
  expect(rows(render(status("Closed conversation", [child])))).toEqual([]);
});

function sessionKeys(html: string): string[] {
  return [...html.matchAll(/data-session-key="([^"]+)"/g)].map(([, key]) => key!);
}

test("workspace status uses the agent view's family grouping, idle disclosure and saved family folds", () => {
  const html = render(workspaceList("status"));
  expect(sections(html).map(sessionKeys)).toEqual(sections(render(status())).map(sessionKeys));
  expect(sections(html)[0]).toContain('class="tabular-nums">1</span>');
  expect(html).toContain('data-testid="agent-list-idle"');
  expect(html).toContain("↳ Test report");
  const folded = render(workspaceList("status"), [`family:${plan.key}`]);
  expect(sessionKeys(sections(folded)[0] ?? "")).toEqual([plan.key]);
  expect(sections(folded)[0]?.match(/data-testid="agent-list-summary"/g)).toHaveLength(2);
  const match = render(workspaceList("status", "quiet"), [`family:${plan.key}`]);
  expect(sessionKeys(match)).toEqual([plan.key, quiet.key]);
});

test("workspace tasks show moved conversations once under their parent and keep creator and task rows", () => {
  const views = <WorkspaceGroups agents={agents()} activity={new Map()} query="" />;
  const html = render(workspaceList("task"));
  expect(sessionKeys(html)).toEqual(sessionKeys(render(views)));
  // The task's card stays for its actions; its conversations run under their parents.
  expect(html).toContain('aria-label="feature/test"');
  expect(html).not.toContain("under Release plan");
  expect(html).not.toContain("No conversations");
  expect(html).toContain('title="feature/test"');
  expect(html).toContain('title="Made by the conversation Release plan"');
  expect(html).not.toContain('data-testid="agent-list-idle"');
  expect(sessionKeys(render(workspaceList("task", "Review tests")))).toEqual([
    plan.key,
    question.key,
  ]);
  expect(render(workspaceList("task", "feature/test"))).toContain('aria-label="feature/test"');
});
