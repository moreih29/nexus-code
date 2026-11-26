import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { isAbsoluteOutsidePath } from "../../../shared/fs/outside-url";
import { isUnder } from "../../../shared/fs/relative-path";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import type { LocalChatLinks } from "../../components/chat/chat-links";
import type { QuickLookList } from "../../components/chat/quick-look";
import { localUrlFor } from "../../state/operations/ports";
import { grantOutside } from "../../state/stores/outside-grants";
import { showHeldLocalFile } from "../agent-view/file-tabs";
import { attachedOpens } from "./attach-folders";
import { filesThere, useGoneFiles } from "./file-presence";
import { imageLook, latestReadFile, lookAtImage, type ShownImage } from "./image-look";
import { linkPlaceIndex } from "./link-places";
import { type FileLink, fileKind, isLocalAddress, type LineAt } from "./links";
import type { ChatItem, ToolCall } from "./model";
import { followFileLink, openBrowserBeside, openFileBeside } from "./open-beside";
import {
  attachedFilesIn,
  imagesOf,
  jobOutputFiles,
  type OutsideLinks,
  outsideLinksOf,
} from "./panel";

export interface LocalChatSource {
  items: readonly ChatItem[];
  tools: Record<string, ToolCall>;
  agentItems: Readonly<Record<string, readonly ChatItem[]>>;
}

export type ChangesOf = (
  path: string,
  tools: Record<string, ToolCall>,
) => Readonly<Record<string, string | null>> | undefined;

export interface LocalLinksEnv {
  workspaceId: string;
  tabId: string;
  cwd: string;
  now(): { source: LocalChatSource; rootPath: string; outside: OutsideLinks; split: boolean };
  changesOf: ChangesOf;
  opensAttached: (written: string) => boolean;
  look(list: QuickLookList | null): void;
  looked(path: string): void;
}

export function shownFile(look: QuickLookList | null): string | undefined {
  const path = look && !look.draft ? look.files[look.index] : undefined;
  if (path === undefined) return undefined;
  return look?.images?.[path] ? look.paths?.[path] : path;
}

export function needsGrant(path: string, rootPath: string, outside: OutsideLinks): boolean {
  return (
    isAbsoluteOutsidePath(path) &&
    !isUnder(path, rootPath) &&
    !outside.files.includes(path) &&
    !outside.opened.includes(path)
  );
}

export function localChatLinks(env: LocalLinksEnv): LocalChatLinks {
  const { workspaceId, tabId, cwd } = env;
  const grant = (path: string) => {
    const { rootPath, outside } = env.now();
    if (needsGrant(path, rootPath, outside)) env.looked(path);
  };
  const follow = (target: string, then: (link: FileLink) => void) => {
    const { source, rootPath } = env.now();
    void followFileLink(workspaceId, rootPath, target, linkPlaceIndex(source.tools, cwd)).then(
      (link) => link && then(link),
    );
  };
  const lookAt = (target: ShownImage, alone?: () => QuickLookList) => {
    const { source, rootPath } = env.now();
    const shown = imagesOf(source.items, source.tools, cwd, source.agentItems);
    const held = target.image ? latestReadFile(shown, target) : undefined;
    if (held && showHeldLocalFile(workspaceId, held)) {
      env.look(null);
      return;
    }
    void lookAtImage(shown, target, (files) => filesThere(workspaceId, rootPath, files)).then(
      (look) => {
        if (target.file) grant(target.file);
        const list = look ?? alone?.();
        if (list) env.look(list);
      },
    );
  };
  const showAlone = (path: string, line?: LineAt) => {
    const changes = env.changesOf(path, env.now().source.tools);
    env.look({
      files: [path],
      index: 0,
      ...(changes && Object.keys(changes).length > 0 ? { changes } : {}),
      ...(line?.line ? { at: { path, line: line.line, column: line.column } } : {}),
    });
  };
  const openFileTab = (target: string, at?: LineAt) => {
    follow(target, ({ path, ...line }) => {
      const inside = isUnder(path, env.now().rootPath);
      grant(path);
      openFileBeside(workspaceId, tabId, path, { split: env.now().split, inside, at: at ?? line });
    });
  };
  return {
    opensAttached: env.opensAttached,
    openFile(target, options) {
      if (options && "draft" in options) {
        env.look({ files: [target], index: 0, draft: options.draft });
        return;
      }
      if (options) {
        const { gallery } = options;
        grant(target);
        env.look({ files: gallery, index: gallery.indexOf(target) });
        return;
      }
      follow(target, ({ path, ...line }) => {
        grant(path);
        if (showHeldLocalFile(workspaceId, path, line)) env.look(null);
        else if (fileKind(path) === "image") lookAt({ file: path });
        else showAlone(path, line);
      });
    },
    openImages(images, index) {
      const image = images[index];
      if (image) lookAt({ image }, () => imageLook(images, index));
    },
    openChange(path) {
      grant(path);
      if (showHeldLocalFile(workspaceId, path)) env.look(null);
      else showAlone(path);
    },
    openFileTab,
    openUrl(url, other = false) {
      const local = isLocalAddress(url);
      if (local !== other) {
        openBrowserBeside(workspaceId, tabId, url, { split: env.now().split });
      } else if (local) {
        void localUrlFor(workspaceId, url).then((here) => {
          if (here) window.open(here, "_blank", "noopener,noreferrer");
        });
      } else if (isExternalSchemeAllowed(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
  };
}

export interface LocalChatLinksInput {
  workspaceId: string;
  tabId: string;
  cwd: string;
  rootPath: string;
  visible: boolean;
  source: LocalChatSource;
  tasks: Parameters<typeof jobOutputFiles>[0]["tasks"];
  split: () => boolean;
  changesOf: ChangesOf;
}

export function useLocalChatLinks(input: LocalChatLinksInput): {
  links: LocalChatLinks;
  look: QuickLookList | null;
  setLook: Dispatch<SetStateAction<QuickLookList | null>>;
} {
  const { workspaceId, tabId, cwd, rootPath, visible, source, tasks } = input;
  const [look, setLook] = useState<QuickLookList | null>(null);
  useEffect(() => {
    if (!visible) setLook(null);
  }, [visible]);
  const [looked, setLooked] = useState<readonly string[]>([]);
  const outside = useMemo(
    () =>
      outsideLinksOf(
        [...source.items],
        source.tools,
        cwd,
        rootPath,
        jobOutputFiles({ tasks }, source.tools),
        undefined,
        looked,
      ),
    [source.items, source.tools, tasks, cwd, rootPath, looked],
  );
  useEffect(() => {
    grantOutside(workspaceId, tabId, { files: outside.files, dirs: [], opened: outside.opened });
  }, [workspaceId, tabId, outside]);
  useEffect(
    () => () => grantOutside(workspaceId, tabId, { files: [], dirs: [], opened: [] }),
    [workspaceId, tabId],
  );
  const attached = useMemo(() => attachedFilesIn(source.items, cwd), [source.items, cwd]);
  const goneAttached = useGoneFiles(workspaceId, rootPath, attached);
  const latest = useRef(input);
  latest.current = input;
  const outsideNow = useRef(outside);
  outsideNow.current = outside;
  const shown = shownFile(look);
  useEffect(() => {
    if (shown && needsGrant(shown, latest.current.rootPath, outsideNow.current)) {
      setLooked((paths) => (paths.includes(shown) ? paths : [...paths, shown]));
    }
  }, [shown]);
  const links = useMemo(
    () =>
      localChatLinks({
        workspaceId,
        tabId,
        cwd,
        now: () => ({
          source: latest.current.source,
          rootPath: latest.current.rootPath,
          outside: outsideNow.current,
          split: latest.current.split(),
        }),
        changesOf: (path, tools) => latest.current.changesOf(path, tools),
        opensAttached: attachedOpens(goneAttached, cwd),
        look: setLook,
        looked: (path) => setLooked((paths) => (paths.includes(path) ? paths : [...paths, path])),
      }),
    [workspaceId, tabId, cwd, goneAttached],
  );
  return { links, look, setLook };
}
