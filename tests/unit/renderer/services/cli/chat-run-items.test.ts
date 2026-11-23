import { afterEach, beforeEach, expect, mock, test } from "bun:test";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const lines = [
  {
    type: "user",
    uuid: "u1",
    message: { role: "user", content: [{ type: "text", text: "look at it" }] },
  },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      id: "m1",
      role: "assistant",
      content: [{ type: "tool_use", id: "shot1", name: "Read", input: { file_path: "/p/a.png" } }],
    },
  },
  {
    type: "user",
    uuid: "r1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "shot1",
          content: [
            { type: "text", text: "the run's own output" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
          ],
        },
      ],
    },
  },
];

const asked: Record<string, unknown>[] = [];
let found = true;
const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    if (method === "printRunTranscript") {
      asked.push(args);
      return Promise.resolve({
        ok: true,
        value: found
          ? { found: true, lines, next: 100, reset: false, truncated: false }
          : { found: false, lines: [], next: 0, reset: false, truncated: false },
      });
    }
    if (method === "printRunReader") {
      return Promise.resolve({ ok: true, value: { ok: false, reason: "none" } });
    }
    return method === "replay"
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, value: undefined });
  },
}));

const { agentTabController } = await import("../../../../../src/renderer/services/chat/agent-tab");
const { chatHandlers } = await import("../../../../../src/renderer/services/cli/chat-actions");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");
const { WorkspaceMetaSchema } = await import("../../../../../src/shared/types/workspace");

const workspace = WorkspaceMetaSchema.parse({
  id: "7a1c2e40-5b1d-4c8e-9f20-3d4e5f6a7b8c",
  rootPath: "/workspace",
  pinned: false,
  tabs: [],
  name: "Workspace",
});

let restore: () => void;
const live: { dispose(): void }[] = [];
beforeEach(() => {
  const { workspaces } = useWorkspacesStore.getState();
  const tabs = useTabsStore.getState().byWorkspace;
  useWorkspacesStore.setState({ workspaces: [workspace] });
  asked.length = 0;
  found = true;
  restore = () => {
    useTabsStore.setState({ byWorkspace: tabs });
    useWorkspacesStore.setState({ workspaces });
  };
});
afterEach(() => {
  for (const controller of live.splice(0)) controller.dispose();
  restore();
});

function claudeTab(): string {
  const tabId = useTabsStore
    .getState()
    .createTab(workspace.id, { type: "claude", props: { cwd: workspace.rootPath } }).id;
  const target = agentTabController(workspace.id, tabId);
  if (!target) throw new Error("no controller");
  live.push(target.controller);
  return tabId;
}

test("a run's tool call and image come from the run's own session", async () => {
  const tabId = claudeTab();
  const ref = { workspaceId: workspace.id, tabId, runId: "run-7" };
  const tool = await chatHandlers["chat.toolCall"]({ ...ref, toolUseId: "shot1", maxText: 1000 });
  expect(tool).toMatchObject({ id: "shot1", name: "Read" });
  expect(tool.result?.text).toContain("the run's own output");
  const image = await chatHandlers["chat.image"]({
    ...ref,
    ref: { kind: "tool", toolUseId: "shot1", index: 0 },
    maxChars: 100_000,
  });
  expect(image).toMatchObject({ mediaType: "image/png", data: PNG });
  const cli = await chatHandlers["chat.tool"]({ ...ref, ref: "shot1" });
  expect(cli).toMatchObject({ toolUseId: "shot1", result: { text: "the run's own output" } });
  expect(asked.length).toBeGreaterThan(0);
  for (const args of asked)
    expect(args).toMatchObject({ workspaceId: workspace.id, tabId, runId: "run-7" });
});

test("a call or image the run does not hold, or a run with no session, is told apart", async () => {
  const tabId = claudeTab();
  const ref = { workspaceId: workspace.id, tabId, runId: "run-8" };
  await expect(
    chatHandlers["chat.toolCall"]({ ...ref, toolUseId: "other", maxText: 1000 }),
  ).rejects.toThrow(/^no tool call other in that run/);
  await expect(
    chatHandlers["chat.image"]({
      ...ref,
      ref: { kind: "tool", toolUseId: "shot1", index: 3 },
      maxChars: 100_000,
    }),
  ).rejects.toThrow(/no such image in that run/);
  found = false;
  await expect(
    chatHandlers["chat.toolCall"]({ ...ref, runId: "run-9", toolUseId: "shot1", maxText: 1000 }),
  ).rejects.toThrow(/^no session of run run-9/);
});
