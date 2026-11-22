import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaudeTabView } from "../../../../../src/renderer/components/chat/claude-tab";
import { CodexTabView } from "../../../../../src/renderer/components/chat/codex-tab";
import * as iconButtons from "../../../../../src/renderer/components/ui/icon-button";
import {
  ChatController,
  chatController,
} from "../../../../../src/renderer/services/chat/claude/controller";
import { runAppCommand } from "../../../../../src/renderer/services/chat/claude/run-command";
import { codexController } from "../../../../../src/renderer/services/chat/codex/controller";
import { CODEX_HISTORY_VERSION } from "../../../../../src/renderer/services/chat/codex/history";
import { emptyCodexModel } from "../../../../../src/renderer/services/chat/codex/model";
import { runCodexCommand } from "../../../../../src/renderer/services/chat/codex/run-command";
import { type AssistantItem, emptyModel } from "../../../../../src/renderer/services/chat/model";
import * as chatStore from "../../../../../src/renderer/services/chat/store";
import {
  chatKey,
  emptyTabState,
  useChatStore,
} from "../../../../../src/renderer/services/chat/store";
import * as receivers from "../../../../../src/renderer/services/chat/transport/receivers";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const answer: AssistantItem = {
  kind: "assistant",
  key: "answer",
  messageId: "turn-1",
  uuid: "message-1",
  blocks: [{ type: "text", text: "The build passed." }],
  forkable: true,
};

let restoreReceivers: () => void;
beforeEach(() => {
  const receiver = spyOn(receivers, "addLineReceiver").mockReturnValue(() => {});
  restoreReceivers = () => receiver.mockRestore();
});
afterEach(() => restoreReceivers());

function sourceChat(agent: "claude" | "codex") {
  const workspaceId = crypto.randomUUID();
  const cwd = "/repo";
  const session = "original-session";
  const props = {
    cwd,
    openedBy: { kind: "tab" as const, agent: "codex" as const, tabId: "opener" },
  };
  const tabs = useTabsStore.getState().byWorkspace;
  const layouts = useLayoutStore.getState().byWorkspace;
  const source = useTabsStore.getState().createTab(workspaceId, { type: agent, props });
  const target = { workspaceId, tabId: source.id, cwd };
  const controller =
    agent === "claude"
      ? chatController({ ...target, sessionId: session })
      : codexController({ ...target, threadId: session });
  const model =
    agent === "claude"
      ? { ...emptyModel(), sessionId: session, items: [answer] }
      : { ...emptyCodexModel(), threadId: session, items: [answer] };
  useChatStore.getState().update(chatKey(workspaceId, source.id), () => ({
    ...emptyTabState(),
    model,
    version: CODEX_HISTORY_VERSION,
  }));
  const forks = () =>
    Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {}).filter(
      (tab) => tab.id !== source.id,
    );
  return {
    target,
    props,
    session,
    controller,
    model,
    forks,
    cleanup() {
      controller.dispose();
      useTabsStore.setState({ byWorkspace: tabs });
      useLayoutStore.setState({ byWorkspace: layouts });
    },
  };
}

test.each([
  "claude",
  "codex",
] as const)("%s app fork buttons open tabs without inheriting openedBy", (agent) => {
  const source = sourceChat(agent);
  const icons = spyOn(iconButtons, "IconButton");
  const subscription = spyOn(chatStore, "useChatTab").mockImplementation(
    (workspaceId, tabId) =>
      useChatStore.getState().tabs[chatKey(workspaceId, tabId)] ?? emptyTabState(),
  );
  try {
    const View = agent === "claude" ? ClaudeTabView : CodexTabView;
    renderToStaticMarkup(<View {...source.target} props={source.props} isVisible={false} />);
    for (const label of ["chat.panel.env.fork_session", "chat.fork.from_assistant"]) {
      const click = icons.mock.calls.find(([props]) => props.label === i18next.t(label))?.[0]
        .onClick;
      if (!click) throw new Error(`missing fork button ${label}`);
      click({} as MouseEvent<HTMLButtonElement>);
    }
    const forks = source.forks();
    const expected =
      agent === "claude"
        ? [{ sessionId: source.session }, { sessionId: source.session, at: answer.uuid }]
        : [
            { threadId: source.session },
            { threadId: source.session, lastTurnId: answer.messageId },
          ];
    expect(forks.map((tab) => tab.props)).toMatchObject(expected.map((fork) => ({ fork })));
    for (const tab of forks) expect(tab.props).not.toHaveProperty("openedBy");
  } finally {
    subscription.mockRestore();
    icons.mockRestore();
    source.cleanup();
  }
});

test.each([
  ["claude", "fork", ""],
  ["claude", "branch", "Follow-up"],
  ["codex", "fork", ""],
] as const)("%s /%s opens a tab without inheriting openedBy", async (agent, name, args) => {
  const source = sourceChat(agent);
  try {
    const context = {
      ...source.target,
      rootPath: source.target.cwd,
      items: source.model.items,
      tools: source.model.tools,
      summarize: () => "",
      openFileTab: () => {},
      openUrl: () => {},
    };
    const { controller } = source;
    if (controller instanceof ChatController) {
      await runAppCommand({ name, args }, { ...context, controller });
    } else {
      await runCodexCommand({ name, args }, { ...context, controller });
    }
    const forks = source.forks();
    expect(forks).toHaveLength(1);
    expect(forks[0]?.props).toHaveProperty(
      "fork",
      expect.objectContaining(
        agent === "claude" ? { sessionId: source.session } : { threadId: source.session },
      ),
    );
    expect(forks[0]?.props).not.toHaveProperty("openedBy");
  } finally {
    source.cleanup();
  }
});
