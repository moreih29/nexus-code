import { ArrowLeft } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { isUnder } from "../../../shared/fs/relative-path";
import { placeLocalFile } from "../../services/agent-view/file-tabs";
import type { CodexRateLimits } from "../../services/chat/codex/model";
import type { LineAt } from "../../services/chat/links";
import { lookAreaOf } from "../../services/chat/look-area";
import type { ChatModel, PermissionRequest, RateLimitInfo } from "../../services/chat/model";
import type { AgentRow } from "../../services/chat/panel";
import { registerPanelToggle } from "../../services/chat/panel-toggle";
import { revertChangedFile } from "../../services/chat/revert-file";
import { codexMeter } from "../../services/chat/usage-line";
import { registerTabFocusTarget } from "../../services/tab-focus";
import { cn } from "../../utils/cn";
import { BannerDismissButton } from "../ui/banner";
import { ClaudeIcon, CodexIcon } from "./agent-icons";
import { AgentStrip, ShownState } from "./agent-strip";
import { type PanelPlace, placeFor, readPanelPref, writePanelPref } from "./panel-place";
import { focusChatTab, PermissionCard } from "./permission-card";
import { QuickLook, type QuickLookList } from "./quick-look";
import { StatusLine } from "./status-line";
import { type SummaryCounts, SummaryLine } from "./summary-line";

export interface ChatPanelPlace {
  rootRef: RefObject<HTMLDivElement | null>;
  drawerRef: RefObject<HTMLDivElement | null>;
  place: PanelPlace;
  besideOpen: boolean;
  drawerOpen: boolean;
  panelOpen: boolean;
  togglePanel: () => void;
  openPanel: () => void;
  closeDrawer: () => void;
}

export function useChatPanelPlace(focusKey: string, visible: boolean): ChatPanelPlace {
  const rootRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(
    () => registerTabFocusTarget(focusKey, () => focusChatTab(rootRef.current)),
    [focusKey],
  );
  const [place, setPlace] = useState<PanelPlace>("beside");
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setPlace(placeFor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [besideOpen, setBesideOpen] = useState(readPanelPref);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const togglePanel = () => {
    if (place === "beside") {
      writePanelPref(!besideOpen);
      setBesideOpen(!besideOpen);
    } else setDrawerOpen((open) => !open);
  };
  const openPanel = () => {
    if (place !== "beside") setDrawerOpen(true);
    else if (!besideOpen) {
      writePanelPref(true);
      setBesideOpen(true);
    }
  };
  const toggleNow = useRef(togglePanel);
  toggleNow.current = togglePanel;
  useEffect(() => registerPanelToggle(focusKey, () => toggleNow.current()), [focusKey]);
  useEffect(() => {
    if (place === "beside" || !visible) setDrawerOpen(false);
  }, [place, visible]);
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
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  return {
    rootRef,
    drawerRef,
    place,
    besideOpen,
    drawerOpen,
    panelOpen: place === "beside" ? besideOpen : drawerOpen,
    togglePanel,
    openPanel,
    closeDrawer,
  };
}

export function agentStep(
  agents: readonly AgentRow[],
  shownId: string | null,
  key: string,
): string | null | undefined {
  if ((key !== "[" && key !== "]") || agents.length === 0) return undefined;
  const order = [null, ...agents.map((agent) => agent.toolUseId)];
  const at = Math.max(0, order.indexOf(shownId));
  const step = key === "]" ? 1 : -1;
  return order[(at + step + order.length) % order.length] ?? null;
}

export function useShownAgent(
  agents: readonly AgentRow[],
  shell: Pick<ChatPanelPlace, "place" | "closeDrawer">,
  onShown?: () => void,
): {
  shown: AgentRow | undefined;
  showAgent: (toolUseId: string | null) => void;
  onKeyDown: (event: KeyboardEvent) => void;
} {
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = shownId ? agents.find((agent) => agent.toolUseId === shownId) : undefined;
  useEffect(() => {
    if (shownId && !shown) setShownId(null);
  }, [shownId, shown]);
  const showAgent = (toolUseId: string | null) => {
    setShownId(toolUseId);
    if (shell.place !== "beside") shell.closeDrawer();
    onShown?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const next = agentStep(agents, shown ? shown.toolUseId : null, event.key);
    if (next === undefined) return;
    event.preventDefault();
    showAgent(next);
  };
  return { shown, showAgent, onKeyDown };
}

const PANEL_BESIDE_CLASS = "w-72 shrink-0 border-l border-border";

export function ChatShell({
  shell,
  agents,
  shown,
  onShowAgent,
  summaryCounts,
  panel,
  children,
}: {
  shell: ChatPanelPlace;
  agents: AgentRow[];
  shown: AgentRow | undefined;
  onShowAgent: (toolUseId: string | null) => void;
  summaryCounts: () => SummaryCounts;
  panel: (className: string) => ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { place, besideOpen, drawerOpen, panelOpen, togglePanel, closeDrawer, drawerRef } = shell;
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {place === "summary" ? (
          <>
            <SummaryLine counts={summaryCounts()} open={drawerOpen} onToggle={togglePanel} />
            {shown && <ShownAgentBar shown={shown} onBack={() => onShowAgent(null)} />}
          </>
        ) : (
          <AgentStrip
            agents={agents}
            shown={shown ? shown.toolUseId : null}
            onShow={onShowAgent}
            panel={{ open: panelOpen, onToggle: togglePanel }}
          />
        )}
        {children}
      </div>
      {place === "beside" && besideOpen && panel(PANEL_BESIDE_CLASS)}
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
            onClick={closeDrawer}
          />
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the drawer */}
          <div
            ref={drawerRef}
            tabIndex={-1}
            className={cn(
              "absolute right-0 bottom-0 z-20 border-l border-border bg-background outline-none",
              place === "summary" ? "top-7 w-full" : "top-8 w-80",
            )}
            data-testid="chat-drawer"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeDrawer();
              }
            }}
          >
            {panel("h-full")}
          </div>
        </>
      )}
    </div>
  );
}

function ShownAgentBar({ shown, onBack }: { shown: AgentRow; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2 text-app-ui-sm">
      <button
        type="button"
        onClick={onBack}
        className="flex shrink-0 items-center gap-1 rounded-(--radius-control) px-1.5 py-0.5 font-medium whitespace-nowrap hover:bg-[var(--state-hover-bg)]"
        data-testid="chat-to-main"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t("chat.strip.to_main")}
      </button>
      <span className="min-w-0 truncate text-muted-foreground">{shown.description}</span>
      <ShownState agent={shown} />
    </div>
  );
}

export function RequestDock({ children }: { children: ReactNode }) {
  return (
    <div className="app-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 py-2">
      <div className="mx-auto flex max-w-[860px] flex-col gap-2">{children}</div>
    </div>
  );
}

export interface DockCard {
  workspaceId: string;
  cwd: string;
  rootPath: string;
  planModeOptions?: boolean;
  onAnswer: Parameters<typeof PermissionCard>[0]["onAnswer"];
}

export function ChatRequestDock({
  model,
  goal,
  extra,
  card,
  onToMain,
}: {
  model: ChatModel;
  goal?: ReactNode;
  extra?: ReactNode;
  card: DockCard;
  onToMain?: () => void;
}) {
  const permissions: PermissionRequest[] = model.permissions;
  if (!goal && !extra && permissions.length === 0 && !model.running) return null;
  return (
    <RequestDock>
      {goal}
      {extra}
      {permissions.length > 0 && (
        <PermissionCard requests={permissions} {...card} {...(onToMain ? { onToMain } : {})} />
      )}
      <StatusLine model={model} />
    </RequestDock>
  );
}

export function showsEmptyChat(phase: string | undefined): boolean {
  return phase === undefined || phase === "ready" || phase === "ended";
}

export function ChatEmptyState({
  agent,
  cwd,
  error,
  onDismissError,
  children,
}: {
  agent: "claude" | "codex";
  cwd: string;
  error?: string | null;
  onDismissError?: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const Icon = agent === "codex" ? CodexIcon : ClaudeIcon;
  return (
    <div
      className="my-auto flex flex-col items-center gap-2 py-4 text-center text-muted-foreground"
      data-testid="chat-empty"
    >
      <Icon className="size-8" />
      <div className="text-app-body">
        {t(agent === "codex" ? "chat.codex.empty" : "chat.empty.title")}
      </div>
      <div className="max-w-full truncate font-mono text-app-micro" title={cwd}>
        {cwd}
      </div>
      {error && (
        <div className="flex items-center gap-2 text-app-ui-sm text-[var(--state-error-fg)]">
          <span className="flex-1">{t("chat.sessions.resume_failed", { message: error })}</span>
          {onDismissError && (
            <BannerDismissButton
              dismiss={{ label: t("action.dismiss"), onDismiss: onDismissError }}
            />
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export function LocalChatLook({
  workspaceId,
  tabId,
  rootPath,
  rootRef,
  look,
  setLook,
  local,
  openFileTab,
  agent,
  running,
}: {
  workspaceId: string;
  tabId: string;
  rootPath: string;
  rootRef: RefObject<HTMLDivElement | null>;
  look: QuickLookList | null;
  setLook: (list: QuickLookList | null) => void;
  local: boolean;
  openFileTab: (path: string, at?: LineAt) => void;
  agent: "claude" | "codex";
  running: boolean;
}) {
  const { t } = useTranslation();
  if (!look) return null;
  return (
    <QuickLook
      workspaceId={workspaceId}
      list={look}
      area={lookAreaOf(rootRef.current)}
      local={local}
      onIndex={(index) => setLook({ ...look, index })}
      onClose={() => setLook(null)}
      onOpenBeside={(path, { at }) => {
        setLook(null);
        placeLocalFile(workspaceId, tabId, path, isUnder(path, rootPath), at);
        return true;
      }}
      onOpenTab={(path, at) => {
        setLook(null);
        openFileTab(path, at);
      }}
      onRevert={(path) => {
        const before = look.changes?.[path];
        if (before !== undefined)
          void revertChangedFile(workspaceId, rootPath, path, before, agent);
      }}
      revertBlocked={
        running
          ? t("chat.look.revert_busy", agent === "codex" ? { context: "codex" } : {})
          : undefined
      }
    />
  );
}

export function codexRateLimitOf(
  limits: CodexRateLimits | undefined,
  now = Date.now(),
): RateLimitInfo | undefined {
  const full = [limits?.primary, limits?.secondary]
    .flatMap((window) => (window ? [codexMeter(window)] : []))
    .find(
      (meter) => meter.percent >= 100 && (meter.resetsAt === undefined || meter.resetsAt > now),
    );
  if (!full) return undefined;
  return {
    status: "rejected",
    rateLimitType: full.kind,
    ...(full.resetsAt !== undefined ? { resetsAt: Math.floor(full.resetsAt / 1000) } : {}),
  };
}
