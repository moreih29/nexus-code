import { type RemoteFileRef, remoteFileKey } from "../../../shared/fs/remote-file-key";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import type { ChatFiles } from "../../services/chat/chat-files";
import { grantMessage, pathInRoot } from "../../services/chat/linked-files";
import { type LineAt, resolveFileLink } from "../../services/chat/links";
import { requestTabFocus } from "../../services/tab-focus";
import { useAgentViewStore } from "../../state/stores/agent-view";
import type { ChatLinks } from "../chat/chat-links";
import { showToast } from "../ui/toast";

export interface HeldFile {
  deviceName: string;
  workspaceRoot: string;
  tabId?: string;
}

function folderOf(path: string): string {
  const cut = path.replace(/\\/g, "/").lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function heldFileLinks(file: RemoteFileRef, held: HeldFile, files: ChatFiles): ChatLinks {
  const from = remoteFileKey(file);
  const folder = folderOf(file.path);
  const place = (path: string, at?: LineAt) => {
    const key = remoteFileKey({ ...file, path });
    useAgentViewStore.getState().placeRemoteFile(key, from, {
      deviceName: held.deviceName,
      workspaceRoot: held.workspaceRoot,
      at: at?.line ? { line: at.line, ...(at.column ? { column: at.column } : {}) } : undefined,
      ...(held.tabId !== undefined ? { tabId: held.tabId } : {}),
    });
    requestTabFocus(key);
  };
  return {
    openFile(target, options) {
      const link = options && !("draft" in options) ? options.link : undefined;
      const open = files.open;
      if (!link || !open) {
        place(target);
        return;
      }
      const at = resolveFileLink(link.href, folder) ?? undefined;
      const inside = pathInRoot(link.href, folder, held.workspaceRoot);
      if (inside !== null) {
        place(inside, at);
        return;
      }
      void open(link).then(
        (path) => place(path, at),
        (error: unknown) => showToast({ kind: "error", message: grantMessage(error) }),
      );
    },
    openImages() {},
    openChange(path) {
      place(path);
    },
    openUrl(url) {
      if (isExternalSchemeAllowed(url)) window.open(url, "_blank", "noopener,noreferrer");
    },
    urlsOneWay: true,
  };
}
