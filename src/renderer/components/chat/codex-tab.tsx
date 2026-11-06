// A Codex tab: one Codex thread run by `codex app-server` where the
// workspace runs, shown as a conversation with the list, rows, cards and
// composer of a Claude tab. The program outlives the window and the
// connection, so the view only reads what its controller has.

import { Bot } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import {
  type CodexController,
  codexController,
  MIN_CODEX_VERSION,
} from "../../services/chat/codex-controller";
import type { CodexModel } from "../../services/chat/codex-model";
import type { PermissionAnswer } from "../../services/chat/controller";
import { isLocalAddress, isUnder, resolveFilePath, resultFiles } from "../../services/chat/links";
import type { PermissionRequest } from "../../services/chat/model";
import { openBrowserBeside, openFileBeside } from "../../services/chat/open-beside";
import { outsideLinksOf, resultsOf } from "../../services/chat/panel";
import { type ChatTabState, useChatTab } from "../../services/chat/store";
import { openTerminal } from "../../services/terminal/open-terminal";
import { queueStartupInput } from "../../services/terminal/pty-client";
import { agentCommandLine } from "../../services/workspace/tasks";
import { localUrlFor } from "../../state/operations/ports";
import { grantOutside } from "../../state/stores/outside-grants";
import type { CodexTabProps } from "../../state/stores/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { Banner, type BannerAction } from "../ui/banner";
import { ChatAgentContext } from "./chat-agent";
import { type ChatLinks, ChatLinksContext } from "./chat-links";
import { Composer, idlePlaceholder, runningPlaceholder } from "./composer";
import { MessageList } from "./message-list";
import { PermissionCard } from "./permission-card";
import { QuickLook, type QuickLookList } from "./quick-look";
import { StatusLine } from "./status-line";

interface CodexTabViewProps {
  workspaceId: string;
  tabId: string;
  props: CodexTabProps;
  isVisible: boolean;
}

/** Longest first message kept as the tab's title. */
const TITLE_CHARS = 40;
/** From this width a file opens in a group beside the tab. */
const SPLIT_FROM_PX = 900;

export function CodexTabView({ workspaceId, tabId, props, isVisible }: CodexTabViewProps) {
  const { t } = useTranslation();
  const rootPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const isLocal = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location.kind === "local",
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target is read once; the controller keeps the thread it moves on to
  const controller = useMemo(
    () =>
      codexController(
        { workspaceId, tabId, cwd: props.cwd, threadId: props.threadId },
        {
          onThread: (threadId) =>
            useTabsStore.getState().setCodexThread(workspaceId, tabId, threadId),
          onFirstMessage: (text) =>
            useTabsStore.getState().setProcessTitle(workspaceId, tabId, titleOf(text)),
        },
      ),
    [workspaceId, tabId],
  );
  const state = useChatTab(workspaceId, tabId);
  const model = state.model as CodexModel;

  // Opened the first time the tab is shown, so restored tabs in the
  // background start nothing until they are looked at.
  const opened = useRef(false);
  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    void controller.open();
  }, [isVisible, controller]);

  const onAnswer = (request: PermissionRequest, answer: PermissionAnswer) => {
    void controller.answerPermission(request, answer).catch(() => {});
  };

  // What the conversation links opens over the tab, or beside it.
  const rootRef = useRef<HTMLDivElement>(null);
  const [look, setLook] = useState<QuickLookList | null>(null);
  const [looked, setLooked] = useState<readonly string[]>([]);
  const outside = useMemo(
    () => outsideLinksOf(state.model.items, state.model.tools, props.cwd, rootPath, looked),
    [state.model, props.cwd, rootPath, looked],
  );
  useEffect(() => {
    grantOutside(workspaceId, tabId, outside);
  }, [workspaceId, tabId, outside]);
  useEffect(
    () => () => grantOutside(workspaceId, tabId, { files: [], dirs: [] }),
    [workspaceId, tabId],
  );
  const latest = useRef({ state, rootPath });
  latest.current = { state, rootPath };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab's state is read from `latest` when a link is followed
  const links = useMemo<ChatLinks>(() => {
    const cwd = props.cwd;
    const split = () => (rootRef.current?.clientWidth ?? 0) >= SPLIT_FROM_PX;
    const show = (path: string) => {
      const { model: current } = latest.current.state;
      const files = resultFiles(resultsOf(current.items, current.tools), cwd);
      const at = files.indexOf(path);
      if (at < 0) setLooked((paths) => (paths.includes(path) ? paths : [...paths, path]));
      setLook(at >= 0 ? { files, index: at } : { files: [path, ...files], index: 0 });
    };
    const openFileTab = (target: string) => {
      const path = resolveFilePath(target, cwd);
      if (!path) return;
      const inside = isUnder(path, latest.current.rootPath);
      openFileBeside(workspaceId, tabId, path, { split: split(), inside });
    };
    return {
      openFile(target) {
        const path = resolveFilePath(target, cwd);
        if (path) show(path);
      },
      openChange: (path) => show(path),
      openFileTab,
      openUrl(url, other = false) {
        const local = isLocalAddress(url);
        if (local !== other) {
          openBrowserBeside(workspaceId, tabId, url, { split: split() });
        } else if (local) {
          void localUrlFor(workspaceId, url).then((here) => {
            if (here) window.open(here, "_blank", "noopener,noreferrer");
          });
        } else if (isExternalSchemeAllowed(url)) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
    };
  }, [workspaceId, tabId]);

  const signIn = () => {
    // A browser on this machine cannot reach a sign-in an SSH host waits for.
    const command = isLocal ? "codex login" : "codex login --device-auth";
    const { tabId: terminal } = openTerminal({ workspaceId, cwd: props.cwd });
    queueStartupInput(
      workspaceId,
      terminal,
      (shellPath) => agentCommandLine(command, "", shellPath) ?? "",
    );
  };

  const permissions = model.permissions;
  const view = (
    <div
      ref={rootRef}
      className="relative flex h-full flex-col bg-background"
      data-testid="codex-tab"
    >
      <PhaseBanner controller={controller} state={state} />
      {model.signedOut && model.process === "running" && (
        <div className="shrink-0" data-testid="codex-signed-out">
          <Banner
            variant="warning"
            message={t("chat.codex.signed_out")}
            actions={[
              { label: t("chat.codex.sign_in"), onAction: signIn },
              {
                label: t("chat.codex.sign_in_check"),
                onAction: () => void controller.refreshAccount(),
              },
            ]}
          />
        </div>
      )}
      <MessageList
        workspaceId={workspaceId}
        cwd={props.cwd}
        rootPath={rootPath}
        history={null}
        model={state.model}
        empty={
          state.phase === "ready" || state.phase === "ended" ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Bot className="size-8" />
              <div className="text-app-body">{t("chat.codex.empty")}</div>
              <div className="max-w-full truncate font-mono text-app-micro" title={props.cwd}>
                {props.cwd}
              </div>
            </div>
          ) : null
        }
      />
      {(permissions.length > 0 || model.running) && (
        <div className="app-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 pt-2">
          <div className="mx-auto flex max-w-[860px] flex-col gap-2">
            {permissions.length > 0 && (
              <PermissionCard
                requests={permissions}
                workspaceId={workspaceId}
                cwd={props.cwd}
                rootPath={rootPath}
                onAnswer={onAnswer}
              />
            )}
            <StatusLine model={state.model} />
          </div>
        </div>
      )}
      <Composer
        controller={controller}
        state={state}
        local={isLocal}
        appCommands={false}
        placeholder={
          model.running ? runningPlaceholder(t) : idlePlaceholder(t, "chat.codex.placeholder")
        }
      />
      {look && (
        <QuickLook
          workspaceId={workspaceId}
          list={look}
          local={isLocal}
          onIndex={(index) => setLook({ ...look, index })}
          onClose={() => setLook(null)}
          onOpenTab={(path) => {
            setLook(null);
            links.openFileTab(path);
          }}
        />
      )}
    </div>
  );
  return (
    <ChatAgentContext.Provider value="codex">
      <ChatLinksContext.Provider value={links}>{view}</ChatLinksContext.Provider>
    </ChatAgentContext.Provider>
  );
}

function titleOf(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

function PhaseBanner({ controller, state }: { controller: CodexController; state: ChatTabState }) {
  const { t } = useTranslation();
  const retry: BannerAction = {
    label: t("chat.phase.retry"),
    onAction: () => void controller.open(),
  };
  let banner: React.ReactNode = null;
  switch (state.phase) {
    case "starting":
      banner = <Banner variant="info" message={t("chat.codex.starting")} />;
      break;
    case "held":
      banner = <Banner variant="warning" message={t("chat.codex.held")} />;
      break;
    case "ended":
      banner = (
        <Banner
          variant="info"
          message={t("chat.codex.ended")}
          details={state.model.exit?.stderrTail || undefined}
          actions={[{ label: t("chat.phase.restart"), onAction: () => void controller.restart() }]}
        />
      );
      break;
    case "not-found":
      banner = (
        <Banner
          variant="error"
          message={t("chat.codex.not_found")}
          details={state.error}
          actions={[retry]}
        />
      );
      break;
    case "failed":
      banner =
        state.error === "old-version" ? (
          <Banner
            variant="error"
            message={t("chat.codex.old_version", {
              version: state.version ?? "?",
              min: MIN_CODEX_VERSION,
            })}
            actions={[retry]}
          />
        ) : (
          <Banner
            variant="error"
            message={t("chat.codex.failed")}
            details={state.error}
            actions={[retry]}
          />
        );
      break;
  }
  if (!banner && !state.truncated) return null;
  return (
    <div className="shrink-0 pt-1">
      {banner}
      {state.truncated && <Banner variant="info" message={t("chat.phase.truncated")} />}
    </div>
  );
}
