// Agents tab — how a conversation shown in the detail panel opens what it
// links, as its own tab would: a file or an image in quick look over the
// panel, among the conversation's images; a file as a tab beside the
// conversation's tab, in its workspace; an address in the app's browser or
// the system's. The previews may read what it links outside its workspace
// while it is shown.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { type CodexModel, originalsFor } from "../../services/chat/codex-model";
import { filesThere } from "../../services/chat/file-presence";
import { imageLook, lookAtImage, type ShownImage } from "../../services/chat/image-look";
import {
  type FileLink,
  fileKind,
  isLocalAddress,
  isUnder,
  type LineAt,
  resolveFileLink,
} from "../../services/chat/links";
import { lookAreaOf } from "../../services/chat/look-area";
import type { ChatModel } from "../../services/chat/model";
import { fileLinkTarget, openBrowserBeside, openFileBeside } from "../../services/chat/open-beside";
import { changedFilesOf, imagesOf, outsideLinksOf } from "../../services/chat/panel";
import { revertChangedFile } from "../../services/chat/revert-file";
import type { ChatTabState } from "../../services/chat/store";
import type { AgentSession } from "../../services/sessions/model";
import { activateWorkspace } from "../../services/workspace/tasks";
import { localUrlFor } from "../../state/operations/ports";
import { useActiveStore } from "../../state/stores/active";
import { grantOutside } from "../../state/stores/outside-grants";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { type ChatLinks, ChatLinksContext } from "../chat/chat-links";
import { QuickLook, type QuickLookList } from "../chat/quick-look";

/** Whose grants of files outside the workspace these are: the panel's, not the tab's own. */
function grantOwner(tabId: string): string {
  return `agents-detail:${tabId}`;
}

/** The conversation's items and calls, what it showed before with what it says now. */
function conversationOf(chat: ChatTabState): Pick<ChatModel, "items" | "tools" | "agentItems"> {
  const { history, model } = chat;
  return {
    items: history ? [...history.items, ...model.items] : model.items,
    tools: history ? { ...history.tools, ...model.tools } : model.tools,
    agentItems: model.agentItems,
  };
}

/** What the session's agent kept of a file before it changed it, for a diff. */
function changesOf(chat: ChatTabState, path: string): Record<string, string | null> | undefined {
  const { originals } = chat.model as Partial<CodexModel>;
  if (originals) return originalsFor(originals, [path]);
  const before = changedFilesOf(conversationOf(chat).tools).find(
    (file) => file.path === path,
  )?.before;
  return before !== undefined ? { [path]: before } : undefined;
}

export function TranscriptLinks({
  session,
  chat,
  cwd,
  visible,
  children,
}: {
  session: AgentSession;
  chat: ChatTabState;
  /** Where the session runs; relative links resolve against it. */
  cwd: string;
  /** The agents tab is shown: out of sight, it takes its quick look with it. */
  visible: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { workspaceId, tabId } = session;
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const rootPath = workspace?.rootPath ?? "";
  const rootRef = useRef<HTMLDivElement>(null);
  const [look, setLook] = useState<QuickLookList | null>(null);
  useEffect(() => {
    if (!visible) setLook(null);
  }, [visible]);
  // Another conversation shown closes the last one's quick look.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closed when the session changes
  useEffect(() => setLook(null), [session.key]);

  const [looked, setLooked] = useState<readonly string[]>([]);
  const outside = useMemo(() => {
    const { items, tools } = conversationOf(chat);
    return outsideLinksOf(items, tools, cwd, rootPath, looked);
  }, [chat, cwd, rootPath, looked]);
  useEffect(() => {
    grantOutside(workspaceId, grantOwner(tabId), outside);
  }, [workspaceId, tabId, outside]);
  useEffect(
    () => () => grantOutside(workspaceId, grantOwner(tabId), { files: [], dirs: [] }),
    [workspaceId, tabId],
  );

  const latest = useRef({ chat, rootPath, outside });
  latest.current = { chat, rootPath, outside };
  // The conversation is read from `latest` when a link is followed.
  const links = useMemo<ChatLinks>(() => {
    /** Lets the previews read a file outside the workspace not granted yet. */
    const grant = (path: string) => {
      const { rootPath, outside } = latest.current;
      if (isUnder(path, rootPath) || outside.files.includes(path)) return;
      setLooked((paths) => (paths.includes(path) ? paths : [...paths, path]));
    };
    /** Quick look over the conversation's images, at `target`; `alone` when it is not among them. */
    const lookAt = (target: ShownImage, alone?: () => QuickLookList) => {
      const { items, tools, agentItems } = conversationOf(latest.current.chat);
      const shown = imagesOf(items, tools, cwd, agentItems);
      void lookAtImage(shown, target, (files) =>
        filesThere(workspaceId, latest.current.rootPath, files),
      ).then((found) => {
        const list = found ?? alone?.();
        if (list) setLook(list);
      });
    };
    /** The file a link names, and where in it, once it is known which file that is. */
    const follow = (target: string, then: (link: FileLink) => void) => {
      const link = resolveFileLink(target, cwd);
      if (link) void fileLinkTarget(workspaceId, latest.current.rootPath, link).then(then);
    };
    /** The conversation's workspace in front, where what it opens goes. */
    const showWorkspace = () => {
      if (useActiveStore.getState().activeWorkspaceId !== workspaceId) {
        activateWorkspace(workspaceId);
      }
    };
    return {
      openFile(target) {
        follow(target, ({ path, ...line }) => {
          grant(path);
          // An image steps through the conversation's images; any other file shows alone.
          if (fileKind(path) === "image") {
            lookAt({ file: path });
            return;
          }
          setLook({
            files: [path],
            index: 0,
            ...(line.line ? { at: { path, line: line.line, column: line.column } } : {}),
          });
        });
      },
      openImages(images, index) {
        const image = images[index];
        if (image) lookAt({ image }, () => imageLook(images, index));
      },
      openChange(path) {
        const changes = changesOf(latest.current.chat, path);
        setLook({ files: [path], index: 0, ...(changes ? { changes } : {}) });
      },
      openFileTab(target, at?: LineAt) {
        follow(target, ({ path, ...line }) => {
          showWorkspace();
          const inside = isUnder(path, latest.current.rootPath);
          openFileBeside(workspaceId, tabId, path, { split: true, inside, at: at ?? line });
        });
      },
      openUrl(url, other = false) {
        const local = isLocalAddress(url);
        if (local !== other) {
          showWorkspace();
          openBrowserBeside(workspaceId, tabId, url, { split: true });
        } else if (local) {
          void localUrlFor(workspaceId, url).then((here) => {
            if (here) window.open(here, "_blank", "noopener,noreferrer");
          });
        } else if (isExternalSchemeAllowed(url)) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
    };
  }, [workspaceId, tabId, cwd]);

  const codex = session.kind === "codex";
  return (
    <ChatLinksContext.Provider value={links}>
      <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
      {look && (
        <QuickLook
          workspaceId={workspaceId}
          list={look}
          area={lookAreaOf(rootRef.current)}
          local={workspace?.location.kind === "local"}
          onIndex={(index) => setLook({ ...look, index })}
          onClose={() => setLook(null)}
          onOpenTab={(path, at) => {
            setLook(null);
            links.openFileTab(path, at);
          }}
          onRevert={(path) => {
            const before = look.changes?.[path];
            if (before !== undefined) {
              void revertChangedFile(
                workspaceId,
                rootPath,
                path,
                before,
                codex ? "codex" : "claude",
              );
            }
          }}
          revertBlocked={
            chat.model.running
              ? t("chat.look.revert_busy", codex ? { context: "codex" } : undefined)
              : undefined
          }
        />
      )}
    </ChatLinksContext.Provider>
  );
}
