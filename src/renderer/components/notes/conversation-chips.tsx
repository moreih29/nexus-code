import { Loader } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { NoteLinkEntry } from "../../../shared/notes/links";
import { ipcCallResult } from "../../ipc/client";
import { revealInWorkspace } from "../../services/agent-sessions/actions";
import { type AgentSession, allSessions } from "../../services/agent-sessions/model";
import { useSessionFamily } from "../../services/agent-sessions/use-family";
import { activateTarget, revealTabById } from "../../services/chat/open-beside";
import type { ListedSession } from "../../services/chat/sessions";
import { groupOf } from "../../services/cli/placement";
import { notesApi } from "../../services/notes/api";
import {
  type ConversationResolution,
  type ConversationStatus,
  conversationStatus,
  conversationTitle,
  historyWorkspace,
  noteLocation,
  resolveConversation,
  tabLinkTarget,
} from "../../services/notes/conversation";
import {
  conversationHistoryKey,
  readConversationHistory,
} from "../../services/notes/conversation-history";
import { useNoteLinks } from "../../services/notes/use-links";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useLayoutStore } from "../../state/stores/layout/store";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { showToast } from "../ui/toast";

interface NotePlace {
  workspaceId: string;
  noteId: string;
  tabId: string;
}

export function ConversationChips({ isVisible, ...note }: NotePlace & { isVisible: boolean }) {
  const { t } = useTranslation("notes");
  const { workspaceId, noteId } = note;
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const links = useNoteLinks(workspaceId, noteId, workspace && noteLocation(workspace, workspaces));
  if (!links.length) return null;
  return (
    <fieldset
      aria-label={t("conversations.title")}
      className="flex max-h-24 min-w-0 shrink-0 flex-wrap items-center gap-1.5 overflow-auto border-b border-border px-6 py-2 app-scrollbar"
    >
      <span className="mr-1 text-app-micro text-muted-foreground">{t("conversations.title")}</span>
      <LinkedConversations note={note} links={links} isVisible={isVisible} />
    </fieldset>
  );
}

function LinkedConversations({
  note,
  links,
  isVisible,
}: {
  note: NotePlace;
  links: NoteLinkEntry[];
  isVisible: boolean;
}) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const tabsByWorkspace = useTabsStore((s) => s.byWorkspace);
  const config = useAgentProfilesStore((s) => s.config);
  const family = useSessionFamily(note.workspaceId, isVisible);
  const sessions = new Map(family && allSessions(family).map((s) => [s.key, s]));
  const stores = { noteWorkspaceId: note.workspaceId, workspaces, tabsByWorkspace };
  const rows = links.map((entry) => {
    const resolution = resolveConversation(entry.link, stores);
    const key =
      resolution.kind === "missing"
        ? conversationHistoryKey(entry.link, historyWorkspace(entry.link, stores))
        : undefined;
    return { entry, resolution, key: key && JSON.stringify(key) };
  });
  const request = JSON.stringify([...new Set(rows.flatMap((r) => (r.key ? [r.key] : [])))].sort());
  const [history, setHistory] = useState<Record<string, ListedSession[]>>({});
  useEffect(() => {
    if (!isVisible) return;
    let alive = true;
    const keys: string[] = JSON.parse(request);
    setHistory((current) =>
      Object.fromEntries(keys.flatMap((key) => (current[key] ? [[key, current[key]]] : []))),
    );
    for (const key of keys) {
      void readConversationHistory(JSON.parse(key), config)
        .catch(() => [])
        .then((sessions) => {
          if (alive) setHistory((current) => ({ ...current, [key]: sessions }));
        });
    }
    return () => {
      alive = false;
    };
  }, [isVisible, request, config]);
  return rows.map(({ entry, resolution, key }) => {
    const target =
      key && history[key]
        ? resolveConversation(entry.link, { ...stores, history: history[key] })
        : resolution;
    const session =
      target.kind === "open" || target.kind === "moved"
        ? sessions.get(`${target.workspace.id}:${target.tab.id}`)
        : undefined;
    return (
      <ConversationChip
        key={entry.id}
        entry={entry}
        target={target}
        session={session}
        checking={Boolean(key && !history[key])}
        note={note}
        onUnavailable={(sessions) => {
          if (key) setHistory((current) => ({ ...current, [key]: sessions }));
        }}
      />
    );
  });
}

const DOT_COLORS: Partial<Record<ConversationStatus, string>> = {
  attention: "bg-(--state-warning-fg)",
  failed: "bg-(--state-error-fg)",
  completed: "bg-emerald-500",
  reported: "bg-emerald-500",
  limitWait: "bg-(--state-warning-fg)",
};

function ConversationChip({
  entry: { id, link },
  target,
  session,
  checking,
  note,
  onUnavailable,
}: {
  entry: NoteLinkEntry;
  target: ConversationResolution;
  session: AgentSession | undefined;
  checking: boolean;
  note: NotePlace;
  onUnavailable: (sessions: ListedSession[]) => void;
}) {
  const { t, i18n } = useTranslation("notes");
  const [opening, setOpening] = useState(false);
  const status = conversationStatus(target, session, link.result, checking);
  const title = conversationTitle(link.title, target) || t(`conversations.${link.agent}`);
  const branch =
    (target.kind === "missing" ? undefined : target.workspace.task?.branch) ?? link.task?.branch;
  const pr = link.result?.pr;
  const Icon = link.agent === "claude" ? ClaudeIcon : CodexIcon;
  const time = session?.limitWait
    ? new Intl.DateTimeFormat(i18n.language || undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(session.limitWait.at)
    : "";
  const label =
    status === "reported"
      ? t("conversations.completed") + (pr ? ` · PR #${pr.number}` : "")
      : t(`conversations.${status}`, { time });
  const dotColor = DOT_COLORS[status];
  const statusIcon =
    status === "running" ? (
      <Loader className="size-3 text-sky-500 motion-safe:animate-spin" aria-hidden="true" />
    ) : dotColor ? (
      <span className={cn("size-1.5 rounded-full", dotColor)} aria-hidden="true" />
    ) : null;
  const failed = () => showToast({ kind: "error", message: t("conversations.actionError") });

  const openConversation = async () => {
    setOpening(true);
    try {
      const missing = await showConversation(note, id, link);
      if (missing) onUnavailable(missing);
    } catch {
      failed();
    } finally {
      setOpening(false);
    }
  };

  const chip = (
    <button
      type="button"
      className={cn(
        "inline-flex min-w-0 max-w-[min(100%,20rem)] items-center rounded-full border border-border px-2 py-0.5 text-app-micro hover:bg-[var(--state-hover-bg)]",
        target.kind === "missing" ? "text-muted-foreground" : "text-foreground",
      )}
      title={branch ? `${title} · ${t("conversations.task", { branch })}` : title}
      onClick={target.kind === "missing" ? undefined : () => void openConversation()}
      disabled={opening || (checking && !link.result)}
      data-testid="note-conversation-chip"
    >
      <Icon className="mr-1 size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{title}</span>
      <span
        className={cn(
          "shrink-0 text-muted-foreground",
          statusIcon ? "ml-1 flex items-center gap-1" : "whitespace-pre",
        )}
      >
        {statusIcon}
        {statusIcon ? label : ` · ${label}`}
      </span>
    </button>
  );

  if (target.kind !== "missing") return chip;
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>{chip}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {pr && (
          <DropdownMenuItem
            onSelect={() => void ipcCallResult("agentProfiles", "openUrl", { url: pr.url })}
          >
            {t("conversations.openPr")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => void notesApi.removeLink(note.workspaceId, note.noteId, id).catch(failed)}
        >
          {t("conversations.unlink")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/** Rechecks history on activation: a session can disappear or open since it was listed. */
async function showConversation(
  note: NotePlace,
  linkId: string,
  link: NoteLinkEntry["link"],
): Promise<ListedSession[] | undefined> {
  const stores = () => ({
    noteWorkspaceId: note.workspaceId,
    workspaces: useWorkspacesStore.getState().workspaces,
    tabsByWorkspace: useTabsStore.getState().byWorkspace,
  });
  let target = resolveConversation(link, stores());
  if (target.kind === "missing") {
    const key = conversationHistoryKey(link, historyWorkspace(link, stores()));
    if (!key) return [];
    const history = await readConversationHistory(key, useAgentProfilesStore.getState().config);
    const current = stores();
    const stillThere = historyWorkspace(link, current)?.id === key[1];
    target = resolveConversation(link, { ...current, history: stillThere ? history : [] });
    if (target.kind === "missing") return stillThere ? history : [];
  }

  const workspaceId = target.workspace.id;
  const beside = workspaceId === note.workspaceId;
  const noteGroup = beside ? groupOf(workspaceId, note.tabId) : null;
  let tabId: string;
  if (target.kind === "resume") {
    if (noteGroup) activateTarget(workspaceId, note.tabId, true);
    const props = { cwd: link.cwd, profileId: target.session.profileId };
    const opened =
      link.agent === "claude"
        ? openClaudeTab(workspaceId, { ...props, sessionId: target.session.sessionId })
        : openCodexTab(workspaceId, { ...props, threadId: target.session.sessionId });
    tabId = opened.id;
    useTabsStore
      .getState()
      .setProcessTitle(workspaceId, tabId, conversationTitle(link.title, target));
  } else {
    tabId = target.tab.id;
    if (noteGroup && groupOf(workspaceId, tabId) === noteGroup) {
      activateTarget(workspaceId, note.tabId, true);
      const layout = useLayoutStore.getState();
      const group = layout.byWorkspace[workspaceId]?.activeGroupId;
      if (group && group !== noteGroup) layout.moveTab(workspaceId, tabId, group);
    }
  }
  if (!beside) revealInWorkspace({ workspaceId, tabId });
  revealTabById(workspaceId, tabId);
  const current = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (current?.type === "claude" || current?.type === "codex") {
    const { profileId, ...patch } = tabLinkTarget(workspaceId, current);
    await notesApi.updateLink(note.workspaceId, note.noteId, linkId, {
      ...patch,
      profileId: profileId ?? null,
    });
  }
}
