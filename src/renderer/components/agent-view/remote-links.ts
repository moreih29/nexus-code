/**
 * What another computer's chat's links and images open, as a chat here's
 * do: a file the conversation names, an image, or a file it changed, read
 * from that computer and shown in quick look over the conversation; an
 * address in the system browser, unless it is that computer's own.
 */

import i18next from "i18next";
import { useMemo, useRef } from "react";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { ipcCallResult } from "../../ipc/client";
import type { ChatFiles } from "../../services/chat/chat-files";
import { isLocalAddress, resolveFileLink } from "../../services/chat/links";
import type { ImageBlock, RemoteImageRef } from "../../services/chat/model";
import type { RemoteTarget } from "../../state/stores/remote-view";
import { shownPath } from "../../utils/path";
import type { ChatLinks } from "../chat/chat-links";
import { showToast } from "../ui/toast";
import type { RemoteLookItem, RemoteLookList } from "./remote-look";

/** The longest edge an image is fetched at: enough for quick look, far less than a photo's. */
const IMAGE_EDGE = 2048;

const t = (key: string, options?: Record<string, unknown>) => String(i18next.t(key, options));

/** Fetches another computer's chat's images, each once. */
export function peerImageLoader(target: {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}): (image: ImageBlock) => Promise<ImageBlock> {
  const fetched = new Map<string, Promise<ImageBlock>>();
  return (image) => {
    const ref = image.remote;
    if (!ref || image.data) return Promise.resolve(image);
    const key = JSON.stringify(ref);
    let pending = fetched.get(key);
    if (!pending) {
      pending = ipcCallResult("remote", "peerChatImage", {
        deviceId: target.deviceId,
        workspaceId: target.workspaceId,
        tabId: target.tabId,
        maxEdge: IMAGE_EDGE,
        ref: ref as RemoteImageRef,
      }).then((result) => {
        if (!result.ok) {
          fetched.delete(key);
          throw new Error(result.message);
        }
        return { mediaType: result.value.mediaType, data: result.value.data };
      });
      fetched.set(key, pending);
    }
    return pending;
  };
}

/** How long a folder's entries are trusted, as the agent there makes files. */
const LIST_FRESH_MS = 5_000;

/** A path's folder and name, by either separator (that computer may be Windows). */
function splitPath(path: string): { dir: string; name: string } | null {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut <= 0 || cut === path.length - 1) return null;
  return { dir: path.slice(0, cut), name: path.slice(cut + 1) };
}

/**
 * The files another computer's chat names, found on that computer: by the
 * entries of their folders (files.list), and an image file's picture by
 * files.read.
 */
export function peerChatFiles(target: Pick<RemoteTarget, "deviceId" | "workspaceId">): ChatFiles {
  const where = { deviceId: target.deviceId, workspaceId: target.workspaceId };
  const listed = new Map<string, { at: number; names: Promise<ReadonlySet<string>> }>();
  const namesIn = (dir: string): Promise<ReadonlySet<string>> => {
    const cached = listed.get(dir);
    if (cached && Date.now() - cached.at < LIST_FRESH_MS) return cached.names;
    const names = ipcCallResult("remote", "peerFilesList", { ...where, path: dir }).then(
      (result): ReadonlySet<string> =>
        result.ok
          ? new Set(result.value.entries.filter((e) => e.kind !== "dir").map((e) => e.name))
          : new Set(),
      (): ReadonlySet<string> => new Set(),
    );
    listed.set(dir, { at: Date.now(), names });
    return names;
  };
  const pictures = new Map<string, Promise<ImageBlock>>();
  return {
    async there(paths) {
      const found = await Promise.all(
        paths.map(async (path) => {
          const parts = splitPath(path);
          return parts && (await namesIn(parts.dir)).has(parts.name) ? path : null;
        }),
      );
      return new Set(found.filter((path): path is string => path !== null));
    },
    picture(path) {
      let pending = pictures.get(path);
      if (!pending) {
        pending = ipcCallResult("remote", "peerFilesRead", { ...where, path }).then((result) => {
          if (!result.ok || result.value.kind !== "image") {
            pictures.delete(path);
            throw new Error(result.ok ? "not an image" : result.message);
          }
          return { mediaType: result.value.mediaType, data: result.value.data };
        });
        pictures.set(path, pending);
      }
      return pending;
    },
  };
}

/** A file of that computer's, as quick look shows it. */
export async function lookItemOfFile(
  target: Pick<RemoteTarget, "deviceId" | "workspaceId">,
  path: string,
  line?: number,
): Promise<RemoteLookItem> {
  const result = await ipcCallResult("remote", "peerFilesRead", {
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    path,
  });
  const title = path;
  if (!result.ok) return { kind: "message", title, text: result.message };
  const file = result.value;
  switch (file.kind) {
    case "text":
      return {
        kind: "text",
        title,
        text: file.text,
        truncated: file.truncated,
        ...(line ? { line } : {}),
      };
    case "image":
      return { kind: "image", title, image: { mediaType: file.mediaType, data: file.data } };
    default:
      return { kind: "message", title, text: t("agentView.remote.fileBinary") };
  }
}

/** How a file that computer's chat changed differs from its last commit. */
export async function lookItemOfChange(
  target: Pick<RemoteTarget, "deviceId" | "workspaceId">,
  path: string,
): Promise<RemoteLookItem> {
  const result = await ipcCallResult("remote", "peerGitDiff", {
    deviceId: target.deviceId,
    workspaceId: target.workspaceId,
    path,
  });
  const title = path;
  if (!result.ok) return lookItemOfFile(target, path);
  const diff = result.value;
  if (diff.binary) return { kind: "message", title, text: t("agentView.remote.fileBinary") };
  // Committed since, or not in a repository: the file as it is now.
  if (diff.hunks.length === 0) return lookItemOfFile(target, path);
  return { kind: "diff", title, hunks: diff.hunks };
}

/**
 * The links of another computer's chat: each shows quick look at once,
 * with what it reads from that computer as it comes.
 */
export function useRemoteLinks(
  target: RemoteTarget,
  loadImage: (image: ImageBlock) => Promise<ImageBlock>,
  setLook: (update: (now: RemoteLookList | null) => RemoteLookList | null) => void,
): ChatLinks {
  // Each look its own: one that comes after another was opened does not replace it.
  const opened = useRef(0);
  const { deviceId, workspaceId, deviceName } = target;
  const cwd = target.cwd ?? target.path;
  return useMemo<ChatLinks>(() => {
    const where = { deviceId, workspaceId };
    const show = (items: RemoteLookItem[], index: number, fill: Promise<RemoteLookItem[]>) => {
      opened.current += 1;
      const mine = opened.current;
      setLook(() => ({ items, index }));
      void fill.then((filled) => {
        if (opened.current === mine) setLook((now) => (now ? { ...now, items: filled } : now));
      });
    };
    const openFile = (written: string) => {
      const link = resolveFileLink(written, cwd);
      if (!link) return;
      // Named as the conversation's folder sees it.
      const title = shownPath(link.path, cwd);
      show(
        [{ kind: "loading", title }],
        0,
        lookItemOfFile(where, link.path, link.line).then((item) => [{ ...item, title }]),
      );
    };
    return {
      openFile,
      openFileTab: (written) => openFile(written),
      openImages(images, index) {
        const title = (i: number) => t("chat.look.image", { number: i + 1 });
        show(
          images.map((_, i) => ({ kind: "loading", title: title(i) })),
          index,
          Promise.all(
            images.map((image, i) =>
              loadImage(image).then(
                (loaded): RemoteLookItem => ({ kind: "image", title: title(i), image: loaded }),
                (error: Error): RemoteLookItem => ({
                  kind: "message",
                  title: title(i),
                  text: error.message,
                }),
              ),
            ),
          ),
        );
      },
      openChange(path) {
        // Named as the panel's row names it.
        const title = shownPath(path, cwd);
        show(
          [{ kind: "loading", title }],
          0,
          lookItemOfChange(where, path).then((item) => [{ ...item, title }]),
        );
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
    };
  }, [deviceId, workspaceId, cwd, deviceName, loadImage, setLook]);
}
