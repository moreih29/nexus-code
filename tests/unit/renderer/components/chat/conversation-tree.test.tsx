import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import { Tabs } from "radix-ui";
import type { ComponentProps, MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationChildren,
  ConversationParentChip,
} from "../../../../../src/renderer/components/chat/conversation-tree";
import { SessionSidePanel } from "../../../../../src/renderer/components/chat/session-side-panel";
import * as buttons from "../../../../../src/renderer/components/ui/button";
import { TabItem } from "../../../../../src/renderer/components/workspace/tabs/tab-item";
import * as ipc from "../../../../../src/renderer/ipc/client";
import * as estimated from "../../../../../src/renderer/services/agent-sessions/use-estimated";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { openClaudeTab, openCodexTab } from "../../../../../src/renderer/state/operations/tabs";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { findLeaf } from "../../../../../src/renderer/state/stores/layout/helpers";
import { usePeerWorkspaceStore } from "../../../../../src/renderer/state/stores/peer-workspace";
import * as tabs from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import type { TerminalOpener } from "../../../../../src/shared/chat/relay";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

function workspace(id: string): WorkspaceMeta {
  return {
    id,
    name: id,
    color: "auto",
    rootPath: `/${id}`,
    location: { kind: "local", rootPath: `/${id}` },
    pinned: false,
    sortOrder: 0,
    pinnedSortOrder: 0,
    tabs: [],
  };
}

const home = workspace("relations-home");
const other = workspace("relations-other");
const { useTabsStore } = tabs;
let restore: () => void;
beforeEach(() => {
  const before = {
    tabs: useTabsStore.getState(),
    workspaces: useWorkspacesStore.getState(),
    active: useActiveStore.getState(),
    layout: useLayoutStore.getState(),
    view: useAgentViewStore.getState(),
    peer: usePeerWorkspaceStore.getState(),
  };
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue({ ok: true, value: undefined });
  useWorkspacesStore.setState({ workspaces: [home, other] });
  restore = () => {
    call.mockRestore();
    usePeerWorkspaceStore.setState(before.peer);
    useAgentViewStore.setState(before.view);
    useActiveStore.setState(before.active);
    useLayoutStore.setState(before.layout);
    useWorkspacesStore.setState(before.workspaces);
    useTabsStore.setState(before.tabs);
  };
});
afterEach(() => restore());

function conversations() {
  const parent = openClaudeTab(home.id, { cwd: home.rootPath });
  useTabsStore.getState().renameTab(home.id, parent.id, "Release checks");
  const stored: TerminalOpener = {
    kind: "tab",
    workspaceId: "former-workspace",
    tabId: parent.id,
    name: "Old title",
  };
  const child = openCodexTab(other.id, { cwd: other.rootPath, openedBy: stored });
  useTabsStore.getState().renameTab(other.id, child.id, "Review tests");
  const grandchild = openClaudeTab(other.id, {
    cwd: other.rootPath,
    openedBy: { kind: "tab", workspaceId: other.id, tabId: child.id },
  });
  useTabsStore.getState().renameTab(other.id, grandchild.id, "Summarize tests");
  return { parent, child, grandchild, stored };
}

function useCurrentTabsInServerRender() {
  const state = useTabsStore.getState;
  return spyOn(tabs, "useTabsStore").mockImplementation((select) => select(state()));
}

function shownTab(workspaceId: string) {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  return layout && findLeaf(layout.root, layout.activeGroupId)?.activeTabId;
}

type Click = NonNullable<ComponentProps<typeof buttons.Button>["onClick"]>;
function press(click: Click | undefined) {
  if (!click) throw new Error("Missing conversation click handler");
  click({} as MouseEvent<HTMLButtonElement>);
}

test("children section follows Agents, shows descendants with state and time, and activates their workspace tab", () => {
  const { parent, child, grandchild } = conversations();
  useActiveStore.getState().setActiveWorkspaceId(home.id);
  const button = spyOn(buttons, "Button");
  try {
    const html = renderToStaticMarkup(
      <SessionSidePanel
        scope={{
          agent: "codex",
          foldKey: parent.id,
          computer: "Local",
          cwd: home.rootPath,
          rootPath: home.rootPath,
          workspaceId: home.id,
        }}
        panel={undefined}
        model={emptyModel()}
        controls
        onShowAgent={() => {}}
        conversations={<ConversationChildren tabId={parent.id} />}
      />,
    );
    const title = i18next.t("chat.panel.conversations_it_made");
    expect(html).toContain(title);
    expect(html.indexOf(title)).toBeGreaterThan(html.indexOf(i18next.t("chat.panel.agents.title")));
    expect(html.indexOf(title)).toBeLessThan(html.indexOf(i18next.t("chat.panel.results.title")));
    const rows = button.mock.calls
      .map(([props]) => props)
      .filter(
        (props) => (props as Record<string, unknown>)["data-testid"] === "conversation-child",
      );
    expect(rows.map((row) => row.title)).toEqual([
      `Review tests · ${i18next.t("agentList.state.idle")} · ${i18next.t("agentList.duration.now")}`,
      `Summarize tests · ${i18next.t("agentList.state.idle")} · ${i18next.t("agentList.duration.now")}`,
    ]);
    expect(shownTab(other.id)).toBe(grandchild.id);
    press(rows[0]?.onClick);
    expect(useActiveStore.getState().activeWorkspaceId).toBe(other.id);
    expect(shownTab(other.id)).toBe(child.id);
    expect(renderToStaticMarkup(<ConversationChildren tabId={grandchild.id} />)).toBe("");
  } finally {
    button.mockRestore();
  }
});

test("header uses the open parent's current title and can activate the tab in another workspace", () => {
  const { parent, stored } = conversations();
  openCodexTab(home.id, { cwd: home.rootPath });
  useActiveStore.getState().setActiveWorkspaceId(other.id);
  const store = useCurrentTabsInServerRender();
  const button = spyOn(buttons, "Button");
  try {
    const html = renderToStaticMarkup(<ConversationParentChip opener={stored} />);
    expect(html).toContain(">↳ Release checks</span>");
    expect(html).toContain('title="Parent · Release checks"');
    expect(shownTab(home.id)).not.toBe(parent.id);
    press(button.mock.calls[0]?.[0].onClick);
    expect(useActiveStore.getState().activeWorkspaceId).toBe(home.id);
    expect(shownTab(home.id)).toBe(parent.id);
  } finally {
    button.mockRestore();
    store.mockRestore();
  }
});

test("header dims a closed parent and keeps a remote parent inert even with a matching local ID", () => {
  const { stored } = conversations();
  const store = useCurrentTabsInServerRender();
  try {
    const gone = renderToStaticMarkup(
      <ConversationParentChip opener={{ ...stored, tabId: "closed-tab" }} />,
    );
    expect(gone).toContain("opacity-60");
    expect(gone).toContain(">↳ Old title · closed</span>");
    expect(gone).not.toContain("<button");
    const unnamed = renderToStaticMarkup(
      <ConversationParentChip opener={{ ...stored, name: "", tabId: "1a2b3c4d-missing" }} />,
    );
    expect(unnamed).toContain(">↳ Closed conversation</span>");
    expect(unnamed).toContain("opacity-60");
    expect(unnamed).not.toContain("1a2b3c4d");
    const remote = renderToStaticMarkup(
      <ConversationParentChip opener={{ ...stored, device: { id: "n", name: "Studio" } }} />,
    );
    expect(remote).toContain(">↳ Studio · Old title</span>");
    expect(remote).not.toContain("<button");
    expect(renderToStaticMarkup(<ConversationParentChip />)).toBe("");
  } finally {
    store.mockRestore();
  }
});

test("the workspace tab keeps its label and puts the opener name in its tooltip", () => {
  const { child, parent } = conversations();
  const orphan = openCodexTab(other.id, {
    cwd: other.rootPath,
    openedBy: { kind: "tab", agent: "codex", tabId: "1a2b3c4d-missing" },
  });
  const store = useCurrentTabsInServerRender();
  const glyph = spyOn(estimated, "useEstimatedTabGlyph").mockReturnValue(undefined);
  function renderTab(tab: typeof child, title: string) {
    return renderToStaticMarkup(
      <Tabs.Root value={tab.id}>
        <Tabs.List>
          <TabItem
            tab={tab}
            displayTitle={title}
            workspaceId={other.id}
            leafId="g"
            onCloseTab={() => {}}
          />
        </Tabs.List>
      </Tabs.Root>,
    );
  }
  try {
    const html = renderTab(child, "Review tests");
    expect(html).toContain('title="Review tests · Parent · Release checks"');
    expect(html).toContain(">Review tests</span>");
    expect(renderTab(parent, "Release checks")).toContain('title="Release checks"');
    const closed = renderTab(orphan, "Follow-up");
    expect(closed).toContain('title="Follow-up · Parent · Closed conversation"');
    expect(closed).not.toContain("1a2b3c4d");
  } finally {
    glyph.mockRestore();
    store.mockRestore();
  }
});
