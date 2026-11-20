import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { type RemoteFileRef, remoteFileKey } from "../../../shared/fs/remote-file-key";
import { ChatFilesContext } from "../../services/chat/chat-files";
import { readRemoteFileBefore } from "../../services/remote/file-comparison";
import { peerChatFiles, usePeerChatAccess } from "../../services/remote/peer-chat-media";
import { peerWorkspaceId } from "../../services/remote/peer-workspace";
import { registerTabFocusTarget } from "../../services/tab-focus";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { FileLookBody, FileLookControls, useFileLookView } from "../chat/file-look";

export function RemoteFilePane({ file }: { file: RemoteFileRef }) {
  const { t } = useTranslation();
  const { deviceId, workspaceId, path } = file;
  const key = remoteFileKey(file);
  const details = useAgentViewStore((s) => s.remoteFiles.get(key));
  const { at, before, compareFrom, mode, compare, workspaceRoot = "" } = details ?? {};
  const view = useFileLookView(path, { at, before, mode, compare });
  const access = usePeerChatAccess(deviceId, true);
  const files = useMemo(
    () => peerChatFiles({ deviceId, workspaceId }, access),
    [deviceId, workspaceId, access],
  );
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => registerTabFocusTarget(key, () => pane.current?.focus()), [key]);

  // Recover a comparison after restart from the peer rather than storing file contents.
  const connection = files.connection;
  useEffect(() => {
    if (connection === null || before !== undefined || !compareFrom) return;
    const abort = new AbortController();
    void readRemoteFileBefore({ deviceId, workspaceId, path }, compareFrom, abort.signal).then(
      (original) => {
        const store = useAgentViewStore.getState();
        const current = store.remoteFiles.get(key);
        if (
          !abort.signal.aborted &&
          original !== undefined &&
          current?.compareFrom === compareFrom &&
          current.before === undefined
        ) {
          store.updateRemoteFile(key, { before: original });
        }
      },
      () => {},
    );
    return () => abort.abort();
  }, [before, compareFrom, connection, deviceId, key, path, workspaceId]);

  return (
    <div
      ref={pane}
      tabIndex={-1}
      className="absolute inset-0 flex flex-col outline-none"
      data-testid="agent-remote-file"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-app-ui-sm" title={path}>
          {path}
        </span>
        <FileLookControls
          path={path}
          view={view}
          onModeChange={(mode) => useAgentViewStore.getState().updateRemoteFile(key, { mode })}
          onCompareChange={(compare) =>
            useAgentViewStore.getState().updateRemoteFile(key, { compare })
          }
        />
        <span className="shrink-0 px-1 text-app-micro text-muted-foreground">
          {t("chat.look.read_only")}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <ChatFilesContext.Provider value={files}>
          <FileLookBody
            workspaceId={peerWorkspaceId(deviceId, workspaceId)}
            path={path}
            root={workspaceRoot}
            at={at}
            before={before}
            view={view}
          />
        </ChatFilesContext.Provider>
      </div>
    </div>
  );
}
