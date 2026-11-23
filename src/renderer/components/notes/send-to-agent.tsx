import i18next from "i18next";
import { Send } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { type AgentSession, allSessions } from "../../services/agent-sessions/model";
import { useSessionFamily } from "../../services/agent-sessions/use-family";
import { startAgentTab } from "../../services/chat/agent-tab";
import { revealTabById } from "../../services/chat/open-beside";
import { titleOf } from "../../services/chat/tab-title";
import { openTab } from "../../services/cli/placement";
import { notesApi } from "../../services/notes/api";
import {
  noteLocation,
  resolveConversation,
  tabLinkTarget,
} from "../../services/notes/conversation";
import { sendToConversation } from "../../services/notes/send-to-conversation";
import { useNoteLinks } from "../../services/notes/use-links";
import { chatPropsWithProfile } from "../../state/operations/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";
import { showToast } from "../ui/toast";

export function agentPrompt(message: string, title: string, noteId: string): string {
  return i18next.t("notes:agent.prompt", {
    message: message.trim() || i18next.t("notes:agent.defaultMessage"),
    title,
    id: noteId,
    interpolation: { escapeValue: false },
  });
}

export function useDestinations(workspaceId: string, noteId: string, visible: boolean) {
  const family = useSessionFamily(workspaceId, visible);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const tabsByWorkspace = useTabsStore((s) => s.byWorkspace);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const location = visible && workspace ? noteLocation(workspace, workspaces) : undefined;
  const links = useNoteLinks(workspaceId, noteId, location);
  if (!visible || !family || !workspace) return [];
  const linked = new Map<string, string>();
  for (const { id, link } of [...links].sort((a, b) => b.link.updatedAt - a.link.updatedAt)) {
    const target = resolveConversation(link, {
      noteWorkspaceId: workspaceId,
      workspaces,
      tabsByWorkspace,
    });
    if (target.kind !== "open" && target.kind !== "moved") continue;
    const key = `${target.workspace.id}:${target.tab.id}`;
    if (!linked.has(key)) linked.set(key, id);
  }
  return allSessions(family)
    .filter(({ kind }) => kind === "claude" || kind === "codex")
    .sort((a, b) => (b.since ?? 0) - (a.since ?? 0))
    .map((session) => ({ session, linkId: linked.get(session.key) }));
}

export function SendToAgent({
  open,
  onOpenChange,
  workspaceId,
  cwd,
  noteId,
  title,
  beforeSend,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  cwd: string;
  noteId: string;
  title: () => string;
  beforeSend: () => Promise<boolean>;
  trigger: ReactNode;
}) {
  const { t } = useTranslation("notes");
  const [destination, setDestination] = useState<ChatAgent | "existing">("claude");
  const [selected, setSelected] = useState<string>();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const destinations = useDestinations(workspaceId, noteId, open && destination === "existing");
  const existing = destination === "existing";
  const choice = destinations.find(({ session }) => session.key === selected);
  useEffect(() => {
    if (open) setMessage(t("agent.defaultMessage"));
  }, [open, t]);

  const send = async () => {
    if ((existing ? !choice : !cwd) || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      if (!(await beforeSend())) {
        showToast({ kind: "error", message: t("conversations.noteSaveError") });
        return;
      }
      const prompt = agentPrompt(message, title(), noteId);
      if (destination === "existing") {
        if (!choice) return;
        const { workspaceId: targetWorkspace, tabId, kind } = choice.session;
        const tab = useTabsStore.getState().byWorkspace[targetWorkspace]?.[tabId];
        if (!tab || tab.type !== kind || (tab.type !== "claude" && tab.type !== "codex")) {
          showToast({ kind: "error", message: t("agent.sendError") });
          return;
        }
        let queued: boolean;
        try {
          queued = await sendToConversation(targetWorkspace, tabId, prompt);
        } catch {
          showToast({ kind: "error", message: t("agent.sendError") });
          return;
        }
        onOpenChange(false);
        if (queued) showToast({ kind: "info", message: t("agent.sentQueued") });
        const latest = useTabsStore.getState().byWorkspace[targetWorkspace]?.[tabId];
        const current = latest?.type === tab.type ? latest : tab;
        const entry = await notesApi.addLink(
          workspaceId,
          noteId,
          { ...tabLinkTarget(targetWorkspace, current), agent: current.type, kind: "note" },
          choice.linkId ?? true,
        );
        const updated = useTabsStore.getState().byWorkspace[targetWorkspace]?.[tabId];
        if (
          entry.link.workspaceId === targetWorkspace &&
          entry.link.tabId === tabId &&
          updated?.type === current.type &&
          updated !== current
        ) {
          await notesApi.updateLinksForTab({
            ...tabLinkTarget(targetWorkspace, updated),
            agent: updated.type,
          });
        }
        return;
      }
      const agent = destination;
      const props = chatPropsWithProfile<{ cwd: string; profileId?: string }>(workspaceId, agent, {
        cwd,
      });
      const tabId = openTab(workspaceId, { type: agent, props }, { background: true });
      onOpenChange(false);
      const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
      const target =
        tab?.type === agent ? tabLinkTarget(workspaceId, tab) : { workspaceId, tabId, cwd };
      try {
        await notesApi.addLink(workspaceId, noteId, {
          ...target,
          title: titleOf(prompt),
          agent,
          kind: "note",
        });
        const current = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
        if (current?.type === agent && current !== tab) {
          await notesApi.updateLinksForTab({ ...tabLinkTarget(workspaceId, current), agent });
        }
      } finally {
        startAgentTab(workspaceId, tabId, prompt);
        revealTabById(workspaceId, tabId);
      }
    } catch {
      showToast({ kind: "error", message: t("conversations.saveError") });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={t("agent.title")}
      trigger={trigger}
      side="bottom"
      align="end"
      className="w-112 max-w-[calc(100vw-1rem)]"
      testId="note-agent-popover"
    >
      <div className="flex flex-col gap-3 p-3">
        <b className="text-app-body font-semibold text-foreground">{t("agent.title")}</b>
        <div className="flex flex-col gap-1.5">
          <span className="text-app-micro text-muted-foreground">{t("agent.destination")}</span>
          <fieldset
            aria-label={t("agent.destination")}
            className="grid min-w-0 grid-cols-3 gap-1.5"
          >
            {(["claude", "codex", "existing"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={destination === option}
                title={t(`agent.${option}`)}
                onClick={() => setDestination(option)}
                className={cn(
                  "min-w-0 truncate rounded-(--radius-control) border px-1.5 py-1.5 text-app-ui-sm",
                  destination === option
                    ? "border-ring bg-[var(--sidebar-item-selected-bg)] text-foreground"
                    : "border-border text-muted-foreground hover:bg-[var(--state-hover-bg)]",
                )}
              >
                {t(`agent.${option}`)}
              </button>
            ))}
          </fieldset>
        </div>
        {existing && (
          <ConversationDestinations
            destinations={destinations}
            selected={selected}
            onSelect={setSelected}
          />
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-app-micro text-muted-foreground">{t("agent.message")}</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            rows={3}
            className="resize-none rounded-(--radius-control) border border-border bg-transparent px-2 py-1.5 text-app-ui-sm text-foreground outline-none focus:border-ring"
          />
        </label>
        <div className="flex items-end gap-2">
          <p className="flex-1 text-app-micro text-muted-foreground">
            {t(existing ? "agent.existingHint" : "agent.hint")}
          </p>
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={(existing ? !choice : !cwd) || sending}
          >
            <Send aria-hidden="true" />
            {t("agent.send")}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

export function ConversationDestinations({
  destinations,
  selected,
  onSelect,
}: {
  destinations: ReturnType<typeof useDestinations>;
  selected?: string;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation("notes");
  return (
    <fieldset
      aria-label={t("agent.existing")}
      className="max-h-48 w-full min-w-0 overflow-x-hidden overflow-y-auto rounded-(--radius-control) border border-border app-scrollbar"
    >
      {destinations.length ? (
        ([true, false] as const).map((linked) => {
          const rows = destinations.filter(({ linkId }) => Boolean(linkId) === linked);
          if (!rows.length) return null;
          return (
            <div key={String(linked)}>
              <div className="px-2 pt-1.5 pb-0.5 text-app-micro text-muted-foreground">
                {t(linked ? "agent.linked" : "agent.other")}
              </div>
              {rows.map(({ session }) => (
                <DestinationRow
                  key={session.key}
                  session={session}
                  selected={session.key === selected}
                  onSelect={() => onSelect(session.key)}
                />
              ))}
            </div>
          );
        })
      ) : (
        <div className="px-2 py-1.5 text-app-micro text-muted-foreground">
          {t("agent.noConversations")}
        </div>
      )}
    </fieldset>
  );
}

function DestinationRow({
  session,
  selected,
  onSelect,
}: {
  session: AgentSession;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("notes");
  const Icon = session.kind === "codex" ? CodexIcon : ClaudeIcon;
  const phase = session.phase === "idle" && session.hasTurns ? "done" : session.phase;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-app-ui-sm",
        selected ? "bg-[var(--sidebar-item-selected-bg)]" : "hover:bg-[var(--state-hover-bg)]",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={session.title}>
        {session.title}
      </span>
      <span className="shrink-0 whitespace-nowrap text-app-micro text-muted-foreground">
        {t(`agent.phase.${phase}`)}
      </span>
    </button>
  );
}
