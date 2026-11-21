import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as agentTab from "../../../../../src/renderer/services/chat/agent-tab";
import { ChatController } from "../../../../../src/renderer/services/chat/claude/controller";
import { emptyTabState, useChatStore } from "../../../../../src/renderer/services/chat/store";
import { chatHandlers } from "../../../../../src/renderer/services/cli/chat-actions";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout/store";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import { WorkspaceMetaSchema } from "../../../../../src/shared/types/workspace";

const workspace = WorkspaceMetaSchema.parse({
  id: "ae4a2867-ac67-4296-af99-e693849ac20c",
  rootPath: "/workspace",
  pinned: false,
  tabs: [],
  name: "Workspace",
});

const args = {
  workspaceId: workspace.id,
  agent: "claude" as const,
  cwd: workspace.rootPath,
  placement: { background: true },
};

let restore: () => void;
beforeEach(() => {
  const { workspaces } = useWorkspacesStore.getState();
  const tabs = useTabsStore.getState().byWorkspace;
  const layout = useLayoutStore.getState().byWorkspace;
  useWorkspacesStore.setState({ workspaces: [workspace] });
  restore = () => {
    useTabsStore.setState({ byWorkspace: tabs });
    useLayoutStore.setState({ byWorkspace: layout });
    useWorkspacesStore.setState({ workspaces });
  };
});
afterEach(() => restore());

function mockClaudeForOpen(mode: string) {
  return spyOn(agentTab, "agentTabController").mockImplementation((_workspaceId, tabId) => {
    const controller = new ChatController({ workspaceId: workspace.id, tabId, cwd: args.cwd });
    const state = emptyTabState();
    useChatStore.getState().update(controller.key, () => ({
      ...state,
      phase: "ready",
      model: {
        ...state.model,
        process: "running",
        permissionMode: mode,
        confirmedPermissionMode: mode,
        init: { commands: [], models: [], remoteControl: false },
      },
    }));
    return { agent: "claude", controller };
  });
}

test.each([
  "different",
  "delayed",
] as const)("a new chat checks a %s permission-mode reply before sending", async (reply) => {
  const target = mockClaudeForOpen("acceptEdits");
  const open = spyOn(ChatController.prototype, "open").mockResolvedValue(undefined);
  const setMode = spyOn(ChatController.prototype, "setPermissionMode").mockImplementation(function (
    this: ChatController,
    mode,
  ) {
    if (reply === "different") return Promise.resolve({ mode: "acceptEdits" });
    setTimeout(() => {
      useChatStore.getState().update(this.key, (prev) => ({
        ...prev,
        model: { ...prev.model, permissionMode: mode, confirmedPermissionMode: mode },
      }));
    }, 10);
    return Promise.resolve({});
  });
  const prepare = spyOn(ChatController.prototype, "prepareSend").mockResolvedValue(undefined);
  const modesWhenSent: Array<string | undefined> = [];
  const send = spyOn(ChatController.prototype, "send").mockImplementation(function (
    this: ChatController,
  ) {
    modesWhenSent.push(this.state.model.confirmedPermissionMode);
    return Promise.resolve();
  });
  try {
    const result = await chatHandlers["chat.open"]({
      ...args,
      prompt: "Review this",
      settings: { mode: "plan" },
    });
    expect(setMode).toHaveBeenCalledWith("plan");
    if (reply === "different") {
      expect(result.error).toBeTruthy();
      expect(send).not.toHaveBeenCalled();
    } else {
      expect(result.error).toBeUndefined();
      expect(modesWhenSent).toEqual(["plan"]);
    }
  } finally {
    target.mock.results.forEach((result) => {
      if (result.type === "return") result.value?.controller.dispose();
    });
    target.mockRestore();
    open.mockRestore();
    setMode.mockRestore();
    prepare.mockRestore();
    send.mockRestore();
  }
});
