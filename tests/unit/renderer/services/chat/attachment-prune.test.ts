import { expect, mock, test } from "bun:test";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const prune = mock(async () => ({ ok: true, value: undefined }));
const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    if (channel === "chat" && method === "pruneAttachments") return prune(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { pruneAttachmentsOnce } = await import(
  "../../../../../src/renderer/services/chat/claude/controller"
);

test("attachment pruning keeps Codex and Claude tabs in the same workspace", () => {
  const tabs = useTabsStore.getState();
  const workspaceId = "ws-attachment-prune";
  const { byWorkspace } = tabs;
  try {
    const codex = tabs.createTab(workspaceId, { type: "codex", props: { cwd: "/p" } });
    const claude = tabs.createTab(workspaceId, { type: "claude", props: { cwd: "/p" } });
    tabs.createTab("ws-other-attachments", { type: "codex", props: { cwd: "/other" } });
    pruneAttachmentsOnce(workspaceId);
    pruneAttachmentsOnce(workspaceId);
    expect(prune.mock.calls).toEqual([[{ workspaceId, keepTabIds: [codex.id, claude.id] }]]);
  } finally {
    useTabsStore.setState({ byWorkspace });
  }
});
