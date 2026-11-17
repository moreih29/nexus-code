/**
 * What another computer's chat's links and images open, as a chat here's
 * do: a file the conversation names, an image, or a file it changed, read
 * from that computer and shown in this app's quick look; an address in the
 * system browser, unless it is that computer's own.
 */

import i18next from "i18next";
import { useMemo, useRef } from "react";
import type { DiffHunk } from "../../../../packages/remote-protocol/src/rpc";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { ipcCallResult } from "../../ipc/client";
import type { ChatFiles } from "../../services/chat/chat-files";
import { imageLook, lookAtImage, type ShownImage } from "../../services/chat/image-look";
import { findLinkPlace, linkPlaceIndex, linkPlaces } from "../../services/chat/link-places";
import { type FileLink, fileKind, isLocalAddress } from "../../services/chat/links";
import type { ChatModel, ImageBlock, RemoteImageRef } from "../../services/chat/model";
import { changedFilesOf, imagesOf } from "../../services/chat/panel";
import type { RemoteTarget } from "../../state/stores/remote-view";
import type { ChatLinks } from "../chat/chat-links";
import type { QuickLookList } from "../chat/quick-look";
import { showToast } from "../ui/toast";

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

/**
 * The file before the changes `hunks` tell, from the file as it is now:
 * the hunks of a diff against the last commit taken back. Null when they
 * do not fit the file now (it changed since).
 */
export function beforeOfHunks(hunks: readonly DiffHunk[], now: string): string | null {
  const lines = now.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const hunk of [...hunks].sort((a, b) => a.newStart - b.newStart)) {
    // A hunk that adds nothing starts after its line; any other, at it.
    const from = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    if (from < at || from > lines.length) return null;
    out.push(...lines.slice(at, from));
    at = from;
    for (const line of hunk.lines) {
      const mark = line[0];
      const text = line.slice(1);
      if (mark === " ") {
        if (lines[at] !== text) return null;
        out.push(text);
        at++;
      } else if (mark === "-") {
        out.push(text);
      } else if (mark === "+") {
        if (lines[at] !== text) return null;
        at++;
      }
      // "\ No newline at end of file" tells nothing of the lines.
    }
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

/** What a remote chat's links read of its conversation when one is followed. */
export interface RemoteLinkSource {
  model: Pick<ChatModel, "items" | "tools" | "agentItems">;
}

/**
 * The links of another computer's chat, as a chat here's: a file, an
 * image or a change in quick look, which reads that computer's files
 * through the room (as its peer workspace); an image among
 * all of the conversation's images. Nothing opens as a tab here, and an
 * address of that computer's own is not this one's to open.
 */
export function useRemoteLinks(
  target: RemoteTarget,
  source: RemoteLinkSource,
  files: ChatFiles,
  setLook: (look: QuickLookList | null) => void,
): ChatLinks {
  const { deviceId, deviceName, tabId } = target;
  const peerWorkspace = target.workspaceId;
  const cwd = target.cwd ?? target.path;
  const latest = useRef(source);
  latest.current = source;
  return useMemo<ChatLinks>(() => {
    const where = { deviceId, workspaceId: peerWorkspace };
    // Each look its own: one that comes after another was opened does not replace it.
    let opened = 0;
    const show = (look: Promise<QuickLookList | null>) => {
      const mine = ++opened;
      void look.then((list) => {
        if (list && opened === mine) setLook(list);
      });
    };
    /** A changed file against its last commit: from how it differs now, the file as that had it. */
    const sinceCommit = (path: string): Promise<QuickLookList> =>
      Promise.all([
        ipcCallResult("remote", "peerGitDiff", { ...where, path }),
        ipcCallResult("remote", "peerFilesRead", { ...where, path }),
      ]).then(([diff, read]): QuickLookList => {
        const now =
          read.ok && read.value.kind === "text" && !read.value.truncated ? read.value.text : null;
        const before =
          diff.ok && !diff.value.binary && diff.value.hunks.length > 0 && now !== null
            ? beforeOfHunks(diff.value.hunks, now)
            : null;
        return {
          files: [path],
          index: 0,
          ...(before !== null ? { changes: { [path]: before } } : {}),
        };
      });
    /** Quick look over the conversation's images, at `target`; `alone` when it is not among them. */
    const lookAt = (image: ShownImage, alone?: () => QuickLookList) => {
      const { model } = latest.current;
      const shown = imagesOf(model.items, model.tools, cwd, model.agentItems);
      show(
        lookAtImage(shown, image, (paths) => files.there(paths)).then(
          (look) => look ?? alone?.() ?? null,
        ),
      );
    };
    const showFile = ({ path, line, column }: FileLink) => {
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
      openImages(images, index) {
        const image = images[index];
        if (image) lookAt({ image }, () => imageLook(images, index));
      },
      openChange(path) {
        const { model } = latest.current;
        const known = changedFilesOf(model.tools).find((file) => file.path === path)?.before;
        if (known !== undefined) {
          setLook({ files: [path], index: 0, changes: { [path]: known } });
          return;
        }
        // Not in the conversation read here (a Codex chat's, or one further
        // back): the original that computer kept of it (0.13.0); without
        // one, the file as its last commit had it, from how it differs now.
        show(
          ipcCallResult("remote", "peerChatOriginal", { ...where, tabId, path }).then(
            (kept): Promise<QuickLookList> =>
              kept.ok
                ? Promise.resolve({
                    files: [path],
                    index: 0,
                    changes: { [path]: kept.value.before },
                  })
                : sinceCommit(path),
          ),
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
      urlsOneWay: true,
    };
  }, [deviceId, peerWorkspace, tabId, cwd, deviceName, files, setLook]);
}
