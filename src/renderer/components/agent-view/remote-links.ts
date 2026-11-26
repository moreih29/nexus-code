import i18next from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { remoteFileKey } from "../../../shared/fs/remote-file-key";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { showHeldRemoteFile } from "../../services/agent-view/file-tabs";
import { remoteSessionKey } from "../../services/agent-view/layout";
import { attachShaped, servedAttachment } from "../../services/chat/attach-folders";
import type { ChatFiles, LinkedFile } from "../../services/chat/chat-files";
import {
  imageLook,
  latestReadFile,
  lookAtImage,
  type ShownImage,
} from "../../services/chat/image-look";
import { findLinkPlace, linkPlaceIndex, linkPlaces } from "../../services/chat/link-places";
import { grantMessage, pathInRoot } from "../../services/chat/linked-files";
import {
  type FileLink,
  fileKind,
  isLocalAddress,
  resolveFileLink,
  resolveFilePath,
} from "../../services/chat/links";
import type { ChatModel } from "../../services/chat/model";
import { attachedFilesIn, changedFilesOf, imagesOf } from "../../services/chat/panel";
import { readRemoteFileBefore } from "../../services/remote/file-comparison";
import { requestTabFocus } from "../../services/tab-focus";
import { useAgentViewStore } from "../../state/stores/agent-view";
import type { RemoteTarget } from "../../state/stores/remote-view";
import type { ChatLinks, OpenFileOptions } from "../chat/chat-links";
import type { QuickLookList } from "../chat/quick-look";
import { showToast } from "../ui/toast";
import type { OpenRemoteFileBeside } from "./remote-session-host";

const t = (key: string, options?: Record<string, unknown>) => String(i18next.t(key, options));

export interface RemoteLinkSource {
  model: Pick<ChatModel, "items" | "tools" | "agentItems">;
}

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
  const items = source.model.items;
  const written = useMemo(
    () =>
      attachedFilesIn(items, cwd).filter((file) =>
        servedAttachment(peerWorkspace, workspaceRoot, file),
      ),
    [items, cwd, peerWorkspace, workspaceRoot],
  );
  const gone = useGoneAttachments(files, written);
  return useMemo<ChatLinks & { openBeside: OpenRemoteFileBeside }>(() => {
    const where = { deviceId, workspaceId: peerWorkspace };
    let opened = 0;
    const show = (look: Promise<QuickLookList | null>) => {
      const mine = ++opened;
      void look.then((list) => {
        if (list && opened === mine) setLook(list);
      });
    };
    const lookAt = (image: ShownImage, alone?: () => QuickLookList) => {
      const { model } = latest.current;
      const shown = imagesOf(
        model.items,
        model.tools,
        cwd,
        model.agentItems,
        (file) => attachShaped(peerWorkspace, file) && !gone.has(file),
      );
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
    const granted = (
      written: string,
      link: LinkedFile,
      gallery: string[] | undefined,
      galleryLinks: Readonly<Record<string, LinkedFile>> | undefined,
    ) => {
      const open = files.open;
      if (!open || pathInRoot(link.href, cwd, workspaceRoot) !== null) return false;
      const mine = ++opened;
      void open(link).then(
        (path) => {
          if (opened !== mine) return;
          if (!gallery) {
            const at = resolveFileLink(link.href, cwd);
            showFile({ ...(at ? { ...at } : {}), path });
            return;
          }
          const files = gallery.map((file) => (file === written ? path : file));
          const links: Record<string, LinkedFile> = {};
          for (const [file, one] of Object.entries(galleryLinks ?? {})) {
            links[file === written ? path : file] = one;
          }
          setLook({ files, index: files.indexOf(path), links, granted: [path] });
        },
        (error: unknown) => {
          if (opened !== mine) return;
          showToast({ kind: "error", message: grantMessage(error) });
        },
      );
      return true;
    };
    const openFile = (written: string, options?: OpenFileOptions) => {
      if (options && "draft" in options) {
        opened++;
        setLook({ files: [written], index: 0, draft: options.draft });
        return;
      }
      const link = options?.link;
      const gallery = options?.gallery;
      if (link && granted(written, link, gallery, options?.links)) return;
      if (gallery) {
        opened++;
        setLook({
          files: gallery,
          index: gallery.indexOf(written),
          ...(options?.links && files.open ? { links: options.links } : {}),
        });
        return;
      }
      const places = linkPlaces(written, linkPlaceIndex(latest.current.model.tools, cwd));
      void findLinkPlace(places, (paths) => files.there(paths)).then(
        (link) => link && showFile(link),
      );
    };
    return {
      openFile,
      opensAttached(written) {
        const file = resolveFilePath(written, cwd);
        return (
          file !== null && !gone.has(file) && servedAttachment(peerWorkspace, workspaceRoot, file)
        );
      },
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
        else
          show(readRemoteFileBefore(file, tabId, workspaceRoot).then(list, () => list(undefined)));
      },
      openUrl(url) {
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
  }, [
    deviceId,
    peerWorkspace,
    tabId,
    workspaceRoot,
    cwd,
    deviceName,
    files,
    setLook,
    placeFile,
    gone,
  ]);
}

const NONE: ReadonlySet<string> = new Set();

function useGoneAttachments(files: ChatFiles, paths: readonly string[]): ReadonlySet<string> {
  const key = paths.join("\n");
  const [gone, setGone] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    const wanted = key === "" ? [] : key.split("\n");
    if (wanted.length === 0 || !files.gone) {
      setGone((was) => (was.size === 0 ? was : NONE));
      return;
    }
    let live = true;
    void files.gone(wanted).then((next) => {
      if (!live) return;
      setGone((was) =>
        was.size === next.size && [...next].every((path) => was.has(path)) ? was : next,
      );
    });
    return () => {
      live = false;
    };
  }, [files, key]);
  return gone;
}
