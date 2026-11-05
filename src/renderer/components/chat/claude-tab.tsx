// A Claude tab: one Claude Code session run headless by the workspace's
// agent, shown as a conversation. The program outlives the window and the
// connection, so the view only reads what its controller has.

import { MessageSquareText } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import {
  type ChatController,
  chatController,
  type PermissionAnswer,
  pruneAttachmentsOnce,
} from "../../services/chat/controller";
import { isLocalAddress, isUnder, resolveFilePath, resultFiles } from "../../services/chat/links";
import type { AssistantItem, PermissionRequest, UserItem } from "../../services/chat/model";
import { openBrowserBeside, openFileBeside } from "../../services/chat/open-beside";
import {
  agentsOf,
  agentTranscript,
  changedFilesOf,
  contextOf,
  jobsOf,
  outsideLinksOf,
  resultsOf,
  todosOf,
} from "../../services/chat/panel";
import { revertChangedFile } from "../../services/chat/revert-file";
import {
  type ChatTabState,
  type ComposerDraft,
  chatKey,
  useChatStore,
  useChatTab,
} from "../../services/chat/store";
import { MIN_CLAUDE_VERSION } from "../../services/chat/versions";
import { openClaudeTab } from "../../state/operations/tabs";
import { grantOutside } from "../../state/stores/outside-grants";
import type { ClaudeTabProps } from "../../state/stores/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { Banner, type BannerAction } from "../ui/banner";
import { showToast } from "../ui/toast";
import { AgentStrip } from "./agent-strip";
import { type ChatLinks, ChatLinksContext } from "./chat-links";
import { Composer } from "./composer";
import { type MessageActions, MessageList } from "./message-list";
import { PermissionCard } from "./permission-card";
import { QuickLook, type QuickLookList } from "./quick-look";
import { RewindDialog } from "./rewind-dialog";
import { SidePanel } from "./side-panel";
import { StatusLine } from "./status-line";

interface ClaudeTabViewProps {
  workspaceId: string;
  tabId: string;
  props: ClaudeTabProps;
  isVisible: boolean;
}

/** Longest first message kept as the tab's title. */
const TITLE_CHARS = 40;

/** From this width the side panel sits beside the conversation. */
const PANEL_BESIDE_PX = 900;
/** Below this width the tab shows a one-line summary in place of the strip. */
const SUMMARY_BELOW_PX = 520;

/** Whether the side panel is open where it sits beside the conversation. */
const PANEL_PREF_KEY = "nexus.claude-tab.panel";

type PanelPlace = "beside" | "drawer" | "summary";

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

export function ClaudeTabView({ workspaceId, tabId, props, isVisible }: ClaudeTabViewProps) {
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
        },
        {
          onSession: (sessionId) =>
            useTabsStore.getState().setClaudeSession(workspaceId, tabId, sessionId),
          onTarget: (target) => useTabsStore.getState().setClaudeTarget(workspaceId, tabId, target),
          onFirstMessage: (text) =>
            useTabsStore.getState().setProcessTitle(workspaceId, tabId, titleOf(text)),
        },
      ),
    [workspaceId, tabId],
  );
  const state = useChatTab(workspaceId, tabId);

  // Opened the first time the tab is shown, so restored tabs in the
  // background start nothing until they are looked at.
  const opened = useRef(false);
  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    void controller.open();
    const tabs = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
    const open = Object.values(tabs).filter((tab) => tab.type === "claude");
    pruneAttachmentsOnce(
      workspaceId,
      open.map((tab) => tab.id),
    );
  }, [isVisible, controller, workspaceId]);

  const onAnswer = (request: PermissionRequest, answer: PermissionAnswer) => {
    void controller.answerPermission(request, answer).catch(() => {});
  };

  const [rewinding, setRewinding] = useState<UserItem | null>(null);
  const actions: MessageActions = {
    running: state.model.running,
    canFork: controller.forkPoint("", { before: false }) !== null,
    onRewind: (item) => setRewinding(item),
    onFork: (item) => forkFrom(controller, workspaceId, props.cwd, item),
  };

  // Where the side panel goes follows the tab's width.
  const rootRef = useRef<HTMLDivElement>(null);
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

  // The pane shows main or one agent's transcript; input always goes to main.
  const agents = useMemo(() => agentsOf(state.model), [state.model]);
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = shownId ? agents.find((a) => a.toolUseId === shownId) : undefined;
  useEffect(() => {
    if (shownId && !shown) setShownId(null);
  }, [shownId, shown]);
  const showAgent = (toolUseId: string | null) => {
    setShownId(toolUseId);
    if (place !== "beside") setDrawerOpen(false);
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
  // The previews may read what the tab links outside the workspace, while it is open.
  const [looked, setLooked] = useState<readonly string[]>([]);
  const outside = useMemo(() => {
    const { history, model } = state;
    const items = history ? [...history.items, ...model.items] : model.items;
    const tools = history ? { ...history.tools, ...model.tools } : model.tools;
    return outsideLinksOf(items, tools, props.cwd, rootPath, looked);
  }, [state, props.cwd, rootPath, looked]);
  useEffect(() => {
    grantOutside(workspaceId, tabId, outside);
  }, [workspaceId, tabId, outside]);
  useEffect(
    () => () => grantOutside(workspaceId, tabId, { files: [], dirs: [] }),
    [workspaceId, tabId],
  );
  const latest = useRef({ state, place, rootPath, isLocal });
  latest.current = { state, place, rootPath, isLocal };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab's state is read from `latest` when a link is followed
  const links = useMemo<ChatLinks>(() => {
    const cwd = props.cwd;
    // Wide enough to share with a new group beside it.
    const split = () => latest.current.place === "beside";
    return {
      openFile(target) {
        const path = resolveFilePath(target, cwd);
        if (!path) return;
        const { history, model } = latest.current.state;
        const items = history ? [...history.items, ...model.items] : model.items;
        const tools = history ? { ...history.tools, ...model.tools } : model.tools;
        const files = resultFiles(resultsOf(items, tools), cwd);
        const at = files.indexOf(path);
        if (at < 0) setLooked((paths) => (paths.includes(path) ? paths : [...paths, path]));
        setLook(at >= 0 ? { files, index: at } : { files: [path, ...files], index: 0 });
      },
      openChange(path) {
        const { history, model } = latest.current.state;
        const tools = history ? { ...history.tools, ...model.tools } : model.tools;
        const changed = changedFilesOf(tools);
        const changes: Record<string, string | null> = {};
        for (const file of changed) if (file.before !== undefined) changes[file.path] = file.before;
        const files = changed.map((file) => file.path);
        setLook({ files, index: Math.max(0, files.indexOf(path)), changes });
      },
      openFileTab(target) {
        const path = resolveFilePath(target, cwd);
        if (!path) return;
        const inside = isUnder(path, latest.current.rootPath);
        openFileBeside(workspaceId, tabId, path, { split: split(), inside });
      },
      openUrl(url, other = false) {
        const local = isLocalAddress(url);
        if (local !== other) {
          // An SSH session's own address is the host's, not this machine's.
          if (local && !latest.current.isLocal) {
            showToast({ kind: "info", message: t("chat.links.remote_local") });
            return;
          }
          openBrowserBeside(workspaceId, tabId, url, { split: split() });
        } else if (isExternalSchemeAllowed(url)) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
    };
  }, [workspaceId, tabId]);

  const forkSession = () => {
    const point = controller.forkPoint("", { before: false });
    if (point) openClaudeTab(workspaceId, { cwd: props.cwd, fork: { sessionId: point.sessionId } });
  };
  const panel = (
    <SidePanel
      controller={controller}
      state={state}
      workspaceId={workspaceId}
      cwd={props.cwd}
      rootPath={rootPath}
      onShowAgent={showAgent}
      onForkSession={forkSession}
      className={place === "beside" ? "w-72 shrink-0 border-l border-border" : "h-full"}
    />
  );
  const permissions = state.model.permissions;

  const view = (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘[ and ⌘] step through the agents from anywhere in the tab
    <div
      ref={rootRef}
      className="relative flex h-full flex-col bg-background"
      data-testid="claude-tab"
      onKeyDown={onKeyDown}
    >
      <PhaseBanner controller={controller} state={state} />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {place === "summary" ? (
            <SummaryLine state={state} open={drawerOpen} onToggle={togglePanel} />
          ) : (
            <AgentStrip
              agents={agents}
              shown={shown ? shown.toolUseId : null}
              onShow={showAgent}
              panel={{ open: panelOpen, onToggle: togglePanel }}
            />
          )}
          <MessageList
            workspaceId={workspaceId}
            cwd={props.cwd}
            rootPath={rootPath}
            history={state.history}
            model={state.model}
            actions={shown ? undefined : actions}
            items={shown ? agentTranscript(state.model, shown) : undefined}
            empty={
              state.phase === "ready" || state.phase === "ended" ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                  <MessageSquareText className="size-8" />
                  <div className="text-app-body">{t("chat.empty.title")}</div>
                  <div className="max-w-full truncate font-mono text-app-micro" title={props.cwd}>
                    {props.cwd}
                  </div>
                </div>
              ) : null
            }
          />
          {/* Docked over the composer, so a request is seen wherever the list is scrolled. */}
          {(permissions.length > 0 || state.model.running) && (
            <div className="app-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 pt-2">
              <div className="mx-auto flex max-w-[860px] flex-col gap-2">
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
          <Composer
            controller={controller}
            state={state}
            local={isLocal}
            placeholder={shown ? t("chat.strip.input_to_main") : undefined}
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
              className={cn(
                // Below the strip, whose toggle closes it again.
                "absolute right-0 bottom-0 z-20 border-l border-border bg-background",
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
  const tab = openClaudeTab(workspaceId, { cwd, ...(fork ? { fork } : {}) });
  if (user) {
    const draft: ComposerDraft = { text: item.text, images: item.images, nonce: Date.now() };
    useChatStore.getState().update(chatKey(workspaceId, tab.id), (prev) => ({ ...prev, draft }));
  }
}

/** The tab's state in one line, where it is too narrow for the strip and the panel. */
function SummaryLine({
  state,
  open,
  onToggle,
}: {
  state: ChatTabState;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { model } = state;
  const parts: string[] = [];
  const agents = agentsOf(model).filter((a) => a.status === "running").length;
  if (agents > 0) parts.push(t("chat.strip.summary.agents", { count: agents }));
  const jobs = jobsOf(model).filter((j) => j.status === "running").length;
  if (jobs > 0) parts.push(t("chat.strip.summary.jobs", { count: jobs }));
  const todos = todosOf(model.tools);
  if (todos.length > 0) {
    const done = todos.filter((todo) => todo.status === "completed").length;
    parts.push(t("chat.strip.summary.todos", { done, total: todos.length }));
  }
  const context = contextOf(model.contextUsage);
  if (context && context.maxTokens > 0) {
    const percent = Math.round((context.totalTokens / context.maxTokens) * 100);
    parts.push(t("chat.strip.summary.context", { percent }));
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-3 text-left text-app-micro text-muted-foreground hover:text-foreground"
      data-testid="chat-summary-line"
    >
      <span className="min-w-0 flex-1 truncate">
        {parts.length > 0 ? parts.join(" · ") : t("chat.panel.show")}
      </span>
    </button>
  );
}

function titleOf(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
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

function RateLimitBanner({ state }: { state: ChatTabState }) {
  const { t } = useTranslation();
  const limit = state.model.rateLimit;
  if (!limit || limit.status === "allowed") return null;
  const resets = limit.resetsAt
    ? new Date(limit.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const rejected = limit.status === "rejected";
  const message = rejected
    ? resets
      ? t("chat.rate_limit.rejected_until", { time: resets })
      : t("chat.rate_limit.rejected")
    : resets
      ? t("chat.rate_limit.warning_until", { time: resets })
      : t("chat.rate_limit.warning");
  return (
    <div className="shrink-0">
      <Banner variant={rejected ? "error" : "warning"} message={message} />
    </div>
  );
}
