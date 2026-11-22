/**
 * What another computer's chat's links and images open, as a chat here's
 * do: a file the conversation names, an image, or a file it changed, read
 * from that computer and shown in this app's quick look; an address in the
 * system browser, unless it is that computer's own.
 */

import i18next from "i18next";
import { useMemo, useRef } from "react";
import { remoteFileKey } from "../../../shared/fs/remote-file-key";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { showHeldRemoteFile } from "../../services/agent-view/file-tabs";
import { remoteSessionKey } from "../../services/agent-view/layout";
import type { ChatFiles } from "../../services/chat/chat-files";
import {
  imageLook,
  latestReadFile,
  lookAtImage,
  type ShownImage,
} from "../../services/chat/image-look";
import { findLinkPlace, linkPlaceIndex, linkPlaces } from "../../services/chat/link-places";
import { type FileLink, fileKind, isLocalAddress } from "../../services/chat/links";
import type { ChatModel } from "../../services/chat/model";
import { changedFilesOf, imagesOf } from "../../services/chat/panel";
import { readRemoteFileBefore } from "../../services/remote/file-comparison";
import { requestTabFocus } from "../../services/tab-focus";
import { useAgentViewStore } from "../../state/stores/agent-view";
import type { RemoteTarget } from "../../state/stores/remote-view";
import type { ChatLinks } from "../chat/chat-links";
import type { QuickLookList } from "../chat/quick-look";
import { showToast } from "../ui/toast";
import type { OpenRemoteFileBeside } from "./remote-session-host";

const t = (key: string, options?: Record<string, unknown>) => String(i18next.t(key, options));

/** What a remote chat's links read of its conversation when one is followed. */
export interface RemoteLinkSource {
  model: Pick<ChatModel, "items" | "tools" | "agentItems">;
}

/**
 * The links of another computer's chat, as a chat here's: a file, an
 * image or a change in quick look, which reads that computer's files
 * through the room (as its peer workspace). A file held by a panel is
 * selected there. Images can be stepped through in the conversation.
 */
export function useRemoteLinks(
  target: RemoteTarget,
  source: RemoteLinkSource,
  files: ChatFiles,
  setLook: (look: QuickLookList | null) => void,
  placeFile?: OpenRemoteFileBeside,
): ChatLinks & { openBeside: OpenRemoteFileBeside } {
  const { deviceId, deviceName, tabId, path: workspaceRoot } = target;
  const peerWorkspace = target.workspaceId;
  const cwd = target.cwd ?? target.path;
  const latest = useRef(source);
  latest.current = source;
  return useMemo<ChatLinks & { openBeside: OpenRemoteFileBeside }>(() => {
    const where = { deviceId, workspaceId: peerWorkspace };
    // Each look its own: one that comes after another was opened does not replace it.
    let opened = 0;
    const show = (look: Promise<QuickLookList | null>) => {
      const mine = ++opened;
      void look.then((list) => {
        if (list && opened === mine) setLook(list);
      });
    };
    /** Quick look over the conversation's images, at `target`; `alone` when it is not among them. */
    const lookAt = (image: ShownImage, alone?: () => QuickLookList) => {
      const { model } = latest.current;
      const shown = imagesOf(model.items, model.tools, cwd, model.agentItems);
      // The last read of a file a panel holds selects the panel; an earlier one shows as it was read.
      const held = image.image ? latestReadFile(shown, image) : undefined;
      if (held) {
        opened++;
        if (!placeFile && showHeldRemoteFile({ ...where, path: held })) {
          setLook(null);
          return;
        }
      }
      show(
        lookAtImage(shown, image, (paths) => files.there(paths)).then(
          (look) => look ?? alone?.() ?? null,
        ),
      );
    };
    const showFile = ({ path, line, column }: FileLink) => {
      opened++;
      if (!placeFile && showHeldRemoteFile({ ...where, path }, { line, column })) {
        setLook(null);
        return;
      }
      if (fileKind(path) === "image") {
        lookAt({ file: path });
        return;
      }
      setLook({
        files: [path],
        index: 0,
        ...(line ? { at: { path, line, ...(column ? { column } : {}) } } : {}),
      });
    };
    /** A file a reply names: from the chat's folder, or from where the agent's shell went there. */
    const openFile = (written: string) => {
      const places = linkPlaces(written, linkPlaceIndex(latest.current.model.tools, cwd));
      void findLinkPlace(places, (paths) => files.there(paths)).then(
        (link) => link && showFile(link),
      );
    };
    return {
      openFile,
      openBeside:
        placeFile ??
        ((path, { at, before, mode, compare }) => {
          const key = remoteFileKey({ ...where, path });
          useAgentViewStore.getState().placeRemoteFile(key, remoteSessionKey({ ...where, tabId }), {
            deviceName,
            workspaceRoot,
            at: at?.line ? { line: at.line, column: at.column } : undefined,
            before,
            mode,
            compare,
            compareFrom: before !== undefined ? tabId : undefined,
          });
          requestTabFocus(key);
          return true;
        }),
      openImages(images, index) {
        const image = images[index];
        if (image) lookAt({ image }, () => imageLook(images, index));
      },
      openChange(path) {
        opened++;
        const file = { ...where, path };
        const { model } = latest.current;
        const known = changedFilesOf(model.tools).find((change) => change.path === path)?.before;
        if (!placeFile && showHeldRemoteFile(file)) {
          const view = useAgentViewStore.getState();
          const key = remoteFileKey(file);
          const previous = view.remoteFiles.get(key);
          view.updateRemoteFile(key, {
            before:
              known !== undefined
                ? known
                : previous?.compareFrom === tabId
                  ? previous.before
                  : undefined,
            compare: true,
            compareFrom: tabId,
          });
          setLook(null);
          return;
        }
        const list = (before: string | null | undefined): QuickLookList => ({
          files: [path],
          index: 0,
          ...(before !== undefined ? { changes: { [path]: before } } : {}),
        });
        if (known !== undefined) setLook(list(known));
        else show(readRemoteFileBefore(file, tabId).then(list, () => list(undefined)));
      },
      openUrl(url) {
        // That computer's own address is not this one's to open.
        if (isLocalAddress(url)) {
          showToast({
            kind: "info",
            message: t("agentView.remote.localAddress", { url, device: deviceName }),
          });
          return;
        }
        if (isExternalSchemeAllowed(url)) window.open(url, "_blank", "noopener,noreferrer");
      },
      urlsOneWay: true as const,
    };
  }, [deviceId, peerWorkspace, tabId, workspaceRoot, cwd, deviceName, files, setLook, placeFile]);
}
