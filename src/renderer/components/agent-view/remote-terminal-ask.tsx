/**
 * Under another computer's terminal, while its Claude Code asks for leave
 * (its session's `waiting.requestId`): what it asks, and the answers, as
 * this computer's agent list words and draws a terminal agent's request
 * (permission-asks). An answer goes as terminal.answer, an answer for an
 * agent and no typing, so it is chat.control's: it works where the
 * computer lets this one only look at its terminals. Allowing it always is
 * offered where Claude Code offers it, and denying it to stop the turn
 * where it is not a subagent's (all of them from a computer before
 * protocol 0.13.2, which does not tell). The terminal's own prompt can
 * answer it too; a request answered there or over is told.
 */

import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RpcParams } from "../../../../packages/remote-protocol/src/rpc";
import type { IpcResult } from "../../../shared/ipc/result";
import type { TerminalAsk } from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { Button } from "../ui/button";

export type TerminalDecision = RpcParams<"terminal.answer">["decision"];

/** The tool a request is for and what it is for, as its one line tells them ("Bash npm test"). */
export function askParts(text: string): { tool: string; target: string } {
  const at = text.indexOf(" ");
  return at < 0
    ? { tool: text, target: "" }
    : { tool: text.slice(0, at), target: text.slice(at + 1) };
}

export function RemoteTerminalAsk({
  ask,
  onAnswer,
  onAnswered,
}: {
  ask: TerminalAsk;
  /** Sends the answer there. */
  onAnswer: (decision: TerminalDecision) => Promise<IpcResult<unknown>>;
  /** It went through: the card leaves, before the list says the request is gone. */
  onAnswered: () => void;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { tool, target } = askParts(ask.text);

  const answer = async (decision: TerminalDecision) => {
    setSending(true);
    setFailure(null);
    const result = await onAnswer(decision);
    setSending(false);
    if (result.ok) {
      onAnswered();
      return;
    }
    setFailure(
      result.kind === "not-found"
        ? t("agentList.permission.failed")
        : t("agentView.remote.failed", { message: result.message }),
    );
  };

  return (
    <div className="shrink-0 border-border border-t px-3 py-2">
      <section
        aria-label={t("agentList.permission.title")}
        className="mx-auto flex max-w-[860px] flex-col gap-2 rounded-(--radius-raised) border border-(--state-warning-fg)/40 bg-(--state-warning-fg)/5 p-3"
        data-testid="remote-terminal-ask"
      >
        <span className="flex min-w-0 items-center gap-2 text-app-ui-sm text-(--state-warning-fg)">
          <CircleAlert aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{t("agentList.permission.title")}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-app-body-emphasis text-foreground">{tool}</span>
          {target && (
            <span
              className="min-w-0 break-all font-mono text-app-ui-sm text-foreground"
              title={target}
            >
              {target}
            </span>
          )}
        </span>
        <span className="flex flex-wrap gap-2">
          <Button size="sm" disabled={sending} onClick={() => void answer("allow")}>
            {t("agentList.permission.allow")}
          </Button>
          {ask.always !== false && (
            <Button
              size="sm"
              variant="outline"
              disabled={sending}
              onClick={() => void answer("allowAlways")}
            >
              {t("agentList.permission.allow_always")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={sending}
            onClick={() => void answer("deny")}
          >
            {t("agentList.permission.deny_send")}
          </Button>
          {ask.subagent !== true && (
            <Button
              size="sm"
              variant="outline"
              disabled={sending}
              onClick={() => void answer("denyStop")}
            >
              {t("agentList.permission.deny_stop")}
            </Button>
          )}
        </span>
        <span
          className={cn(
            "text-app-micro",
            failure ? "text-(--state-error-fg)" : "text-muted-foreground",
          )}
          {...(failure ? { role: "alert" } : {})}
        >
          {failure ?? t("agentList.permission.terminal_too")}
        </span>
      </section>
    </div>
  );
}
