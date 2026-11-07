// A Codex tab: one Codex thread run by `codex app-server` where the
// workspace runs, shown as a conversation with the list, rows, cards and
// composer of a Claude tab. The program outlives the window and the
// connection, so the view only reads what its controller has. The
// `claude -p` and `codex exec` runs its commands start show beside the
// conversation, in the strip a Claude tab has.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { codexTabHooks } from "../../services/chat/agent-tab";
import {
  type CodexController,
  codexController,
  MIN_CODEX_VERSION,
} from "../../services/chat/codex-controller";
import { type CodexModel, originalsFor } from "../../services/chat/codex-model";
import type { PermissionAnswer } from "../../services/chat/controller";
import {
  type FileLink,
  isLocalAddress,
  isUnder,
  type LineAt,
  resolveFileLink,
  resultFiles,
} from "../../services/chat/links";
import type { PermissionRequest } from "../../services/chat/model";
import { fileLinkTarget, openBrowserBeside, openFileBeside } from "../../services/chat/open-beside";
import { outsideLinksOf, resultsOf } from "../../services/chat/panel";
import { printRunRows, useAgentAsk, usePrintRuns } from "../../services/chat/print-runs";
import { revertChangedFile } from "../../services/chat/revert-file";
import { type ChatTabState, useChatTab } from "../../services/chat/store";
import { registerTabFocusTarget } from "../../services/tab-focus";
import { openTerminal } from "../../services/terminal/open-terminal";
import { queueStartupInput } from "../../services/terminal/pty-client";
import { agentCommandLine } from "../../services/workspace/tasks";
import { localUrlFor } from "../../state/operations/ports";
import { dropAgentAsk } from "../../state/stores/agent-reveal";
import { grantOutside } from "../../state/stores/outside-grants";
import type { CodexTabProps } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { Banner, type BannerAction } from "../ui/banner";
import { CodexIcon } from "./agent-icons";
import { AgentStrip } from "./agent-strip";
import { ChatAgentContext } from "./chat-agent";
import { type ChatLinks, ChatLinksContext } from "./chat-links";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { focusChatTab, PermissionCard } from "./permission-card";
import { PrintRunPane } from "./print-run-pane";
import { QuickLook, type QuickLookList } from "./quick-look";
import { StatusLine } from "./status-line";

interface CodexTabViewProps {
  workspaceId: string;
  tabId: string;
  props: CodexTabProps;
  isVisible: boolean;
}

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
        codexTabHooks(workspaceId, tabId),
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

  // The pane shows the conversation or one of the runs its commands
  // started; input always goes to the conversation.
  const printRuns = usePrintRuns(workspaceId, tabId, isVisible);
  const runs = useMemo(() => printRunRows(printRuns), [printRuns]);
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = shownId ? runs.find((run) => run.toolUseId === shownId) : undefined;
  useEffect(() => {
    if (shownId && !shown) setShownId(null);
  }, [shownId, shown]);
  const showRun = (toolUseId: string | null) => {
    setShownId(toolUseId);
    dropAgentAsk(tabId);
  };
  useAgentAsk(tabId, runs, showRun);

  const rootRef = useRef<HTMLDivElement>(null);
  // Brought to the front (its tab picked, the inbox, the agent view), it
  // takes the keyboard.
  useEffect(() => registerTabFocusTarget(tabId, () => focusChatTab(rootRef.current)), [tabId]);
  // What the conversation links opens over the tab, or beside it.
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
    const show = (path: string, line?: LineAt) => {
      const current = latest.current.state.model as CodexModel;
      const files = resultFiles(resultsOf(current.items, current.tools), cwd);
      const at = files.indexOf(path);
      if (at < 0) setLooked((paths) => (paths.includes(path) ? paths : [...paths, path]));
      const list = at >= 0 ? { files, index: at } : { files: [path, ...files], index: 0 };
      // A file the session changed shows as a diff, when the agent kept its original.
      const changes = originalsFor(current.originals, list.files);
      setLook(
        line?.line
          ? { ...list, changes, at: { path, line: line.line, column: line.column } }
          : { ...list, changes },
      );
    };
    /** The file a link names, and where in it, once it is known which file that is. */
    const follow = (target: string, then: (link: FileLink) => void) => {
      const link = resolveFileLink(target, cwd);
      if (link) void fileLinkTarget(workspaceId, latest.current.rootPath, link).then(then);
    };
    const openFileTab = (target: string, at?: LineAt) => {
      follow(target, ({ path, ...line }) => {
        const inside = isUnder(path, latest.current.rootPath);
        openFileBeside(workspaceId, tabId, path, { split: split(), inside, at: at ?? line });
      });
    };
    return {
      openFile(target) {
        follow(target, ({ path, ...line }) => show(path, line));
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
      <AgentStrip agents={runs} shown={shown ? shown.toolUseId : null} onShow={showRun} />
      {shown?.run ? (
        <PrintRunPane
          workspaceId={workspaceId}
          tabId={tabId}
          cwd={props.cwd}
          rootPath={rootPath}
          run={shown.run}
          visible={isVisible}
        />
      ) : (
        <MessageList
          workspaceId={workspaceId}
          cwd={props.cwd}
          rootPath={rootPath}
          history={null}
          model={state.model}
          empty={
            state.phase === "ready" || state.phase === "ended" ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                <CodexIcon className="size-8" />
                <div className="text-app-body">{t("chat.codex.empty")}</div>
                <div className="max-w-full truncate font-mono text-app-micro" title={props.cwd}>
                  {props.cwd}
                </div>
              </div>
            ) : null
          }
        />
      )}
      {(permissions.length > 0 || model.running) && (
        <div className="app-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 py-2">
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
        placeholder={shown ? t("chat.strip.input_to_main") : undefined}
      />
      {look && (
        <QuickLook
          workspaceId={workspaceId}
          list={look}
          local={isLocal}
          onIndex={(index) => setLook({ ...look, index })}
          onClose={() => setLook(null)}
          onOpenTab={(path, at) => {
            setLook(null);
            links.openFileTab(path, at);
          }}
          onRevert={(path) => {
            const before = look.changes?.[path];
            if (before !== undefined) {
              void revertChangedFile(workspaceId, rootPath, path, before, "codex");
            }
          }}
          revertBlocked={
            model.running ? t("chat.look.revert_busy", { context: "codex" }) : undefined
          }
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
