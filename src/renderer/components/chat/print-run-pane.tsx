import { Square, SquareArrowOutUpRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRun } from "../../../shared/claude/activity";
import { useNow } from "../../hooks/use-now";
import type { ChatModel } from "../../services/chat/model";
import { useRunConversation } from "../../services/chat/print-run-transcript";
import { stopPrintRun } from "../../services/chat/print-runs";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { AgentFlow, toolCount } from "../agent-list/agent-flow";
import {
  AgentDuration,
  AgentGlyph,
  agentStateColor,
  agentStateLabel,
} from "../agent-list/agent-status";
import { BannerDismissButton } from "../ui/banner";
import { Button } from "../ui/button";
import { ChatMarkdown } from "./chat-markdown";
import { MessageList, type OlderMessages } from "./message-list";

export interface RunConversation {
  model: ChatModel;
  truncated?: boolean;
  older?: OlderMessages;
}

const ID_SHOWN = 8;

export function PrintRunPane({
  workspaceId,
  tabId,
  cwd,
  rootPath,
  run,
  visible,
  stopRun,
  openInTab: openThere,
  conversation: given,
}: {
  workspaceId: string;
  tabId: string;
  cwd: string;
  rootPath: string;
  run: AgentRun;
  visible: boolean;
  stopRun?: (() => Promise<boolean>) | null;
  openInTab?: ((sessionId: string) => void) | null;
  conversation?: RunConversation | null;
}) {
  const { t } = useTranslation();
  const running = run.end === undefined;
  const own = useRunConversation(workspaceId, tabId, run, visible && given === undefined);
  const conversation: RunConversation | null = given === undefined ? own : given;
  const now = useNow(visible && running);
  const [stopFailed, setStopFailed] = useState(false);
  const stopper = stopRun === undefined ? () => stopPrintRun(workspaceId, tabId, run.id) : stopRun;
  const stop = stopper
    ? () => {
        setStopFailed(false);
        void stopper().then((stopped) => setStopFailed(!stopped));
      }
    : null;
  const { sessionId } = run;
  const codex = run.program === "codex";
  const kind = [
    codex ? t("chat.run.kind_codex") : t("chat.run.kind"),
    run.model,
    run.endpoint,
    sessionId === undefined ? undefined : sessionId.slice(0, ID_SHOWN),
    run.toolsTold ? toolCount(run) : undefined,
  ].filter((part): part is string => part !== undefined);
  const openInTab =
    openThere === undefined
      ? (id: string) =>
          codex
            ? openCodexTab(workspaceId, { cwd, threadId: id })
            : openClaudeTab(workspaceId, { cwd, sessionId: id })
      : openThere;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-print-run">
      <header className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-app-micro text-muted-foreground"
          title={kind.join(" · ")}
        >
          {kind.join(" · ")}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-app-ui-sm">
            <AgentGlyph state={run.state} />
            <span className={agentStateColor(run.state)}>{agentStateLabel(run.state)}</span>
            <AgentDuration agent={run} className="text-app-ui-sm" />
          </span>
          {running
            ? stop && <RunStopButton onClick={stop} />
            : sessionId !== undefined &&
              openInTab && (
                <Button
                  size="icon-sm"
                  variant="outline"
                  title={t("chat.run.open_in_tab")}
                  aria-label={t("chat.run.open_in_tab")}
                  onClick={() => openInTab(sessionId)}
                >
                  <SquareArrowOutUpRight aria-hidden className="size-3.5" />
                </Button>
              )}
        </div>
      </header>
      {stopFailed && (
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 text-app-ui-sm text-muted-foreground">
          <span className="flex-1">{t("chat.run.stop_failed")}</span>
          <BannerDismissButton
            dismiss={{ label: t("action.dismiss"), onDismiss: () => setStopFailed(false) }}
          />
        </div>
      )}
      {conversation ? (
        <MessageList
          workspaceId={workspaceId}
          cwd={cwd}
          rootPath={rootPath}
          history={null}
          model={conversation.model}
          historyTruncated={conversation.truncated}
          older={conversation.older}
        />
      ) : (
        <div
          className="app-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4"
          data-testid="chat-print-run-summary"
        >
          <AgentFlow
            agent={run}
            now={now}
            renderText={(text) => (
              <ChatMarkdown text={text} workspaceId={workspaceId} cwd={cwd} rootPath={rootPath} />
            )}
          />
        </div>
      )}
    </div>
  );
}

export function RunStopButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      size="icon-sm"
      variant="outline"
      title={t("chat.run.stop")}
      aria-label={t("chat.run.stop")}
      onClick={onClick}
    >
      <Square aria-hidden className="size-3 fill-current text-(--state-error-fg)" />
    </Button>
  );
}
