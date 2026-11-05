// What a Claude tab's pane shows of a `claude -p` run its session started:
// its state, request, tools and answer, as the app recorded them; with
// stopping it while it runs, and opening its session in a tab of its own
// once it ended.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRun } from "../../../shared/claude/activity";
import { stopPrintRun } from "../../services/chat/print-runs";
import { useNow } from "../../services/sessions/use-family";
import { openClaudeTab } from "../../state/operations/tabs";
import {
  AgentDuration,
  AgentGlyph,
  agentStateColor,
  agentStateLabel,
} from "../sessions/agent-status";
import { ToolList } from "../sessions/tool-list";
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
  /** Where the tab's session runs, which a run started from its Bash shares. */
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
  const kind = [
    t("chat.run.kind"),
    run.model,
    run.sessionId === undefined ? undefined : run.sessionId.slice(0, ID_SHOWN),
  ].filter((part): part is string => part !== undefined);
  return (
    <div
      className="app-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
      data-testid="chat-print-run"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <span className="truncate font-mono text-app-micro text-muted-foreground">
          {kind.join(" · ")}
        </span>
        <span className="inline-flex items-center gap-1.5 text-app-ui-sm">
          <AgentGlyph state={run.state} />
          <span className={agentStateColor(run.state)}>{agentStateLabel(run.state)}</span>
          <AgentDuration agent={run} className="text-app-ui-sm" />
        </span>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <Button size="sm" variant="outline" onClick={stop}>
            {t("chat.run.stop")}
          </Button>
        ) : (
          run.sessionId !== undefined && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openClaudeTab(workspaceId, { cwd, sessionId: run.sessionId })}
            >
              {t("chat.run.open_in_tab")}
            </Button>
          )
        )}
        {stopFailed && (
          <span className="text-app-ui-sm text-muted-foreground">{t("chat.run.stop_failed")}</span>
        )}
      </div>
      {run.prompt && (
        <Section title={t("sessions.agents.detail.prompt")}>
          <p className="app-scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-app-body text-foreground">
            {run.prompt}
          </p>
        </Section>
      )}
      <Section
        title={t("sessions.agents.detail.activity")}
        aside={
          run.toolsTold
            ? run.failedCount > 0
              ? t("sessions.agents.tools_failed", { count: run.toolCount, failed: run.failedCount })
              : t("sessions.agents.tools", { count: run.toolCount })
            : undefined
        }
      >
        {!run.toolsTold ? (
          <p className="text-app-ui-sm text-muted-foreground">
            {t("sessions.agents.detail.tools_untold")}
          </p>
        ) : run.tools.length === 0 ? (
          <p className="text-app-ui-sm text-muted-foreground">
            {t("sessions.agents.detail.tools_none")}
          </p>
        ) : (
          <ToolList key={run.id} tools={run.tools} now={now} />
        )}
      </Section>
      <Section title={t("sessions.agents.detail.answer")}>
        {run.answer ? (
          <ChatMarkdown text={run.answer} workspaceId={workspaceId} cwd={cwd} rootPath={rootPath} />
        ) : (
          <p className="text-app-ui-sm text-muted-foreground">
            {running
              ? t("sessions.agents.detail.answer_pending")
              : run.exitCode !== undefined && run.exitCode !== 0
                ? t("sessions.agents.exit_code", { code: run.exitCode })
                : t("sessions.agents.detail.answer_none")}
          </p>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-baseline gap-2 text-app-label uppercase text-muted-foreground">
        {title}
        {aside && <span className="normal-case">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}
