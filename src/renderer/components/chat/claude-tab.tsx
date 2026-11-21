// A Claude tab: one Claude Code session run headless by the workspace's
// agent, shown as a conversation. The program outlives the window and the
// connection, so the view only reads what its controller has.

import { ArrowLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { useStableHandlers } from "../../hooks/use-stable-handlers";
import { placeLocalFile, showHeldLocalFile } from "../../services/agent-view/file-tabs";
import { claudeTabHooks } from "../../services/chat/agent-tab";
import { parseAppCommand, revealOf } from "../../services/chat/app-commands";
import { useStateBesideStream } from "../../services/chat/beside-stream";
import { configCommandOf } from "../../services/chat/claude/config";
import {
  type ChatController,
  chatController,
  type PermissionAnswer,
  pruneAttachmentsOnce,
} from "../../services/chat/claude/controller";
import { historyForDisplay } from "../../services/chat/claude/history";
import {
  borrowedClaudeModels,
  useClaudeModelCatalog,
} from "../../services/chat/claude/model-catalog";
import { runAppCommand } from "../../services/chat/claude/run-command";
import { filesThere } from "../../services/chat/file-presence";
import {
  imageLook,
  latestReadFile,
  lookAtImage,
  type ShownImage,
} from "../../services/chat/image-look";
import { linkPlaceIndex } from "../../services/chat/link-places";
import {
  type FileLink,
  fileKind,
  isLocalAddress,
  isUnder,
  type LineAt,
} from "../../services/chat/links";
import { lookAreaOf } from "../../services/chat/look-area";
import type { AssistantItem, PermissionRequest, UserItem } from "../../services/chat/model";
import {
  followFileLink,
  openBrowserBeside,
  openFileBeside,
  revealTabById,
} from "../../services/chat/open-beside";
import {
  agentsOf,
  agentTranscript,
  changedFilesOf,
  imagesOf,
  jobOutputFiles,
  jobsOf,
  joinAgents,
  outsideLinksOf,
  pastAgentsOf,
} from "../../services/chat/panel";
import { registerPanelToggle } from "../../services/chat/panel-toggle";
import {
  printRunRows,
  stopPrintRun,
  useAgentAsk,
  usePrintRuns,
} from "../../services/chat/print-runs";
import { relayedOf, withRelayed } from "../../services/chat/relayed";
import { revertChangedFile } from "../../services/chat/revert-file";
import { jobToolStatuses } from "../../services/chat/running";
import {
  type ComposerDraft,
  chatKey,
  type RevealPart,
  revealPart,
  useChatStore,
  useChatTab,
} from "../../services/chat/store";
import { useTerminalTwin } from "../../services/chat/terminal-twin";
import { registerTabFocusTarget } from "../../services/tab-focus";
import { localUrlFor } from "../../state/operations/ports";
import { openClaudeTab } from "../../state/operations/tabs";
import { dropAgentAsk } from "../../state/stores/agent-reveal";
import { useChatFontStyle } from "../../state/stores/chat-font";
import { grantOutside } from "../../state/stores/outside-grants";
import type { ClaudeTabProps } from "../../state/stores/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { ProfileUsageChip, type TabUse } from "../agent-profiles/tab-profile";
import { Banner, BannerDismissButton } from "../ui/banner";
import { showToast } from "../ui/toast";
import { ClaudeIcon } from "./agent-icons";
import { AgentStrip, ShownState } from "./agent-strip";
import { ChatLinksContext, type LocalChatLinks } from "./chat-links";
import { ChatPhaseBanner } from "./chat-state-banner";
import { CommandCardView } from "./command-card";
import { Composer } from "./composer";
import { ConfigDialog } from "./config-dialog";
import { closeGoalBar, GoalBar, useTabGoal } from "./goal-bar";
import { LimitResumeBanner, showsLimitResume } from "./limit-resume-banner";
import { type CallReveal, type MessageActions, MessageList } from "./message-list";
import { type PanelPlace, placeFor, readPanelPref, writePanelPref } from "./panel-place";
import { focusChatTab, PermissionCard } from "./permission-card";
import { PrintRunPane } from "./print-run-pane";
import { QuickLook, type QuickLookList } from "./quick-look";
import { RateLimitBanner } from "./rate-limit-banner";
import { RewindDialog } from "./rewind-dialog";
import { surfaceChatSendError } from "./send-error";
import { SessionList } from "./session-list";
import { SidePanel } from "./side-panel";
import { StatusLine } from "./status-line";
import { SummaryLine, summaryCountsOf } from "./summary-line";
import { toolSummary } from "./tool-row";
import { TurnFailureBanner } from "./turn-failure-banner";
import { ClaudeUsageLine } from "./usage-line";

interface ClaudeTabViewProps {
  workspaceId: string;
  tabId: string;
  props: ClaudeTabProps;
  isVisible: boolean;
}

/** The parts a bare command asks for that are in the side panel. */
const PANEL_PARTS: ReadonlySet<RevealPart> = new Set(["context", "usage", "mcp", "status", "jobs"]);

export function ClaudeTabView({ workspaceId, tabId, props, isVisible }: ClaudeTabViewProps) {
  const instructionsTab = useMemo(() => ({ workspaceId, tabId }), [workspaceId, tabId]);
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
          ...(props.moves ? { moves: props.moves } : {}),
          ...(props.chosen ? { chosen: props.chosen } : {}),
        },
        claudeTabHooks(workspaceId, tabId),
      ),
    [workspaceId, tabId],
  );
  // Followed while shown: a tab in the background draws nothing per chunk
  // of a streaming reply, and shows the latest when it comes to the front.
  const state = useChatTab(workspaceId, tabId, isVisible);
  const bannerScope = ["chat", workspaceId, tabId, state.model.sessionId];
  // For the side panel and the composer, which show nothing of a streaming
  // reply's text: the same state while only that changes, so they and what
  // they hold do not render for each chunk of it.
  const steady = useStateBesideStream(state);
  const modelCatalogKey =
    isVisible && !steady.model.init?.models.length ? controller.modelCatalogKey : undefined;
  const fallbackModels = useClaudeModelCatalog((catalog) =>
    modelCatalogKey ? borrowedClaudeModels(catalog, modelCatalogKey, controller.key) : undefined,
  );
  const goal = useTabGoal(workspaceId, tabId);

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
    void controller.open();
    pruneAttachmentsOnce(workspaceId);
  }, [isVisible, controller, workspaceId]);

  // A name the user gives the tab names its session too, as /rename does,
  // and every session the tab has after it.
  const customTitle = useTabsStore((s) => s.byWorkspace[workspaceId]?.[tabId]?.customTitle);
  const named = useRef(customTitle);
  useEffect(() => {
    controller.keepName(customTitle);
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
  // What the tab has going decides what another profile offers.
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
  const continueInProfile = (profileId: string) => {
    setResumeError(null);
    void controller
      .continueInProfile(profileId)
      .catch((err: Error) => showToast({ kind: "error", message: err.message }));
  };
  const resumeFailed = (message: string) => {
    showToast({ kind: "error", message: t("chat.sessions.resume_failed", { message }) });
  };

  const onAnswer = (request: PermissionRequest, answer: PermissionAnswer) => {
    void controller.answerPermission(request, answer).catch(surfaceChatSendError);
  };

  const [rewinding, setRewinding] = useState<{
    item: UserItem;
    sessionId: string | undefined;
    clears: number | undefined;
  } | null>(null);
  if (
    rewinding &&
    (rewinding.sessionId !== controller.currentSession() || rewinding.clears !== state.model.clears)
  ) {
    setRewinding(null);
  }
  // Kept while what it says holds, so the conversation's messages do not
  // all render each time the tab does.
  const running = state.model.running;
  const canFork = controller.forkPoint("", { before: false }) !== null;
  const asking = state.model.permissions;
  const unverifiedStart = controller.unverifiedHistoryStart();
  // Set below, where the agents are known; read when a row renders.
  const taskShower = useRef<NonNullable<MessageActions["taskShower"]>>(() => undefined);
  const actions = useMemo<MessageActions>(
    () => ({
      running,
      canFork,
      canForkItem: (item) =>
        !!item.uuid &&
        (item.kind !== "user" || (item.state === "taken" && item.uuid !== unverifiedStart)),
      canRewindItem: (item) =>
        item.state === "taken" && !!item.uuid && item.uuid !== unverifiedStart,
      onRewind: (item) =>
        setRewinding({
          item,
          sessionId: controller.currentSession(),
          clears: controller.state.model.clears,
        }),
      onFork: (item) => forkFrom(controller, workspaceId, props.cwd, item),
      onBackground: (toolUseId) => backgroundCall(controller, toolUseId),
      waiting: new Set(asking.flatMap((p) => (p.toolUseId ? [p.toolUseId] : []))),
      taskShower: (item) => taskShower.current(item),
    }),
    [running, canFork, controller, workspaceId, props.cwd, asking, unverifiedStart],
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
  // ⌘⇧] toggles it too, while this tab is in front.
  const togglePanelRef = useRef(togglePanel);
  togglePanelRef.current = togglePanel;
  useEffect(() => registerPanelToggle(tabId, () => togglePanelRef.current()), [tabId]);
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
  // Its history's subagents too, which ended: a conversation resumed shows them.
  const pastHistory = state.history;
  const pastModel = useMemo(
    () => (pastHistory ? historyForDisplay(pastHistory) : null),
    [pastHistory],
  );
  const { tasks: agentTasks, tools: agentTools, agentItems, items: agentCalls } = state.model;
  const pastAgents = useMemo(() => (pastModel ? pastAgentsOf(pastModel) : []), [pastModel]);
  const liveAgents = useMemo(
    () => agentsOf({ tasks: agentTasks, tools: agentTools, agentItems, items: agentCalls }),
    [agentTasks, agentTools, agentItems, agentCalls],
  );
  const agents = useMemo(
    () => joinAgents(pastAgents, liveAgents, runRows),
    [pastAgents, liveAgents, runRows],
  );
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = shownId ? agents.find((a) => a.toolUseId === shownId) : undefined;
  useEffect(() => {
    if (shownId && !shown) setShownId(null);
  }, [shownId, shown]);
  // What the shown subagent wrote: its messages as the program's log has
  // them, else as the history read from its file.
  const pastAgentItems = pastModel?.agentItems;
  const shownWrote = shown
    ? (agentItems[shown.toolUseId] ?? pastAgentItems?.[shown.toolUseId])
    : undefined;
  const shownTranscript = useMemo(
    () =>
      shown && !shown.run
        ? agentTranscript(
            { agentItems: shownWrote ? { [shown.toolUseId]: shownWrote } : {} },
            shown,
          )
        : undefined,
    [shown, shownWrote],
  );
  // One that ended with none of its messages here, as a conversation read
  // from its transcript has it, is read from the file Claude Code keeps it in.
  const unread =
    shown && !shown.run && shown.status !== "running" && !shownWrote ? shown.toolUseId : null;
  useEffect(() => {
    if (unread) void controller.loadSubagent(unread);
  }, [controller, unread]);
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
  const history = state.history;
  const { items: liveItems, tools: liveTools, tasks } = state.model;
  const toolStatuses = useMemo(
    () => jobToolStatuses({ tasks, tools: liveTools, running }),
    [tasks, liveTools, running],
  );
  // Taken from the parts it reads, so a line that changes none of them (a
  // usage report, a turn's end) does not walk the whole session again.
  const outside = useMemo(() => {
    const items = history ? [...history.items, ...liveItems] : liveItems;
    const tools = history ? { ...history.tools, ...liveTools } : liveTools;
    // The side panel shows the end of each job's output, from where the CLI writes it.
    return outsideLinksOf(items, tools, props.cwd, rootPath, [
      ...looked,
      ...jobOutputFiles({ tasks }, tools),
    ]);
  }, [history, liveItems, liveTools, tasks, props.cwd, rootPath, looked]);
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
  const links = useMemo<LocalChatLinks>(() => {
    const cwd = props.cwd;
    // Wide enough to share with a new group beside it.
    const split = () => latest.current.place === "beside";
    /**
     * The file a link names, and where in it, once it is known which file
     * that is: from the tab's folder, or from where the agent's shell went.
     */
    const follow = (target: string, then: (link: FileLink) => void) => {
      const { state, rootPath } = latest.current;
      const { history, model } = state;
      const tools = history ? { ...history.tools, ...model.tools } : model.tools;
      void followFileLink(workspaceId, rootPath, target, linkPlaceIndex(tools, cwd)).then(
        (link) => link && then(link),
      );
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
      // The last read of a file a panel holds selects the panel; an earlier one shows as it was read.
      const held = target.image ? latestReadFile(shown, target) : undefined;
      if (held && showHeldLocalFile(workspaceId, held)) {
        setLook(null);
        return;
      }
      void lookAtImage(shown, target, (files) => filesThere(workspaceId, rootPath, files)).then(
        (look) => {
          // What shows from its data opens its file by path (as a tab, beside, in Finder): let that read it.
          for (const path of Object.values(look?.paths ?? {})) grant(path);
          const list = look ?? alone?.();
          if (list) setLook(list);
        },
      );
    };
    return {
      openFile(target) {
        follow(target, ({ path, ...line }) => {
          grant(path);
          if (showHeldLocalFile(workspaceId, path, line)) {
            setLook(null);
            return;
          }
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
        if (showHeldLocalFile(workspaceId, path)) {
          setLook(null);
          return;
        }
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
    const command = parseAppCommand(
      text,
      state.model.init?.commands ?? state.model.slashCommands ?? [],
    );
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
      items: withRelayed(
        history ? [...history.items, ...model.items] : model.items,
        relayedOf(props),
      ),
      tools: history ? { ...history.tools, ...model.tools } : model.tools,
      summarize: (tool) => toolSummary(tool, props.cwd),
      openFileTab: links.openFileTab,
      openUrl: (url) => links.openUrl(url),
    }).catch((err: Error) => showToast({ kind: "error", message: err.message }));
    return true;
  };

  const forkSession = () => {
    const point = controller.forkPoint("", { before: false });
    if (point) {
      openClaudeTab(workspaceId, {
        cwd: props.cwd,
        fork: { sessionId: point.sessionId },
        ...controller.inherited(),
      });
    }
  };
  // The same functions throughout, for the memoized side panel and
  // composer; each call runs what the latest render made.
  const stable = useStableHandlers({
    stopRun: (agentId: string) => void stopPrintRun(workspaceId, tabId, agentId),
    background: (toolUseId: string) => backgroundCall(controller, toolUseId),
    showAgent,
    showCall,
    forkSession,
    runCommand,
    switchProfile,
    continueInProfile,
  });
  const panel = (
    <SidePanel
      controller={controller}
      state={steady}
      workspaceId={workspaceId}
      cwd={props.cwd}
      rootPath={rootPath}
      agents={agents}
      onStopRun={stable.stopRun}
      onShowAgent={stable.showAgent}
      onShowCall={stable.showCall}
      onBackground={stable.background}
      onForkSession={stable.forkSession}
      className={place === "beside" ? "w-72 shrink-0 border-l border-border" : "h-full"}
    />
  );
  const permissions = state.model.permissions;
  // Made again only when what it shows changes, so the composer it goes in
  // need not render.
  const { contextUsage, usage } = state.model;
  const usageLine = useMemo(
    () => (
      <ClaudeUsageLine
        workspaceId={workspaceId}
        profileId={props.profileId}
        visible={isVisible}
        contextUsage={contextUsage}
        usage={usage}
        trailing={(compact) => (
          <ProfileUsageChip
            agent="claude"
            workspaceId={workspaceId}
            profileId={props.profileId}
            use={tabUse}
            onSwitch={stable.switchProfile}
            onContinue={stable.continueInProfile}
            compact={compact}
          />
        )}
      />
    ),
    [workspaceId, props.profileId, isVisible, contextUsage, usage, tabUse, stable],
  );

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
      <ChatPhaseBanner
        scope={bannerScope}
        status={{
          agent: "claude",
          process: state.model.process,
          phase: state.phase,
          error: state.error,
          version: state.version,
          exit: state.model.exit,
          phaseRevision: state.phaseRevision,
        }}
        onRestart={() => void controller.restart()}
        onRetry={() => void controller.open()}
        className="shrink-0 pt-1"
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {place === "summary" ? (
            <>
              <SummaryLine
                counts={summaryCountsOf(state.model, runRows)}
                open={drawerOpen}
                onToggle={togglePanel}
              />
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
                  <ShownState agent={shown} />
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
              history={pastModel}
              model={state.model}
              toolStatuses={toolStatuses}
              actions={shown ? undefined : actions}
              items={shownTranscript}
              reveal={shown ? null : callAsk}
              moves={props.moves}
              relayed={relayedOf(props)}
              historyTruncated={!shown && state.truncated}
              older={
                !shown && state.historyPage
                  ? {
                      ...state.historyPage,
                      load: () =>
                        void controller
                          .loadEarlier()
                          .catch((error: Error) =>
                            showToast({ kind: "error", message: error.message }),
                          ),
                    }
                  : undefined
              }
              empty={
                state.phase === "ready" || state.phase === "ended" ? (
                  <div className="my-auto flex flex-col items-center gap-2 py-4 text-center text-muted-foreground">
                    <ClaudeIcon className="size-8" />
                    <div className="text-app-body">{t("chat.empty.title")}</div>
                    <div className="max-w-full truncate font-mono text-app-micro" title={props.cwd}>
                      {props.cwd}
                    </div>
                    {resumeError && (
                      <div className="flex items-center gap-2 text-app-ui-sm text-[var(--state-error-fg)]">
                        <span className="flex-1">
                          {t("chat.sessions.resume_failed", { message: resumeError })}
                        </span>
                        <BannerDismissButton
                          dismiss={{
                            label: t("action.dismiss"),
                            onDismiss: () => setResumeError(null),
                          }}
                        />
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
          {showsLimitResume(props.limitResume) ? (
            <LimitResumeBanner workspaceId={workspaceId} tabId={tabId} record={props.limitResume} />
          ) : (
            <RateLimitBanner scope={bannerScope} limit={state.model.rateLimit} />
          )}
          <TurnFailureBanner
            scope={bannerScope}
            model={state.model}
            onRetry={(text) => controller.send(text)}
          />
          <TwinBanner workspaceId={workspaceId} tabId={tabId} sessionId={state.model.sessionId} />
          <Composer
            instructionsTab={instructionsTab}
            controller={controller}
            state={steady}
            fallbackModels={fallbackModels}
            relayed={relayedOf(props)}
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
            onCommand={stable.runCommand}
            below={usageLine}
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
        item={rewinding?.item ?? null}
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
          onOpenBeside={(path, { at }) => {
            setLook(null);
            placeLocalFile(workspaceId, tabId, path, isUnder(path, rootPath), at);
          }}
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

/** Sends a call the turn waits on to the background, as Ctrl+B does in the terminal. */
function backgroundCall(controller: ChatController, toolUseId: string): void {
  controller
    .backgroundTool(toolUseId)
    .catch((err: Error) => showToast({ kind: "error", message: err.message }));
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
    ...controller.inherited(),
  });
  if (user) {
    const draft: ComposerDraft = { text: item.text, images: item.images, nonce: Date.now() };
    useChatStore.getState().update(chatKey(workspaceId, tab.id), (prev) => ({ ...prev, draft }));
  }
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
  const { dismiss, dismissed } = useBannerDismissal(
    ["chat-terminal-twin", workspaceId, tabId, sessionId],
    twin ? [twin] : undefined,
    true,
  );
  if (!twin || dismissed) return null;
  return (
    <div className="shrink-0" data-testid="chat-terminal-twin">
      <Banner
        variant="warning"
        message={t("chat.twin.message")}
        dismiss={dismiss}
        actions={[{ label: t("chat.twin.show"), onAction: () => revealTabById(workspaceId, twin) }]}
      />
    </div>
  );
}
