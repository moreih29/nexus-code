// What a Claude or Codex tab's pane shows of a `claude -p` or `codex exec`
// run its session started: its state, request, tools and answer, as the app
// recorded them; with stopping it while it runs, and opening its session in
// a tab of its own once it ended.

import { Square, SquareArrowOutUpRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRun } from "../../../shared/claude/activity";
import { useNow } from "../../services/agent-sessions/use-family";
import { stopPrintRun } from "../../services/chat/print-runs";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { AgentFlow, toolCount } from "../agent-list/agent-flow";
import {
  AgentDuration,
  AgentGlyph,
  agentStateColor,
  agentStateLabel,
} from "../agent-list/agent-status";
import { Button } from "../ui/button";
import { ChatMarkdown } from "./chat-markdown";

/** How many characters of a session id say which one it is. */
const ID_SHOWN = 8;

export function PrintRunPane({
  workspaceId,
  tabId,
  cwd,
  rootPath,
  run,
  visible,
}: {
  workspaceId: string;
  tabId: string;
  /** Where the tab's session runs, which a run started from its commands shares. */
  cwd: string;
  rootPath: string;
  run: AgentRun;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const running = run.end === undefined;
  const now = useNow(visible && running);
  const [stopFailed, setStopFailed] = useState(false);
  const stop = () => {
    setStopFailed(false);
    void stopPrintRun(workspaceId, tabId, run.id).then((stopped) => setStopFailed(!stopped));
  };
  const { sessionId } = run;
  const codex = run.program === "codex";
  const kind = [
    codex ? t("chat.run.kind_codex") : t("chat.run.kind"),
    run.model,
    run.endpoint,
    sessionId === undefined ? undefined : sessionId.slice(0, ID_SHOWN),
    run.toolsTold ? toolCount(run) : undefined,
  ].filter((part): part is string => part !== undefined);
  // A Codex tab goes on with a `codex exec` run's thread, as a Claude tab
  // goes on with a copy of a `claude -p` run's session.
  const openInTab = (id: string) =>
    codex
      ? openCodexTab(workspaceId, { cwd, threadId: id })
      : openClaudeTab(workspaceId, { cwd, sessionId: id });
  return (
    <div
      className="app-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
      data-testid="chat-print-run"
    >
      <header className="flex items-center gap-3">
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
          {running ? (
            <RunStopButton onClick={stop} />
          ) : (
            sessionId !== undefined && (
              <Button
                size="icon-sm"
                variant="outline"
                title={t("chat.run.open_in_tab")}
                aria-label={t("chat.run.open_in_tab")}
                onClick={() => openInTab(sessionId)}
              >
                <SquareArrowOutUpRight aria-hidden className="size-3.5" />
              </Button>
            )
          )}
        </div>
      </header>
      {stopFailed && (
        <p className="text-app-ui-sm text-muted-foreground">{t("chat.run.stop_failed")}</p>
      )}
      <AgentFlow
        agent={run}
        now={now}
        renderText={(text) => (
          <ChatMarkdown text={text} workspaceId={workspaceId} cwd={cwd} rootPath={rootPath} />
        )}
      />
    </div>
  );
}

/** Stops a running run, with the square a session's interrupt shows. */
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
