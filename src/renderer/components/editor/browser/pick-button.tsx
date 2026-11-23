import { SquareDashedMousePointer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { showToast } from "@/components/ui/toast";
import { normaliseError } from "@/hooks/use-ipc-action";
import { ipcCallResult } from "@/ipc/client";
import { showTerminal } from "@/services/agent-sessions/actions";
import { type AgentSession, sessionKey } from "@/services/agent-sessions/model";
import { pasteForTerminal, pickTargets, targetLabels } from "@/services/browser/element-pick";
import { surfaceError } from "@/services/error-surface/surface-error";
import { getTerminalController } from "@/services/terminal/terminal-registry";
import { useClaudeStatusStore } from "@/state/stores/claude-status";
import { useTabsStore } from "@/state/stores/tabs";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import { copyTextViaIpc } from "@/utils/clipboard";
import { cn } from "@/utils/cn";
import { ipcErrorToAppError } from "../../../../shared/ipc/result";

interface PickButtonProps {
  tabId: string;
  workspaceId: string;
}

async function agentSessions(workspaceId: string): Promise<AgentSession[]> {
  const activity = await ipcCallResult("cli", "activity", {});
  return pickTargets({
    workspaces: useWorkspacesStore.getState().workspaces,
    workspaceId,
    tabsByWorkspace: useTabsStore.getState().byWorkspace,
    claudeByWorkspace: useClaudeStatusStore.getState().byWorkspace,
    activity: new Map(
      (activity.ok ? activity.value : []).map((entry) => [
        sessionKey(entry.workspaceId, entry.tabId),
        entry,
      ]),
    ),
    now: Date.now(),
  });
}

function pasteInto(session: AgentSession, text: string): boolean {
  const controller = getTerminalController(session.tabId);
  if (!controller?.input(pasteForTerminal(text, controller.bracketedPaste()), "paste")) {
    return false;
  }
  showTerminal(session);
  requestAnimationFrame(() => controller.focus());
  return true;
}

export function PickButton({ tabId, workspaceId }: PickButtonProps) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState<{ text: string; sessions: AgentSession[] } | null>(null);
  const pickingRef = useRef(false);

  const cancel = () => {
    void ipcCallResult("cli", "cancelPick", { tabId });
  };

  useEffect(() => {
    if (!picking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void ipcCallResult("cli", "cancelPick", { tabId });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [picking, tabId]);

  useEffect(
    () => () => {
      if (pickingRef.current) void ipcCallResult("cli", "cancelPick", { tabId });
    },
    [tabId],
  );

  const copyInstead = async (text: string, message: string) => {
    if (await copyTextViaIpc(text)) showToast({ kind: "info", message });
  };

  const deliver = (session: AgentSession, text: string) => {
    if (!pasteInto(session, text)) void copyInstead(text, t("browser.pick_terminal_closed"));
  };

  const start = async () => {
    if (pickingRef.current) {
      cancel();
      return;
    }
    pickingRef.current = true;
    setPicking(true);
    try {
      const result = await ipcCallResult("cli", "pickElement", { tabId });
      if (!result.ok) {
        surfaceError(ipcErrorToAppError(result), { surface: "toast" });
        return;
      }
      if (!("text" in result.value)) return;
      const { text } = result.value;
      const sessions = await agentSessions(workspaceId);
      if (sessions.length === 0) void copyInstead(text, t("browser.pick_no_agent"));
      else if (sessions.length === 1 && sessions[0]) deliver(sessions[0], text);
      else setChoice({ text, sessions });
    } catch (error) {
      surfaceError(normaliseError(error), { surface: "toast" });
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  };

  const label = picking ? t("browser.cancel_pick") : t("browser.pick_element");

  return (
    <DropdownMenuRoot
      open={choice !== null}
      onOpenChange={(open) => {
        if (!open) setChoice(null);
      }}
    >
      <div className="relative shrink-0">
        <IconButton
          label={label}
          size="md"
          aria-pressed={picking}
          onClick={() => void start()}
          className={cn(
            "active:bg-[var(--state-active-bg)] [&_svg]:size-4 [&_svg]:pointer-events-none",
            picking && "bg-[var(--state-active-bg)] text-foreground",
          )}
        >
          <SquareDashedMousePointer aria-hidden="true" />
        </IconButton>
        <DropdownMenuTrigger>
          <span aria-hidden="true" className="absolute inset-0 pointer-events-none" />
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
        <div className="px-2 py-1 text-app-ui-sm text-muted-foreground">
          {t("browser.pick_send_to")}
        </div>
        {choice &&
          targetLabels(choice.sessions).map((label, i) => {
            const session = choice.sessions[i] as AgentSession;
            return (
              <DropdownMenuItem key={label.key} onSelect={() => deliver(session, choice.text)}>
                <span className="truncate">{label.title}</span>
                {label.detail !== "" && (
                  <span className="text-muted-foreground ml-4 truncate max-w-60 text-app-ui-sm">
                    {label.detail}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
