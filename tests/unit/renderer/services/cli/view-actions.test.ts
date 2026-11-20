import { expect, test } from "bun:test";
import { remoteSessionKey } from "../../../../../src/renderer/services/agent-view/layout";
import { viewHandlers } from "../../../../../src/renderer/services/cli/view-actions";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import { useRemoteViewStore } from "../../../../../src/renderer/state/stores/remote-view";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { remoteFileKey } from "../../../../../src/shared/fs/remote-file-key";

test("agentView.get describes the local and remote tabs a panel holds", async () => {
  const view = useAgentViewStore.getState();
  const tabs = useTabsStore.getState();
  const remote = useRemoteViewStore.getState();
  const workspaceId = "local-workspace";
  const peer = { deviceId: "8abe5e46-desk", workspaceId: "peer-workspace" };
  const target = {
    ...peer,
    deviceName: "Fake Desk",
    workspaceName: "peer",
    tabId: "318d5da9-chat",
    kind: "codex" as const,
    title: "세션 제목",
    path: "/peer",
  };
  const remoteSession = remoteSessionKey(target);
  const missingSession = remoteSessionKey({ ...peer, tabId: "e671a227-missing" });
  const filePath = "/peer/docs/refresh.pdf";
  const remoteFile = remoteFileKey({ ...peer, path: filePath });
  const windowsPath = "c:\\peer\\docs\\회의 계획 #1.md";
  const unnamedDevice = remoteFileKey({ ...peer, deviceId: "27db33b3-desk", path: windowsPath });

  try {
    const agent = tabs.createTab(workspaceId, { type: "terminal", props: { cwd: "/local" } });
    const file = tabs.createTab(workspaceId, {
      type: "editor",
      props: { workspaceId, filePath: "/local/docs/plan.md" },
    });
    const agentKey = `${workspaceId}:${agent.id}`;
    const fileKey = `${workspaceId}:${file.id}`;
    useAgentViewStore.setState({
      mode: "agents",
      activeLeafId: "p1",
      root: {
        kind: "leaf",
        id: "p1",
        tabIds: [agentKey, fileKey, remoteFile, unnamedDevice, remoteSession, missingSession],
        activeTabId: remoteFile,
      },
      remoteFiles: new Map([
        [remoteFile, { deviceName: "Fake Desk", workspaceRoot: "/peer" }],
        [unnamedDevice, { deviceName: "", workspaceRoot: "C:/peer" }],
      ]),
    });
    useRemoteViewStore.setState({ targets: new Map([[remoteSession, target]]) });

    const { agents, held } = await viewHandlers["agentView.get"]({});
    expect(agents).toEqual([
      { key: agentKey, workspaceId, tabId: agent.id, title: agent.title, type: "terminal" },
    ]);
    expect(held).toEqual([
      { key: fileKey, kind: "file", workspaceId, title: "plan.md", path: "/local/docs/plan.md" },
      {
        key: remoteFile,
        kind: "remote-file",
        workspaceId: peer.workspaceId,
        title: "refresh.pdf",
        device: "Fake Desk",
        path: filePath,
      },
      {
        key: unnamedDevice,
        kind: "remote-file",
        workspaceId: peer.workspaceId,
        title: "회의 계획 #1.md",
        device: "27db33b3",
        path: windowsPath,
      },
      {
        key: remoteSession,
        kind: "remote-session",
        workspaceId: peer.workspaceId,
        title: target.title,
        device: "Fake Desk",
        path: "/peer",
      },
      {
        key: missingSession,
        kind: "remote-session",
        workspaceId: peer.workspaceId,
        title: "e671a227",
        device: "8abe5e46",
      },
    ]);
  } finally {
    useRemoteViewStore.setState(remote);
    useAgentViewStore.setState(view);
    useTabsStore.setState(tabs);
  }
});
