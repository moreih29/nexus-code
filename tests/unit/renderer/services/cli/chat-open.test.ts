import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as agentTab from "../../../../../src/renderer/services/chat/agent-tab";
import { ChatController } from "../../../../../src/renderer/services/chat/claude/controller";
import { emptyTabState, useChatStore } from "../../../../../src/renderer/services/chat/store";
import { chatHandlers } from "../../../../../src/renderer/services/cli/chat-actions";
import { useAgentProfilesStore } from "../../../../../src/renderer/state/stores/agent-profiles";
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
  const profiles = useAgentProfilesStore.getState().config;
  const tabs = useTabsStore.getState().byWorkspace;
  const layout = useLayoutStore.getState().byWorkspace;
  useWorkspacesStore.setState({ workspaces: [workspace] });
  restore = () => {
    useTabsStore.setState({ byWorkspace: tabs });
    useLayoutStore.setState({ byWorkspace: layout });
    useWorkspacesStore.setState({ workspaces });
    useAgentProfilesStore.getState().hydrate(profiles);
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

test("an exact profile ID takes precedence over a name and duplicate names require an ID", async () => {
  useAgentProfilesStore.getState().hydrate({
    profiles: [
      { id: "claude-default", name: "claude-8301a924", agent: "claude", color: "blue", dir: "" },
      { id: "claude-8301a924", name: "Office", agent: "claude", color: "cyan", dir: "/office" },
      { id: "claude-1de212b3", name: "office", agent: "claude", color: "violet", dir: "/other" },
    ],
    rules: [],
    defaults: {},
  });
  const target = spyOn(agentTab, "agentTabController").mockReturnValue(null);
  try {
    const open = chatHandlers["chat.open"];
    await expect(open({ ...args, prompt: "", profile: "Office" })).rejects.toThrow(
      /profile ID|프로필 ID|ambiguousProfile/,
    );
    const { tabId } = await open({ ...args, prompt: "", profile: "claude-8301a924" });
    expect(useTabsStore.getState().byWorkspace[workspace.id]?.[tabId]?.props).toMatchObject({
      profileId: "claude-8301a924",
    });
  } finally {
    target.mockRestore();
  }
});

test("a new chat with a prompt and no settings returns its tab ID and startup failure", async () => {
  const target = mockClaudeForOpen("default");
  const open = spyOn(ChatController.prototype, "open").mockRejectedValue(
    new Error("Claude startup failed"),
  );
  const send = spyOn(ChatController.prototype, "send").mockResolvedValue(undefined);
  try {
    const result = await chatHandlers["chat.open"]({ ...args, prompt: "Review this" });
    expect(result).toEqual({ tabId: expect.any(String), error: "Claude startup failed" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  } finally {
    target.mock.results.forEach((result) => {
      if (result.type === "return") result.value?.controller.dispose();
    });
    target.mockRestore();
    open.mockRestore();
    send.mockRestore();
  }
});
