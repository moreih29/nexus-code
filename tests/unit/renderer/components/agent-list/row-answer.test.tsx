import { afterEach, expect, spyOn, test } from "bun:test";
import { act, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RowAnswer } from "../../../../../src/renderer/components/agent-list/row-answer";
import { StatusView } from "../../../../../src/renderer/components/agent-list/status-view";
import {
  StatusGroups,
  WorkspaceGroups,
} from "../../../../../src/renderer/components/agent-view/agent-sidebar";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { useAnsweredAsksStore } from "../../../../../src/renderer/services/agent-sessions/answered-asks";
import type {
  AgentSession,
  SessionFamily,
} from "../../../../../src/renderer/services/agent-sessions/model";
import { NO_FACTS } from "../../../../../src/renderer/services/agent-sessions/rows";
import * as rowFacts from "../../../../../src/renderer/services/agent-sessions/use-row-facts";
import type { Agents } from "../../../../../src/renderer/services/agent-view/agents";
import { RemoteResults } from "../../../../../src/renderer/services/agent-view/remote-results";
import * as shown from "../../../../../src/renderer/services/agent-view/show";
import * as claudeController from "../../../../../src/renderer/services/chat/claude/controller";
import * as codexController from "../../../../../src/renderer/services/chat/codex/controller";
import type { PermissionRequest } from "../../../../../src/renderer/services/chat/model";
import * as agentView from "../../../../../src/renderer/state/stores/agent-view";
import type { PermissionAsk, SessionActivity } from "../../../../../src/shared/claude/activity";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";
import { withTestDom } from "../../../../helpers/test-dom";

const home: WorkspaceMeta = {
  id: "repo",
  name: "repo",
  rootPath: "/repo",
  location: { kind: "local", rootPath: "/repo" },
  pinned: false,
  color: "auto",
  sortOrder: 0,
  pinnedSortOrder: 0,
  tabs: [],
};

function session(fields: Partial<AgentSession> & Pick<AgentSession, "tabId">): AgentSession {
  return {
    key: `${home.id}:${fields.tabId}`,
    workspaceId: home.id,
    title: fields.tabId,
    kind: "terminal",
    agent: "claude",
    state: "permissionPending",
    phase: "attention",
    estimated: false,
    since: undefined,
    message: undefined,
    prompt: undefined,
    ...fields,
  };
}

const ask: PermissionAsk = { id: "ask-1", tool: "Bash", target: "npm test", always: [], since: 1 };

function activity(target: AgentSession, asks: PermissionAsk[] = [ask]): SessionActivity {
  return {
    workspaceId: target.workspaceId,
    tabId: target.tabId,
    tools: [],
    toolCount: 0,
    failedCount: 0,
    files: [],
    todos: [],
    agents: [],
    asks,
  };
}

function request(toolName: string): PermissionRequest {
  return { requestId: `req-${toolName}`, toolName, input: {}, suggestions: [] };
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  useAnsweredAsksStore.setState({ keys: new Set() });
});

function quietStores() {
  const state = agentView.useAgentViewStore.getInitialState();
  const view = spyOn(agentView, "useAgentViewStore").mockImplementation(((
    select: (s: typeof state) => unknown,
  ) => select(state)) as never);
  const facts = spyOn(rowFacts, "useRowFacts").mockReturnValue(NO_FACTS);
  restores.push(
    () => view.mockRestore(),
    () => facts.mockRestore(),
  );
}

function chatController(answer: (request: PermissionRequest) => Promise<void>) {
  const controller = { answerPermission: answer };
  const claude = spyOn(claudeController, "existingChatController").mockReturnValue(
    controller as never,
  );
  const codex = spyOn(codexController, "existingCodexController").mockReturnValue(
    controller as never,
  );
  restores.push(
    () => claude.mockRestore(),
    () => codex.mockRestore(),
  );
}

function firstPermission(read: () => PermissionRequest | undefined) {
  const first = spyOn(rowFacts, "useFirstPermission").mockImplementation(() => read());
  restores.push(() => first.mockRestore());
}

function agentsOf(sessions: AgentSession[]): Agents {
  return {
    families: [{ root: home, worktrees: [{ workspace: home, isRoot: true, sessions }] }],
    byKey: new Map(
      sessions.map((each) => [each.key, { workspace: home, root: home, session: each }]),
    ),
  };
}

function sidebar(sessions: AgentSession[], runs: SessionActivity[]): ReactElement {
  return (
    <StatusGroups
      agents={agentsOf(sessions)}
      activity={new Map(runs.map((run) => [`${run.workspaceId}:${run.tabId}`, run]))}
      query=""
      remote={[]}
      results={new RemoteResults()}
    />
  );
}

test("a terminal Claude's pending ask offers deny and allow, and nothing once no ask waits", () => {
  const terminal = session({ tabId: "term" });
  const html = renderToStaticMarkup(<RowAnswer session={terminal} activity={activity(terminal)} />);
  expect(html).toContain('data-testid="agent-row-answer-deny"');
  expect(html).toContain('aria-label="Deny"');
  expect(html).toContain(">Allow</button>");
  expect(
    renderToStaticMarkup(<RowAnswer session={terminal} activity={activity(terminal, [])} />),
  ).toBe("");
  expect(renderToStaticMarkup(<RowAnswer session={terminal} activity={undefined} />)).toBe("");
});

test.each([
  ["claude", "Bash", true],
  ["codex", "apply_patch", true],
  ["claude", "AskUserQuestion", false],
  ["claude", "ExitPlanMode", false],
] as const)("a %s tab asking for %s shows the answer buttons: %p", (kind, tool, shows) => {
  chatController(async () => {});
  firstPermission(() => request(tool));
  const chat = session({ tabId: "chat", kind, agent: kind });
  const html = renderToStaticMarkup(<RowAnswer session={chat} activity={undefined} />);
  expect(html.includes(">Allow</button>")).toBe(shows);
});

test("a chat tab without a live controller shows no answer buttons", () => {
  firstPermission(() => request("Bash"));
  const missing = spyOn(claudeController, "existingChatController").mockReturnValue(undefined);
  restores.push(() => missing.mockRestore());
  const chat = session({ tabId: "chat", kind: "claude" });
  expect(renderToStaticMarkup(<RowAnswer session={chat} activity={undefined} />)).toBe("");
});

test("the agent view sidebar answers in both groupings, only on rows that wait for permission", () => {
  quietStores();
  const waiting = session({ tabId: "waiting", title: "Waiting run" });
  const running = session({ tabId: "busy", title: "Busy run", state: "running", phase: "running" });
  const runs = [activity(waiting), activity(running)];
  const byStatus = renderToStaticMarkup(sidebar([waiting, running], runs));
  expect(byStatus.match(/data-testid="agent-sidebar-answer"/g)).toHaveLength(1);
  const byWorkspace = renderToStaticMarkup(
    <WorkspaceGroups
      agents={agentsOf([waiting, running])}
      activity={new Map(runs.map((run) => [`${run.workspaceId}:${run.tabId}`, run]))}
      query=""
    />,
  );
  expect(byWorkspace.match(/data-testid="agent-sidebar-answer"/g)).toHaveLength(1);
});

test("the agent panel's status list keeps its answer buttons", () => {
  quietStores();
  const waiting = session({ tabId: "waiting", title: "Waiting run" });
  const family: SessionFamily = agentsOf([waiting]).families[0]!;
  const html = renderToStaticMarkup(
    <StatusView
      family={family}
      changes={new Map()}
      activity={new Map([[waiting.key, activity(waiting)]])}
      selection={null}
      onSelect={() => {}}
      query=""
    />,
  );
  expect(html).toContain('data-testid="agent-row-answer"');
});

test("allowing from a sidebar row answers the ask, leaves the row unselected and drops the buttons", async () => {
  quietStores();
  const show = spyOn(shown, "showInAgentView").mockImplementation(() => {});
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue({ ok: true, value: true } as never);
  restores.push(
    () => show.mockRestore(),
    () => call.mockRestore(),
  );
  const waiting = session({ tabId: "waiting", title: "Waiting run" });
  await withTestDom(async (host, root) => {
    await act(async () => root.render(sidebar([waiting], [activity(waiting)])));
    const allow = host.querySelector<HTMLButtonElement>(
      '[data-testid="agent-sidebar-answer-allow"]',
    );
    expect(allow).toBeTruthy();
    await act(async () => allow?.click());
    expect(call).toHaveBeenCalledWith("claude", "answerPermission", {
      workspaceId: home.id,
      tabId: "waiting",
      askId: ask.id,
      answer: "allow",
    });
    expect(show).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="agent-sidebar-answer"]')).toBeFalsy();
    host.querySelector<HTMLButtonElement>('[data-agent-row=""]')?.click();
    expect(show).toHaveBeenCalledWith(home.id, "waiting");
  });
});

test("denying a chat tab's request from a sidebar row answers it and drops the buttons", async () => {
  quietStores();
  const show = spyOn(shown, "showInAgentView").mockImplementation(() => {});
  restores.push(() => show.mockRestore());
  let pending: PermissionRequest | undefined = request("Bash");
  const answered: unknown[] = [];
  chatController(async (asked) => {
    answered.push(asked);
    pending = undefined;
  });
  firstPermission(() => pending);
  const chat = session({ tabId: "chat", title: "Chat run", kind: "claude" });
  await withTestDom(async (host, root) => {
    await act(async () => root.render(sidebar([chat], [])));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="agent-sidebar-answer-deny"]')?.click(),
    );
    expect(answered).toEqual([request("Bash")]);
    expect(show).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="agent-sidebar-answer"]')).toBeFalsy();
  });
});
