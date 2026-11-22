/**
 * "To an agent": a new Claude or Codex chat in the workspace, started with a
 * message and how to read the note (`nexus note read <id>`); the note's
 * files are not copied, the agent reads them where they are kept.
 */
import i18next from "i18next";
import { Send } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { openAgentTab } from "../../services/chat/agent-tab";
import { titleOf } from "../../services/chat/tab-title";
import { notesApi } from "../../services/notes/api";
import { tabLinkTarget } from "../../services/notes/conversation";
import { useTabsStore } from "../../state/stores/tabs";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";
import { showToast } from "../ui/toast";

/** The first message the chat gets. */
export function agentPrompt(message: string, title: string, noteId: string): string {
  return i18next.t("notes:agent.prompt", {
    message: message.trim() || i18next.t("notes:agent.defaultMessage"),
    title,
    id: noteId,
    interpolation: { escapeValue: false },
  });
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
  /** The note's title as it is now. */
  title: () => string;
  /** Saves what is not saved yet, so the agent reads the note as it is. */
  beforeSend: () => Promise<boolean>;
  trigger: ReactNode;
}) {
  const { t } = useTranslation("notes");
  const [agent, setAgent] = useState<ChatAgent>("claude");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    if (open) setMessage(t("agent.defaultMessage"));
  }, [open, t]);

  const send = async () => {
    if (!cwd || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      if (!(await beforeSend())) {
        showToast({ kind: "error", message: t("conversations.noteSaveError") });
        return;
      }
      const prompt = agentPrompt(message, title(), noteId);
      const tabId = openAgentTab(workspaceId, agent, cwd, prompt);
      onOpenChange(false);
      const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
      const target =
        tab?.type === agent ? tabLinkTarget(workspaceId, tab) : { workspaceId, tabId, cwd };
      await notesApi.addLink(workspaceId, noteId, {
        ...target,
        title: titleOf(prompt),
        agent,
        kind: "note",
      });
      // An agent can publish its session while the link is still being added.
      const current = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
      if (current?.type === agent && current !== tab) {
        await notesApi.updateLinksForTab({ ...tabLinkTarget(workspaceId, current), agent });
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
      className="w-80"
      testId="note-agent-popover"
    >
      <div className="flex flex-col gap-3 p-3">
        <b className="text-app-body font-semibold text-foreground">{t("agent.title")}</b>
        <div className="flex flex-col gap-1.5">
          <span className="text-app-micro text-muted-foreground">{t("agent.destination")}</span>
          <fieldset aria-label={t("agent.destination")} className="flex gap-1.5">
            {(["claude", "codex"] as const).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={agent === a}
                onClick={() => setAgent(a)}
                className={cn(
                  "flex-1 rounded-(--radius-control) border px-2 py-1.5 text-app-ui-sm",
                  agent === a
                    ? "border-ring bg-[var(--sidebar-item-selected-bg)] text-foreground"
                    : "border-border text-muted-foreground hover:bg-[var(--state-hover-bg)]",
                )}
              >
                {t(`agent.${a}`)}
              </button>
            ))}
          </fieldset>
        </div>
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
          <p className="flex-1 text-app-micro text-muted-foreground">{t("agent.hint")}</p>
          <Button size="sm" onClick={() => void send()} disabled={!cwd || sending}>
            <Send aria-hidden="true" />
            {t("agent.send")}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
