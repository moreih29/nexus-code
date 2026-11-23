/**
 * A `claude -p` or `codex exec` run another computer's chat's session
 * started, in the pane a chat here shows its own in: read whole from that
 * computer (chat.run) while it shows; stopped there, and its ended session
 * gone on with in a tab of its own there (chat.resume), where that computer
 * lets this one control its chats.
 */

import { useContext } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRun } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import { usePeerRun, usePeerRunConversation } from "../../services/remote/peer-runs";
import { peerWorkspaceId } from "../../services/remote/peer-workspace";
import { openRemoteSession, type RemoteTarget } from "../../state/stores/remote-view";
import { PrintRunPane } from "../chat/print-run-pane";
import { showToast } from "../ui/toast";
import { RemoteSessionHostContext } from "./remote-session-host";

export function RemotePrintRunPane({
  target,
  row,
  visible,
  controls,
}: {
  target: RemoteTarget;
  /** The run as the chat's agents list it, which stands for it till it is read. */
  row: AgentRun;
  visible: boolean;
  /** That computer lets this one control its chats. */
  controls: boolean;
}) {
  const { t } = useTranslation();
  const open = useContext(RemoteSessionHostContext)?.openSession ?? openRemoteSession;
  const { deviceId, workspaceId, tabId } = target;
  const ref = { deviceId, workspaceId, tabId };
  const run = usePeerRun(ref, row, visible);
  const conversation = usePeerRunConversation(ref, row, visible);
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
    <PrintRunPane
      workspaceId={peerWorkspaceId(deviceId, workspaceId)}
      tabId={tabId}
      cwd={target.cwd ?? target.path}
      rootPath={target.path}
      run={run}
      visible={visible}
      stopRun={controls ? stopRun : null}
      openInTab={controls ? openInTab : null}
      conversation={conversation}
    />
  );
}
