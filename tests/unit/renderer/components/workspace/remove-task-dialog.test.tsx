import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import {
  ClosingConversations,
  closingConversations,
} from "../../../../../src/renderer/components/workspace/remove-task-dialog";
import type {
  AgentSession,
  SessionFamily,
} from "../../../../../src/renderer/services/agent-sessions/model";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

function workspace(id: string, task?: WorkspaceMeta["task"]): WorkspaceMeta {
  return {
    id,
    name: id,
    rootPath: `/${id}`,
    location: { kind: "local", rootPath: `/${id}` },
    pinned: false,
    color: "auto",
    sortOrder: 0,
    pinnedSortOrder: 0,
    tabs: [],
    ...(task ? { task } : {}),
  };
}

function session(workspaceId: string, tabId: string, title: string, parent?: string): AgentSession {
  return {
    key: `${workspaceId}:${tabId}`,
    workspaceId,
    tabId,
    title,
    kind: "claude",
    agent: "claude",
    state: "idle",
    phase: "idle",
    estimated: false,
    since: undefined,
    message: undefined,
    prompt: undefined,
    ...(parent ? { parent: { kind: "tab" as const, tabId: parent } } : {}),
  };
}

const home = workspace("home");
const task = workspace("status-qa", {
  parentId: home.id,
  branch: "status-qa",
  worktreePath: "/status-qa",
});
const lead = session(home.id, "lead", "장애 상태 집계");
const brief = session(task.id, "brief", "작업 지시서 status-qa.md 를 읽고", lead.tabId);
const nested = session(task.id, "nested", "캐시 키 정하기", brief.tabId);
const own = session(task.id, "own", "스냅샷 테스트 정리");
const families: SessionFamily[] = [
  {
    root: home,
    worktrees: [
      { workspace: home, isRoot: true, branch: undefined, sessions: [lead] },
      { workspace: task, isRoot: false, branch: "status-qa", sessions: [own, brief, nested] },
    ],
  },
];

describe("the conversations a task's removal closes", () => {
  test("each with the nearest conversation above it that runs elsewhere", () => {
    expect(closingConversations(families, task.id)).toEqual([
      { key: own.key, title: own.title },
      { key: brief.key, title: brief.title, parent: lead.title },
      { key: nested.key, title: nested.title, parent: lead.title },
    ]);
    expect(closingConversations(families, "none")).toEqual([]);
  });

  test.each([
    ["ko", "에이전트 탭 3개 · ‘장애 상태 집계’ 아래 2 포함", "↳ 장애 상태 집계"],
    ["en", "3 agent tabs · including 2 under “장애 상태 집계”", "↳ 장애 상태 집계"],
  ])("say how many, how many under a parent elsewhere, and their names in %s", async (lng, summary, parent) => {
    const i18n = i18next.cloneInstance({ lng });
    await i18n.changeLanguage(lng);
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ClosingConversations conversations={closingConversations(families, task.id)} />
      </I18nextProvider>,
    );
    expect(html).toContain(`<span class="block">${summary}</span>`);
    for (const { title } of [own, brief, nested]) expect(html).toContain(`>${title}</span>`);
    expect(html.match(new RegExp(`>${parent}</span>`, "g"))).toHaveLength(2);
  });

  test("one conversation, and more than four, read as such", () => {
    const one = renderToStaticMarkup(
      <ClosingConversations conversations={[{ key: own.key, title: own.title }]} />,
    );
    expect(one).toContain(">1 agent tab</span>");
    const many = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, title: `Chat ${i}` }));
    const html = renderToStaticMarkup(<ClosingConversations conversations={many} />);
    expect(html).toContain(">6 agent tabs</span>");
    expect(html).toContain(">Chat 3</span>");
    expect(html).not.toContain(">Chat 4</span>");
    expect(html).toContain(">and 2 more</span>");
    expect(renderToStaticMarkup(<ClosingConversations conversations={[]} />)).toBe("");
  });
});
