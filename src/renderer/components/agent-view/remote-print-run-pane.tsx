import { useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRun } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import { FileLinkRunContext } from "../../services/chat/chat-files";
import type { ImageLook } from "../../services/chat/image-look";
import type { ImageLoader } from "../../services/chat/model";
import {
  readPeerRunTool,
  runImageLook,
  usePeerRun,
  usePeerRunConversation,
} from "../../services/remote/peer-runs";
import { peerWorkspaceId } from "../../services/remote/peer-workspace";
import { openRemoteSession, type RemoteTarget } from "../../state/stores/remote-view";
import { ImageLoaderContext } from "../chat/chat-image";
import { type ChatLinks, ChatLinksContext, useChatLinks } from "../chat/chat-links";
import { PrintRunPane } from "../chat/print-run-pane";
import { ToolOutputContext } from "../chat/tool-row";
import { showToast } from "../ui/toast";
import { RemoteSessionHostContext } from "./remote-session-host";

export function RemotePrintRunPane({
  target,
  row,
  visible,
  controls,
  loadImage,
  onLook,
}: {
  target: RemoteTarget;
  row: AgentRun;
  visible: boolean;
  controls: boolean;
  loadImage: ImageLoader | null;
  onLook: (list: ImageLook) => void;
}) {
  const { t } = useTranslation();
  const open = useContext(RemoteSessionHostContext)?.openSession ?? openRemoteSession;
  const { deviceId, workspaceId, tabId } = target;
  const ref = { deviceId, workspaceId, tabId };
  const run = usePeerRun(ref, row, visible);
  const conversation = usePeerRunConversation(ref, row, visible);
  const cwd = target.cwd ?? target.path;
  const runId = row.id;
  const canReadItems = loadImage !== null && visible;
  const readTool = useMemo(
    () =>
      canReadItems
        ? (toolUseId: string, signal: AbortSignal) =>
            readPeerRunTool({ deviceId, workspaceId, tabId, runId }, toolUseId, signal)
        : null,
    [canReadItems, deviceId, workspaceId, tabId, runId],
  );
  const links = useChatLinks();
  const runLinks: ChatLinks | null = links && {
    ...links,
    openImages: (images, index) => onLook(runImageLook(conversation?.model, cwd, images, index)),
  };
  const codex = run.program === "codex";
  const stopRun = async () => {
    const result = await ipcCallResult("remote", "peerChatStopRun", { ...ref, runId: run.id });
    return result.ok && result.value.stopped;
  };
  const openInTab = (sessionId: string) =>
    void ipcCallResult("remote", "peerChatResume", {
      deviceId,
      workspaceId,
      agent: codex ? "codex" : "claude",
      sessionId,
    }).then((result) => {
      if (!result.ok) {
        showToast({
          kind: "error",
          message: t("chat.sessions.resume_failed", { message: result.message }),
        });
        return;
      }
      const { profile: _theirs, cwd: _its, ...rest } = target;
      open({
        ...rest,
        kind: codex ? "codex" : "claude",
        tabId: result.value.tabId,
        title: run.description ?? run.prompt?.slice(0, 80) ?? (codex ? "codex exec" : "claude -p"),
        state: "idle",
      });
    });
  return (
    <ImageLoaderContext.Provider value={loadImage}>
      <FileLinkRunContext.Provider value={runId}>
        <ChatLinksContext.Provider value={runLinks}>
          <ToolOutputContext.Provider value={readTool}>
            <PrintRunPane
              workspaceId={peerWorkspaceId(deviceId, workspaceId)}
              tabId={tabId}
              cwd={cwd}
              rootPath={target.path}
              run={run}
              visible={visible}
              stopRun={controls ? stopRun : null}
              openInTab={controls ? openInTab : null}
              conversation={conversation}
            />
          </ToolOutputContext.Provider>
        </ChatLinksContext.Provider>
      </FileLinkRunContext.Provider>
    </ImageLoaderContext.Provider>
  );
}
