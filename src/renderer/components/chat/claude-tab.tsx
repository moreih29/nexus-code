// A Claude tab: one Claude Code session run headless by the workspace's
// agent, shown as a conversation. The program outlives the window and the
// connection, so the view only reads what its controller has.

import {
  ArrowLeft,
  Bot,
  ListChecks,
  PanelRightClose,
  PanelRightOpen,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { claudeTabHooks } from "../../services/chat/agent-tab";
import { parseAppCommand, revealOf } from "../../services/chat/app-commands";
import { configCommandOf } from "../../services/chat/claude-config";
import {
  type ChatController,
  type ChatTabHooks,
  chatController,
  type PermissionAnswer,
  pruneAttachmentsOnce,
} from "../../services/chat/controller";
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
import type { AssistantItem, PermissionRequest, UserItem } from "../../services/chat/model";
import {
  fileLinkTarget,
  openBrowserBeside,
  openFileBeside,
  revealTabById,
} from "../../services/chat/open-beside";
import {
  type AgentRow,
  agentsOf,
  agentTranscript,
  changedFilesOf,
  contextOf,
  imagesOf,
  jobOutputFiles,
  jobsOf,
  outsideLinksOf,
  todosOf,
} from "../../services/chat/panel";
import { usePlanUsage } from "../../services/chat/plan-usage";
import {
  printRunRows,
  stopPrintRun,
  useAgentAsk,
  usePrintRuns,
} from "../../services/chat/print-runs";
import { rateLimitKey, rateLimitNotice } from "../../services/chat/rate-limit";
import { revertChangedFile } from "../../services/chat/revert-file";
import { runAppCommand } from "../../services/chat/run-app-command";
import {
  type ChatTabState,
  type ComposerDraft,
  chatKey,
  type RevealPart,
  revealPart,
  useChatStore,
  useChatTab,
} from "../../services/chat/store";
import { useTerminalTwin } from "../../services/chat/terminal-twin";
import { claudeUsageLine } from "../../services/chat/usage-line";
import { MIN_CLAUDE_VERSION } from "../../services/chat/versions";
import { useNow } from "../../services/sessions/use-family";
import { registerTabFocusTarget } from "../../services/tab-focus";
import { localUrlFor } from "../../state/operations/ports";
import { openClaudeTab } from "../../state/operations/tabs";
import { dropAgentAsk } from "../../state/stores/agent-reveal";
import { useChatFontStyle } from "../../state/stores/chat-font";
import { useNotificationsStore } from "../../state/stores/notifications";
import { grantOutside } from "../../state/stores/outside-grants";
import type { ClaudeTabProps } from "../../state/stores/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { ProfileUsageChip, type TabUse } from "../agent-profiles/tab-profile";
import { Banner, type BannerAction } from "../ui/banner";
import { ContextRing } from "../ui/context-ring";
import { showToast } from "../ui/toast";
import { ClaudeIcon } from "./agent-icons";
import { AgentStrip } from "./agent-strip";
import { type ChatLinks, ChatLinksContext } from "./chat-links";
import { CommandCardView } from "./command-card";
import { Composer } from "./composer";
import { ConfigDialog } from "./config-dialog";
import { closeGoalBar, GoalBar, useTabGoal } from "./goal-bar";
import { type CallReveal, type MessageActions, MessageList } from "./message-list";
import { focusChatTab, PermissionCard } from "./permission-card";
import { PrintRunPane } from "./print-run-pane";
import { QuickLook, type QuickLookList } from "./quick-look";
import { RewindDialog } from "./rewind-dialog";
import { SessionList } from "./session-list";
import { SidePanel } from "./side-panel";
import { StatusLine } from "./status-line";
import { toolSummary } from "./tool-row";
import { UsageLineView } from "./usage-line";

interface ClaudeTabViewProps {
  workspaceId: string;
  tabId: string;
  props: ClaudeTabProps;
  isVisible: boolean;
  /**
   * What the conversation keeps, where it is no tab of the tabs store (the
   * agent manager's): what owns it opens it, and it forks into no tab.
   */
  hooks?: ChatTabHooks;
}

/** From this width the side panel sits beside the conversation. */
const PANEL_BESIDE_PX = 900;
/** Below this width the tab shows a one-line summary in place of the strip. */
const SUMMARY_BELOW_PX = 520;

/** Whether the side panel is open where it sits beside the conversation. */
const PANEL_PREF_KEY = "nexus.claude-tab.panel";

type PanelPlace = "beside" | "drawer" | "summary";

/** The parts a bare command asks for that are in the side panel. */
const PANEL_PARTS: ReadonlySet<RevealPart> = new Set(["context", "usage", "mcp", "status", "jobs"]);

function placeFor(width: number): PanelPlace {
  if (width >= PANEL_BESIDE_PX) return "beside";
  if (width >= SUMMARY_BELOW_PX) return "drawer";
  return "summary";
}

function readPanelPref(): boolean {
  try {
    return localStorage.getItem(PANEL_PREF_KEY) !== "closed";
  } catch {
    return true;
  }
}

function writePanelPref(open: boolean): void {
  try {
    localStorage.setItem(PANEL_PREF_KEY, open ? "open" : "closed");
  } catch {
    // Not kept: the panel opens by default next time.
  }
}

export function ClaudeTabView({ workspaceId, tabId, props, isVisible, hooks }: ClaudeTabViewProps) {
  const { t } = useTranslation();
  const rootPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const isLocal = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location.kind === "local",
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target is read once; the controller keeps the session it moves on to
  const controller = useMemo(
    () =>
      chatController(
        {
          workspaceId,
          tabId,
          cwd: props.cwd,
          sessionId: props.sessionId,
          fork: props.fork,
          ...(props.profileId ? { profileId: props.profileId } : {}),
        },
        hooks ?? claudeTabHooks(workspaceId, tabId),
      ),
    [workspaceId, tabId],
  );
  const state = useChatTab(workspaceId, tabId);
  const goal = useTabGoal(workspaceId, tabId);
  const { contextUsage } = state.model;
  // The plan's usage is the profile's, one for all its tabs; the tab's own
  // answer until the profile has one.
  const plan = usePlanUsage("claude", workspaceId, props.profileId);
  const usage = plan?.claude ?? state.model.usage;
  // A minute's clock, so a window that resets leaves the line while it shows.
  const now = useNow(isVisible, 60_000);
  const usageLine = useMemo(
    () => claudeUsageLine({ contextUsage, usage }, now),
    [contextUsage, usage, now],
  );

  // The line under the composer: the context and the plan's usage when the
  // tab is shown or its program comes up. The controller asks again after
  // each turn by itself, and the profile's store says when the usage is due.
  const lineReady = state.phase === "ready" && state.model.process === "running";
  useEffect(() => {
    if (isVisible && lineReady) controller.refreshUsageLine();
  }, [controller, isVisible, lineReady]);

  // Opened the first time the tab is shown, so restored tabs in the
  // background start nothing until they are looked at.
  const opened = useRef(false);
  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    if (hooks) return;
    void controller.open();
    const tabs = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
    const open = Object.values(tabs).filter((tab) => tab.type === "claude");
    pruneAttachmentsOnce(
      workspaceId,
      open.map((tab) => tab.id),
    );
  }, [isVisible, controller, workspaceId, hooks]);

  // A name the user gives the tab names its session too, as /rename does.
  const customTitle = useTabsStore((s) => s.byWorkspace[workspaceId]?.[tabId]?.customTitle);
  const named = useRef(customTitle);
  useEffect(() => {
    if (customTitle === named.current) return;
    named.current = customTitle;
    if (customTitle) void controller.renameSession(customTitle).catch(() => {});
  }, [customTitle, controller]);

  const [resumeError, setResumeError] = useState<string | null>(null);
  // Under the empty conversation a failure shows there; from /resume, as a toast.
  const resumeSession = (
    sessionId: string,
    profileId?: string,
    fail: (message: string) => void = setResumeError,
  ) => {
    setResumeError(null);
    void controller.resumeSession(sessionId, profileId).catch((err: Error) => fail(err.message));
  };
  // Another profile starts the tab over; what it has going decides whether to ask.
  const tabUse: TabUse = state.model.running
    ? "running"
    : (state.history?.items.length ?? 0) > 0 || state.model.items.length > 0
      ? "conversation"
      : "empty";
  const switchProfile = (profileId: string) => {
    setResumeError(null);
    void controller
      .switchProfile(profileId)
      .catch((err: Error) => showToast({ kind: "error", message: err.message }));
  };
  const resumeFailed = (message: string) => {
    showToast({ kind: "error", message: t("chat.sessions.resume_failed", { message }) });
  };

  const onAnswer = (request: PermissionRequest, answer: PermissionAnswer) => {
    void controller.answerPermission(request, answer).catch(() => {});
  };

  const [rewinding, setRewinding] = useState<UserItem | null>(null);
  // Kept while what it says holds, so the conversation's messages do not
  // all render each time the tab does.
  const running = state.model.running;
  const canFork = !hooks && controller.forkPoint("", { before: false }) !== null;
  const asking = state.model.permissions;
  // Set below, where the agents are known; read when a row renders.
  const taskShower = useRef<NonNullable<MessageActions["taskShower"]>>(() => undefined);
  const actions = useMemo<MessageActions>(
    () => ({
      running,
      canFork,
      onRewind: (item) => setRewinding(item),
      ...(hooks ? {} : { onFork: (item) => forkFrom(controller, workspaceId, props.cwd, item) }),
      onBackground: (toolUseId) =>
        controller
          .backgroundTool(toolUseId)
          .catch((err: Error) => showToast({ kind: "error", message: err.message })),
      waiting: new Set(asking.flatMap((p) => (p.toolUseId ? [p.toolUseId] : []))),
      taskShower: (item) => taskShower.current(item),
    }),
    [running, canFork, hooks, controller, workspaceId, props.cwd, asking],
  );

  // Where the side panel goes follows the tab's width.
  const rootRef = useRef<HTMLDivElement>(null);
  const fontStyle = useChatFontStyle();
  // Brought to the front (its tab picked, the inbox, the agent view), it
  // takes the keyboard.
  useEffect(() => registerTabFocusTarget(tabId, () => focusChatTab(rootRef.current)), [tabId]);
  const [place, setPlace] = useState<PanelPlace>("beside");
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setPlace(placeFor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [besideOpen, setBesideOpen] = useState(readPanelPref);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const panelOpen = place === "beside" ? besideOpen : drawerOpen;
  const togglePanel = () => {
    if (place === "beside") {
      writePanelPref(!besideOpen);
      setBesideOpen(!besideOpen);
    } else setDrawerOpen((v) => !v);
  };
  useEffect(() => {
    if (place === "beside") setDrawerOpen(false);
  }, [place]);
  // The drawer covers the composer, so it takes the keyboard while open:
  // Escape closes it from there. Closed, the keyboard goes back to where it
  // was (the composer a bare /context was typed in), unless the user has
  // put it somewhere else meanwhile.
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawerOpen || !drawer) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!drawer.contains(document.activeElement)) drawer.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const dropped = now === null || now === document.body || drawer.contains(now);
      if (dropped && back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [drawerOpen]);
  // A bare /context, /usage or /mcp, or /status, opens the panel; its section opens itself.
  const reveal = state.reveal;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, where the panel then is
  useEffect(() => {
    if (!reveal || !PANEL_PARTS.has(reveal.part)) return;
    if (place !== "beside") setDrawerOpen(true);
    else if (!besideOpen) {
      writePanelPref(true);
      setBesideOpen(true);
    }
  }, [reveal?.seq]);

  // The pane shows main or one agent's transcript, or a `claude -p` run the
  // session started; input always goes to main.
  const printRuns = usePrintRuns(workspaceId, tabId, isVisible);
  const runRows = useMemo(() => printRunRows(printRuns), [printRuns]);
  const agents = useMemo(() => [...agentsOf(state.model), ...runRows], [state.model, runRows]);
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = shownId ? agents.find((a) => a.toolUseId === shownId) : undefined;
  useEffect(() => {
    if (shownId && !shown) setShownId(null);
  }, [shownId, shown]);
  const showAgent = (toolUseId: string | null) => {
    setShownId(toolUseId);
    if (place !== "beside") setDrawerOpen(false);
    dropAgentAsk(tabId);
  };
  useAgentAsk(tabId, agents, showAgent);
  // A task's end in the conversation shows the task: an agent's transcript,
  // a job in the side panel. One the tab no longer knows (a conversation
  // resumed) has nothing to show.
  taskShower.current = (item) => {
    const task = state.model.tasks[item.taskId];
    const toolUseId = task?.toolUseId ?? item.toolUseId;
    if (toolUseId && agents.some((a) => a.toolUseId === toolUseId)) {
      return () => showAgent(toolUseId);
    }
    return task && jobsOf(state.model).includes(task)
      ? () => revealPart(controller.key, "jobs", item.taskId)
      : undefined;
  };
  // A call the side panel asked to see in the conversation, by its id; each ask its own seq.
  const [callAsk, setCallAsk] = useState<CallReveal | null>(null);
  const showCall = (toolUseId: string) => {
    showAgent(null);
    setCallAsk((prev) => ({ toolUseId, seq: (prev?.seq ?? 0) + 1 }));
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.key !== "[" && event.key !== "]") return;
    if (agents.length === 0) return;
    event.preventDefault();
    const order = [null, ...agents.map((a) => a.toolUseId)];
    const at = Math.max(0, order.indexOf(shown ? shown.toolUseId : null));
    const step = event.key === "]" ? 1 : -1;
    setShownId(order[(at + step + order.length) % order.length]);
  };

  // What the conversation links opens over the tab, or beside it.
  const [look, setLook] = useState<QuickLookList | null>(null);
  // A tab put out of sight takes its quick look with it.
  useEffect(() => {
    if (!isVisible) setLook(null);
  }, [isVisible]);
  // The previews may read what the tab links outside the workspace, while it is open.
  const [looked, setLooked] = useState<readonly string[]>([]);
  const outside = useMemo(() => {
    const { history, model } = state;
    const items = history ? [...history.items, ...model.items] : model.items;
    const tools = history ? { ...history.tools, ...model.tools } : model.tools;
    // The side panel shows the end of each job's output, from where the CLI writes it.
    return outsideLinksOf(items, tools, props.cwd, rootPath, [
      ...looked,
      ...jobOutputFiles(model, tools),
    ]);
  }, [state, props.cwd, rootPath, looked]);
  useEffect(() => {
    grantOutside(workspaceId, tabId, outside);
  }, [workspaceId, tabId, outside]);
  useEffect(
    () => () => grantOutside(workspaceId, tabId, { files: [], dirs: [] }),
    [workspaceId, tabId],
  );
  const latest = useRef({ state, place, rootPath, outside });
  latest.current = { state, place, rootPath, outside };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab's state is read from `latest` when a link is followed
  const links = useMemo<ChatLinks>(() => {
    const cwd = props.cwd;
    // Wide enough to share with a new group beside it.
    const split = () => latest.current.place === "beside";
    /** The file a link names, and where in it, once it is known which file that is. */
    const follow = (target: string, then: (link: FileLink) => void) => {
      const link = resolveFileLink(target, cwd);
      if (link) void fileLinkTarget(workspaceId, latest.current.rootPath, link).then(then);
    };
    /** Lets the previews read a file outside the workspace the tab grants none of yet. */
    const grant = (path: string) => {
      const { rootPath, outside } = latest.current;
      if (isUnder(path, rootPath) || outside.files.includes(path)) return;
      setLooked((paths) => (paths.includes(path) ? paths : [...paths, path]));
    };
    /** Quick look over the conversation's images, at `target`; `alone` when it is not among them. */
    const lookAt = (target: ShownImage, alone?: () => QuickLookList) => {
      const { state, rootPath } = latest.current;
      const { history, model } = state;
      const items = history ? [...history.items, ...model.items] : model.items;
      const tools = history ? { ...history.tools, ...model.tools } : model.tools;
      const shown = imagesOf(items, tools, cwd, model.agentItems);
      void lookAtImage(shown, target, (files) => filesThere(workspaceId, rootPath, files)).then(
        (look) => {
          const list = look ?? alone?.();
          if (list) setLook(list);
        },
      );
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
        const { history, model } = latest.current.state;
        const tools = history ? { ...history.tools, ...model.tools } : model.tools;
        const before = changedFilesOf(tools).find((file) => file.path === path)?.before;
        setLook({
          files: [path],
          index: 0,
          ...(before !== undefined ? { changes: { [path]: before } } : {}),
        });
      },
      openFileTab(target, at?: LineAt) {
        follow(target, ({ path, ...line }) => {
          const inside = isUnder(path, latest.current.rootPath);
          openFileBeside(workspaceId, tabId, path, { split: split(), inside, at: at ?? line });
        });
      },
      openUrl(url, other = false) {
        const local = isLocalAddress(url);
        if (local !== other) {
          // An SSH session's own address is the host's: the app's browser
          // opens it through the workspace's forward of its port.
          openBrowserBeside(workspaceId, tabId, url, { split: split() });
        } else if (local) {
          // In the system browser, at the forward's end here.
          void localUrlFor(workspaceId, url).then((here) => {
            if (here) window.open(here, "_blank", "noopener,noreferrer");
          });
        } else if (isExternalSchemeAllowed(url)) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
    };
  }, [workspaceId, tabId]);

  // Claude Code's settings (/config), and the one a command opened them at.
  const [config, setConfig] = useState<{ focus?: string } | null>(null);
  // /resume's list above the composer, with the words it was given.
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);

  /** Runs a message that is one of the tab's own commands (/copy, /btw…); false for one to send. */
  const runCommand = (text: string): boolean => {
    const opened = configCommandOf(text);
    if (opened) {
      setConfig(opened);
      return true;
    }
    const part = revealOf(text);
    if (part) {
      revealPart(controller.key, part);
      return true;
    }
    const command = parseAppCommand(text, state.model.init?.commands ?? []);
    if (!command) return false;
    if (command.name === "resume") {
      if (state.model.running) {
        showToast({ kind: "warning", message: t("chat.commands.resume_busy") });
      } else setResumeQuery(command.args);
      return true;
    }
    const { history, model } = state;
    runAppCommand(command, {
      controller,
      workspaceId,
      tabId,
      cwd: props.cwd,
      rootPath,
      items: history ? [...history.items, ...model.items] : model.items,
      tools: history ? { ...history.tools, ...model.tools } : model.tools,
      summarize: (tool) => toolSummary(tool, props.cwd),
      openFileTab: links.openFileTab,
      openUrl: (url) => links.openUrl(url),
    }).catch((err: Error) => showToast({ kind: "error", message: err.message }));
    return true;
  };

  const forkSession = () => {
    if (hooks) return;
    const point = controller.forkPoint("", { before: false });
    if (point) {
      openClaudeTab(workspaceId, {
        cwd: props.cwd,
        fork: { sessionId: point.sessionId },
        profileId: controller.profileId,
      });
    }
  };
  const panel = (
    <SidePanel
      controller={controller}
      state={state}
      workspaceId={workspaceId}
      cwd={props.cwd}
      rootPath={rootPath}
      runs={runRows}
      onStopRun={(agentId) => void stopPrintRun(workspaceId, tabId, agentId)}
      onShowAgent={showAgent}
      onShowCall={showCall}
      onForkSession={forkSession}
      className={place === "beside" ? "w-72 shrink-0 border-l border-border" : "h-full"}
    />
  );
  const permissions = state.model.permissions;

  const view = (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘[ and ⌘] step through the agents from anywhere in the tab
    <div
      ref={rootRef}
      className="chat-font relative flex h-full flex-col bg-background"
      style={fontStyle}
      data-testid="claude-tab"
      data-chat-drop
      onKeyDown={onKeyDown}
    >
      <PhaseBanner controller={controller} state={state} />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {place === "summary" ? (
            <>
              <SummaryLine state={state} runs={runRows} open={drawerOpen} onToggle={togglePanel} />
              {/* Too narrow for the agents' strip: the way back from one's transcript. */}
              {shown && (
                <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2 text-app-ui-sm">
                  <button
                    type="button"
                    onClick={() => showAgent(null)}
                    className="flex shrink-0 items-center gap-1 rounded-(--radius-control) px-1.5 py-0.5 font-medium hover:bg-[var(--state-hover-bg)]"
                    data-testid="chat-to-main"
                  >
                    <ArrowLeft className="size-3.5" aria-hidden />
                    {t("chat.strip.to_main")}
                  </button>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {shown.description}
                  </span>
                </div>
              )}
            </>
          ) : (
            <AgentStrip
              agents={agents}
              shown={shown ? shown.toolUseId : null}
              onShow={showAgent}
              panel={{ open: panelOpen, onToggle: togglePanel }}
            />
          )}
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
              history={state.history}
              model={state.model}
              actions={shown ? undefined : actions}
              items={shown ? agentTranscript(state.model, shown) : undefined}
              reveal={shown ? null : callAsk}
              empty={
                state.phase === "ready" || state.phase === "ended" ? (
                  <div className="my-auto flex flex-col items-center gap-2 py-4 text-center text-muted-foreground">
                    <ClaudeIcon className="size-8" />
                    <div className="text-app-body">{t("chat.empty.title")}</div>
                    <div className="max-w-full truncate font-mono text-app-micro" title={props.cwd}>
                      {props.cwd}
                    </div>
                    {resumeError && (
                      <div className="text-app-ui-sm text-[var(--state-error-fg)]">
                        {t("chat.sessions.resume_failed", { message: resumeError })}
                      </div>
                    )}
                    <SessionList
                      workspaceId={workspaceId}
                      tabId={tabId}
                      cwd={props.cwd}
                      profileId={controller.profileId}
                      onResume={(sessionId, profileId) => resumeSession(sessionId, profileId)}
                    />
                  </div>
                ) : null
              }
            />
          )}
          {/* Docked over the composer, so a request is seen wherever the list is scrolled. */}
          {(permissions.length > 0 || state.model.running || goal) && (
            <div className="app-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 py-2">
              <div className="mx-auto flex max-w-[860px] flex-col gap-2">
                {goal && (
                  <GoalBar
                    tab={goal}
                    onClear={() => controller.clearGoal()}
                    onClose={() => closeGoalBar(workspaceId, tabId, goal.goal)}
                  />
                )}
                {permissions.length > 0 && shown && (
                  <div
                    className="flex items-center gap-2 rounded-(--radius-control) border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-2 py-1 text-app-ui-sm text-[var(--state-warning-fg)]"
                    role="status"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {t("chat.strip.permission_waiting")}
                    </span>
                    <button
                      type="button"
                      onClick={() => showAgent(null)}
                      className="shrink-0 rounded-(--radius-control) px-1.5 py-0.5 font-medium hover:bg-[var(--state-hover-bg)]"
                    >
                      {t("chat.strip.to_main")}
                    </button>
                  </div>
                )}
                {permissions.length > 0 && !shown && (
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
          <RateLimitBanner state={state} />
          <TwinBanner workspaceId={workspaceId} tabId={tabId} sessionId={state.model.sessionId} />
          <Composer
            controller={controller}
            state={state}
            local={isLocal}
            placeholder={shown ? t("chat.strip.input_to_main") : undefined}
            above={
              resumeQuery !== null ? (
                <SessionList
                  workspaceId={workspaceId}
                  tabId={tabId}
                  cwd={props.cwd}
                  profileId={controller.profileId}
                  query={resumeQuery}
                  exceptSessionId={controller.currentSession()}
                  onClose={() => setResumeQuery(null)}
                  onResume={(sessionId, profileId) => {
                    setResumeQuery(null);
                    resumeSession(sessionId, profileId, resumeFailed);
                  }}
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
            onCommand={runCommand}
            below={
              <UsageLineView
                line={usageLine}
                trailing={
                  hooks
                    ? undefined
                    : (compact) => (
                        <ProfileUsageChip
                          agent="claude"
                          workspaceId={workspaceId}
                          profileId={props.profileId}
                          use={tabUse}
                          onSwitch={switchProfile}
                          compact={compact}
                        />
                      )
                }
              />
            }
          />
        </div>
        {place === "beside" && besideOpen && panel}
        {place !== "beside" && drawerOpen && (
          <>
            <button
              type="button"
              aria-label={t("chat.panel.hide")}
              tabIndex={-1}
              className={cn(
                "absolute inset-x-0 bottom-0 z-10 cursor-default",
                place === "summary" ? "top-7" : "top-8",
              )}
              onClick={() => setDrawerOpen(false)}
            />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc closes the drawer */}
            <div
              ref={drawerRef}
              tabIndex={-1}
              className={cn(
                // Below the strip, whose toggle closes it again.
                "absolute right-0 bottom-0 z-20 border-l border-border bg-background outline-none",
                place === "summary" ? "top-7 w-full" : "top-8 w-80",
              )}
              onKeyDown={(event) => {
                if (event.key === "Escape") setDrawerOpen(false);
              }}
            >
              {panel}
            </div>
          </>
        )}
      </div>
      <RewindDialog
        controller={controller}
        item={rewinding}
        cwd={props.cwd}
        onClose={() => setRewinding(null)}
      />
      <ConfigDialog
        controller={controller}
        state={state}
        open={config !== null}
        focus={config?.focus}
        onClose={() => setConfig(null)}
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
            if (before !== undefined) void revertChangedFile(workspaceId, rootPath, path, before);
          }}
          revertBlocked={state.model.running ? t("chat.look.revert_busy") : undefined}
        />
      )}
    </div>
  );
  return <ChatLinksContext.Provider value={links}>{view}</ChatLinksContext.Provider>;
}

/**
 * Opens a new Claude tab from a message: one of Claude's keeps the
 * conversation up to it; one of the user's keeps what came before it and
 * puts the message in the new tab's composer.
 */
function forkFrom(
  controller: ChatController,
  workspaceId: string,
  cwd: string,
  item: UserItem | AssistantItem,
): void {
  if (!item.uuid) return;
  const user = item.kind === "user";
  const fork = controller.forkPoint(item.uuid, { before: user });
  if (!fork && !user) return;
  const tab = openClaudeTab(workspaceId, {
    cwd,
    ...(fork ? { fork } : {}),
    profileId: controller.profileId,
  });
  if (user) {
    const draft: ComposerDraft = { text: item.text, images: item.images, nonce: Date.now() };
    useChatStore.getState().update(chatKey(workspaceId, tab.id), (prev) => ({ ...prev, draft }));
  }
}

/**
 * The tab's state in one line, where it is too narrow for the strip and the
 * panel: its subagents, background jobs, to-dos and context, each an icon
 * and a number as the agents tab's rows tell them. It opens the panel.
 */
function SummaryLine({
  state,
  runs,
  open,
  onToggle,
}: {
  state: ChatTabState;
  /** The session's `claude -p` runs, counted with its agents. */
  runs: readonly AgentRow[];
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { model } = state;
  const facts: { key: string; icon: React.ReactNode; value: string; label: string }[] = [];
  const agents = [...agentsOf(model), ...runs].filter((a) => a.status === "running").length;
  if (agents > 0) {
    facts.push({
      key: "agents",
      icon: <Bot aria-hidden className="size-3 shrink-0" />,
      value: String(agents),
      label: t("chat.strip.summary.agents", { count: agents }),
    });
  }
  const jobs = jobsOf(model).filter((j) => j.status === "running").length;
  if (jobs > 0) {
    facts.push({
      key: "jobs",
      icon: <SquareTerminal aria-hidden className="size-3 shrink-0" />,
      value: String(jobs),
      label: t("chat.strip.summary.jobs", { count: jobs }),
    });
  }
  const todos = todosOf(model.tools);
  if (todos.length > 0) {
    const done = todos.filter((todo) => todo.status === "completed").length;
    facts.push({
      key: "todos",
      icon: <ListChecks aria-hidden className="size-3 shrink-0" />,
      value: `${done}/${todos.length}`,
      label: t("chat.strip.summary.todos", { done, total: todos.length }),
    });
  }
  const context = contextOf(model.contextUsage);
  if (context && context.maxTokens > 0) {
    const percent = Math.round((context.totalTokens / context.maxTokens) * 100);
    facts.push({
      key: "context",
      icon: <ContextRing percent={percent} />,
      value: `${percent}%`,
      label: t("chat.strip.summary.context", { percent }),
    });
  }
  const label = facts.length > 0 ? facts.map((fact) => fact.label).join(" · ") : undefined;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      title={label}
      className="flex h-7 shrink-0 items-center gap-3 border-b border-border px-3 text-left text-app-micro text-muted-foreground tabular-nums hover:text-foreground"
      data-testid="chat-summary-line"
    >
      {facts.length > 0 ? (
        facts.map((fact) => (
          <span key={fact.key} className="flex shrink-0 items-center gap-1">
            {fact.icon}
            {fact.value}
          </span>
        ))
      ) : (
        <span className="min-w-0 truncate">{t("chat.panel.show")}</span>
      )}
      {open ? (
        <PanelRightClose aria-hidden className="ml-auto size-3.5 shrink-0" />
      ) : (
        <PanelRightOpen aria-hidden className="ml-auto size-3.5 shrink-0" />
      )}
    </button>
  );
}

function PhaseBanner({ controller, state }: { controller: ChatController; state: ChatTabState }) {
  const { t } = useTranslation();
  const retry: BannerAction = {
    label: t("chat.phase.retry"),
    onAction: () => void controller.open(),
  };
  const banners: React.ReactNode[] = [];
  switch (state.phase) {
    case "starting":
      banners.push(<Banner key="phase" variant="info" message={t("chat.phase.starting")} />);
      break;
    case "held":
      banners.push(<Banner key="phase" variant="warning" message={t("chat.phase.held")} />);
      break;
    case "ended":
      banners.push(
        <Banner
          key="phase"
          variant="info"
          message={t("chat.phase.ended")}
          details={state.model.exit?.stderrTail || undefined}
          actions={[{ label: t("chat.phase.restart"), onAction: () => void controller.restart() }]}
        />,
      );
      break;
    case "not-found":
      banners.push(
        <Banner
          key="phase"
          variant="error"
          message={t("chat.phase.not_found")}
          details={state.error}
          actions={[retry]}
        />,
      );
      break;
    case "failed":
      banners.push(
        state.error === "old-version" ? (
          <Banner
            key="phase"
            variant="error"
            message={t("chat.phase.old_version", {
              version: state.version ?? "?",
              min: MIN_CLAUDE_VERSION,
            })}
            actions={[retry]}
          />
        ) : (
          <Banner
            key="phase"
            variant="error"
            message={t("chat.phase.failed")}
            details={state.error}
            actions={[retry]}
          />
        ),
      );
      break;
  }
  if (state.truncated) {
    banners.push(<Banner key="truncated" variant="info" message={t("chat.phase.truncated")} />);
  }
  if (banners.length === 0) return null;
  return <div className="shrink-0 pt-1">{banners}</div>;
}

/** Warns that the session is open in a terminal tab too, where going on forks it. */
function TwinBanner({
  workspaceId,
  tabId,
  sessionId,
}: {
  workspaceId: string;
  tabId: string;
  sessionId: string | undefined;
}) {
  const { t } = useTranslation();
  const twin = useTerminalTwin(workspaceId, tabId, sessionId);
  if (!twin) return null;
  return (
    <div className="shrink-0" data-testid="chat-terminal-twin">
      <Banner
        variant="warning"
        message={t("chat.twin.message")}
        actions={[{ label: t("chat.twin.show"), onAction: () => revealTabById(workspaceId, twin) }]}
      />
    </div>
  );
}

function RateLimitBanner({ state }: { state: ChatTabState }) {
  const { t } = useTranslation();
  const limit = state.model.rateLimit;
  const warnings = useNotificationsStore((s) => s.rateLimitWarnings);
  const dismissed = useNotificationsStore((s) => s.dismissedRateLimits);
  const notice = rateLimitNotice(limit, { warnings, dismissed });
  if (!limit || !notice) return null;
  const resets = limit.resetsAt
    ? new Date(limit.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const rejected = notice === "rejected";
  const message = rejected
    ? resets
      ? t("chat.rate_limit.rejected_until", { time: resets })
      : t("chat.rate_limit.rejected")
    : resets
      ? t("chat.rate_limit.warning_until", { time: resets })
      : t("chat.rate_limit.warning");
  // A warning closes until its limit resets; a limit reached stays up.
  const dismiss = rejected
    ? undefined
    : {
        label: t("chat.rate_limit.dismiss"),
        onDismiss: () => useNotificationsStore.getState().dismissRateLimit(rateLimitKey(limit)),
      };
  return (
    <div className="shrink-0" data-testid="chat-rate-limit">
      <Banner variant={rejected ? "error" : "warning"} message={message} dismiss={dismiss} />
    </div>
  );
}
