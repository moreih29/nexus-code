// A Codex tab: one Codex thread run by `codex app-server` where the
// workspace runs, shown as a conversation with the list, rows, cards and
// composer of a Claude tab. The program outlives the window and the
// connection, so the view only reads what its controller has. The
// `claude -p` and `codex exec` runs its commands start show beside the
// conversation, in the strip a Claude tab has.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { defaultProfileId } from "../../../shared/agent-profiles/profiles";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { codexTabHooks } from "../../services/chat/agent-tab";
import { parseAppCommand, revealOf } from "../../services/chat/app-commands";
import { codexCommandsListed, parseCodexCommand } from "../../services/chat/codex-commands";
import {
  type CodexController,
  type CodexTabHooks,
  codexController,
  MIN_CODEX_VERSION,
} from "../../services/chat/codex-controller";
import { type CodexModel, originalsFor } from "../../services/chat/codex-model";
import type { PermissionAnswer } from "../../services/chat/controller";
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
import type { PermissionRequest } from "../../services/chat/model";
import { fileLinkTarget, openBrowserBeside, openFileBeside } from "../../services/chat/open-beside";
import { imagesOf, outsideLinksOf } from "../../services/chat/panel";
import { printRunRows, useAgentAsk, usePrintRuns } from "../../services/chat/print-runs";
import { revertChangedFile } from "../../services/chat/revert-file";
import { runCodexCommand } from "../../services/chat/run-codex-command";
import { type ChatTabState, revealPart, useChatTab } from "../../services/chat/store";
import { codexUsageLine } from "../../services/chat/usage-line";
import { registerTabFocusTarget } from "../../services/tab-focus";
import { openTerminal } from "../../services/terminal/open-terminal";
import { queueStartupInput } from "../../services/terminal/pty-client";
import { agentCommandLine } from "../../services/workspace/tasks";
import { localUrlFor } from "../../state/operations/ports";
import { dropAgentAsk } from "../../state/stores/agent-reveal";
import { useChatFontStyle } from "../../state/stores/chat-font";
import { grantOutside } from "../../state/stores/outside-grants";
import type { CodexTabProps } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { ProfileUsageChip } from "../agent-profiles/tab-profile";
import { Banner, type BannerAction } from "../ui/banner";
import { showToast } from "../ui/toast";
import { CodexIcon } from "./agent-icons";
import { AgentStrip } from "./agent-strip";
import { ChatAgentContext } from "./chat-agent";
import { type ChatLinks, ChatLinksContext } from "./chat-links";
import { CodexConfigDialog } from "./codex-config-dialog";
import { CommandCardView } from "./command-card";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { focusChatTab, PermissionCard } from "./permission-card";
import { PrintRunPane } from "./print-run-pane";
import { QuickLook, type QuickLookList } from "./quick-look";
import { CodexSessionList } from "./session-list";
import { StatusLine } from "./status-line";
import { toolSummary } from "./tool-row";
import { UsageLineView } from "./usage-line";

interface CodexTabViewProps {
  workspaceId: string;
  tabId: string;
  props: CodexTabProps;
  isVisible: boolean;
  /**
   * What the conversation keeps, where it is no tab of the tabs store (the
   * agent manager's): what owns it opens it.
   */
  hooks?: CodexTabHooks;
  /** What the thread is told at its start, beside Codex's own instructions. */
  developerInstructions?: string;
  /** Whether Codex takes the folder as trusted, its own rules applying. */
  trusted?: boolean;
}

/** From this width a file opens in a group beside the tab. */
const SPLIT_FROM_PX = 900;

export function CodexTabView({
  workspaceId,
  tabId,
  props,
  isVisible,
  hooks,
  developerInstructions,
  trusted,
}: CodexTabViewProps) {
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
        {
          workspaceId,
          tabId,
          cwd: props.cwd,
          threadId: props.threadId,
          ...(props.fork ? { fork: props.fork } : {}),
          ...(props.profileId ? { profileId: props.profileId } : {}),
          ...(developerInstructions ? { developerInstructions } : {}),
          ...(trusted ? { trusted } : {}),
        },
        hooks ?? codexTabHooks(workspaceId, tabId),
      ),
    [workspaceId, tabId],
  );
  const state = useChatTab(workspaceId, tabId);
  const model = state.model as CodexModel;
  const { tokens, rateLimits } = model;
  const usageLine = useMemo(
    () => codexUsageLine({ tokens, rateLimits }, Date.now()),
    [tokens, rateLimits],
  );

  // Opened the first time the tab is shown, so restored tabs in the
  // background start nothing until they are looked at.
  const opened = useRef(false);
  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    if (!hooks) void controller.open();
  }, [isVisible, controller, hooks]);

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
  const fontStyle = useChatFontStyle();
  // Brought to the front (its tab picked, the inbox, the agent view), it
  // takes the keyboard.
  useEffect(() => registerTabFocusTarget(tabId, () => focusChatTab(rootRef.current)), [tabId]);
  // What the conversation links opens over the tab, or beside it.
  const [look, setLook] = useState<QuickLookList | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  // /resume's list above the composer, with the words it was given.
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const profileId = props.profileId ?? defaultProfileId("codex");
  // The `/` menu: Codex's commands the tab runs, described in the app's words.
  const commands = useMemo(
    () => codexCommandsListed((name) => t(`chat.codex.commands.describe.${name}`)),
    [t],
  );
  // Under the empty conversation a failure shows there; from /resume, as a toast.
  const resumeThread = (
    threadId: string,
    title: string,
    fail: (message: string) => void = setResumeError,
  ) => {
    setResumeQuery(null);
    setResumeError(null);
    void controller.resumeThread(threadId, title).catch((err: Error) => fail(err.message));
  };
  const resumeFailed = (message: string) => {
    showToast({ kind: "error", message: t("chat.sessions.resume_failed", { message }) });
  };
  // A tab put out of sight takes its quick look with it.
  useEffect(() => {
    if (!isVisible) setLook(null);
  }, [isVisible]);
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
  const latest = useRef({ state, rootPath, outside });
  latest.current = { state, rootPath, outside };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab's state is read from `latest` when a link is followed
  const links = useMemo<ChatLinks>(() => {
    const cwd = props.cwd;
    const split = () => (rootRef.current?.clientWidth ?? 0) >= SPLIT_FROM_PX;
    /** Lets the previews read a file outside the workspace the tab grants none of yet. */
    const grant = (path: string) => {
      const { rootPath, outside } = latest.current;
      if (isUnder(path, rootPath) || outside.files.includes(path)) return;
      setLooked((paths) => (paths.includes(path) ? paths : [...paths, path]));
    };
    /** Quick look over the conversation's images, at `target`; `alone` when it is not among them. */
    const lookAt = (target: ShownImage, alone?: () => QuickLookList) => {
      const current = latest.current.state.model as CodexModel;
      const shown = imagesOf(current.items, current.tools, cwd, current.agentItems);
      void lookAtImage(shown, target, (files) =>
        filesThere(workspaceId, latest.current.rootPath, files),
      ).then((look) => {
        const list = look ?? alone?.();
        if (list) setLook(list);
      });
    };
    /** Shows a file alone, as a diff when the session changed it and the agent kept its original. */
    const showAlone = (path: string, line?: LineAt) => {
      grant(path);
      const current = latest.current.state.model as CodexModel;
      setLook({
        files: [path],
        index: 0,
        changes: originalsFor(current.originals, [path]),
        ...(line?.line ? { at: { path, line: line.line, column: line.column } } : {}),
      });
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
        follow(target, ({ path, ...line }) => {
          // An image steps through the conversation's images; any other file shows alone.
          if (fileKind(path) !== "image") return showAlone(path, line);
          grant(path);
          lookAt({ file: path });
        });
      },
      openChange: (path) => showAlone(path),
      openImages(images, index) {
        const image = images[index];
        if (image) lookAt({ image }, () => imageLook(images, index));
      },
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
      className="chat-font relative flex h-full flex-col bg-background"
      style={fontStyle}
      data-testid="codex-tab"
      data-chat-drop
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
          tabId={tabId}
          cwd={props.cwd}
          rootPath={rootPath}
          history={null}
          model={state.model}
          empty={
            state.phase === "ready" || state.phase === "ended" ? (
              <div className="my-auto flex flex-col items-center gap-2 py-4 text-center text-muted-foreground">
                <CodexIcon className="size-8" />
                <div className="text-app-body">{t("chat.codex.empty")}</div>
                <div className="max-w-full truncate font-mono text-app-micro" title={props.cwd}>
                  {props.cwd}
                </div>
                {resumeError && (
                  <div className="text-app-ui-sm text-[var(--state-error-fg)]">
                    {t("chat.sessions.resume_failed", { message: resumeError })}
                  </div>
                )}
                {state.phase === "ready" && (
                  <CodexSessionList
                    workspaceId={workspaceId}
                    tabId={tabId}
                    controller={controller}
                    profileId={profileId}
                    onResume={(threadId, _profile, title) => resumeThread(threadId, title)}
                  />
                )}
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
        commands={commands}
        placeholder={shown ? t("chat.strip.input_to_main") : undefined}
        above={
          resumeQuery !== null ? (
            <CodexSessionList
              workspaceId={workspaceId}
              tabId={tabId}
              controller={controller}
              profileId={profileId}
              query={resumeQuery}
              onClose={() => setResumeQuery(null)}
              onResume={(threadId, _profile, title) => resumeThread(threadId, title, resumeFailed)}
            />
          ) : (
            state.card && (
              <CommandCardView
                card={state.card}
                workspaceId={workspaceId}
                cwd={props.cwd}
                rootPath={rootPath}
                onClose={() => controller.closeCard()}
              />
            )
          )
        }
        below={
          <UsageLineView
            line={usageLine}
            trailing={
              hooks ? undefined : (
                <ProfileUsageChip
                  agent="codex"
                  workspaceId={workspaceId}
                  cwd={props.cwd}
                  profileId={props.profileId}
                />
              )
            }
          />
        }
        onCommand={(text) => {
          // A bare /config (or /settings) opens the defaults.
          if (/^\/(config|settings)$/i.test(text.trim())) {
            setConfigOpen(true);
            return true;
          }
          // /resume lists the folder's threads, to go on with one here.
          if (parseAppCommand(text, [])?.name === "resume") {
            if (state.model.running) {
              showToast({ kind: "warning", message: t("chat.commands.resume_busy") });
            } else setResumeQuery(text.trim().replace(/^\/\S+\s*/, ""));
            return true;
          }
          // A bare /model or /effort opens its menu, as Codex's own does.
          const part = revealOf(text, ["model", "effort"]);
          if (part) {
            revealPart(controller.key, part);
            return true;
          }
          // The rest of Codex's commands the tab runs; anything else goes to
          // the model as typed.
          const command = parseCodexCommand(text);
          if (!command || ["model", "effort", "config", "resume"].includes(command.name)) {
            return false;
          }
          const { history, model } = state;
          runCodexCommand(command, {
            controller,
            workspaceId,
            tabId,
            cwd: props.cwd,
            rootPath,
            ...(props.profileId ? { profileId: props.profileId } : {}),
            items: history ? [...history.items, ...model.items] : model.items,
            tools: history ? { ...history.tools, ...model.tools } : model.tools,
            summarize: (tool) => toolSummary(tool, props.cwd),
            openFileTab: links.openFileTab,
          }).catch((err: Error) => showToast({ kind: "error", message: err.message }));
          return true;
        }}
      />
      <CodexConfigDialog
        controller={controller}
        state={state}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      />
      {look && (
        <QuickLook
          workspaceId={workspaceId}
          list={look}
          area={lookAreaOf(rootRef.current)}
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
