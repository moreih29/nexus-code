// Agent list — the permission requests a Claude session waits on, answered
// from the detail panel: allow, allow always as Claude Code suggests, or
// deny, with words for Claude or stopping the turn. Claude Code shows the
// same request in its terminal, where it can be answered too; a request
// answered there leaves this list.

import { CircleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type {
  AgentRun,
  PermissionAlways,
  PermissionAnswer,
  PermissionAsk,
} from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import { markAnswered, useUnansweredAsks } from "../../services/agent-sessions/answered-asks";
import type { AgentSession } from "../../services/agent-sessions/model";
import { Button } from "../ui/button";
import { agentLabel } from "./agent-status";

/** The requests of `session` (of one of its agents, when `agents` holds only it), oldest first. */
export function PermissionAsks({
  session,
  asks,
  agents,
}: {
  session: AgentSession;
  asks: readonly PermissionAsk[];
  agents: readonly AgentRun[];
}) {
  // One answered here leaves at once, not with the next poll.
  const shown = useUnansweredAsks(session, asks);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {shown.map((ask) => (
        <AskCard
          // Keyed by the request, so an answer under way is its own.
          key={ask.id}
          session={session}
          ask={ask}
          agent={agents.find((agent) => agent.id === ask.agentId)}
        />
      ))}
    </div>
  );
}

function AskCard({
  session,
  ask,
  agent,
}: {
  session: AgentSession;
  ask: PermissionAsk;
  agent: AgentRun | undefined;
}) {
  const { t } = useTranslation();
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const answer = async (choice: PermissionAnswer) => {
    setSending(true);
    setFailed(false);
    const result = await ipcCallResult("claude", "answerPermission", {
      workspaceId: session.workspaceId,
      tabId: session.tabId,
      askId: ask.id,
      answer: choice,
      ...(choice === "deny" || choice === "denyStop" ? { message } : {}),
    });
    if (!result.ok || !result.value) {
      setSending(false);
      setFailed(true);
      return;
    }
    // It reached Claude Code, which takes the request away: the card leaves
    // now, and shows again if a poll still lists it a while later.
    markAnswered(session, ask.id);
  };
  const onDeny = (event: FormEvent) => {
    event.preventDefault();
    void answer("deny");
  };

  const always = ask.always.map((item) => alwaysLabel(item, t)).join(" · ");
  return (
    <section
      aria-label={t("agentList.permission.title")}
      className="flex flex-col gap-2 rounded-(--radius-raised) border border-(--state-warning-fg)/40 bg-(--state-warning-fg)/5 p-3"
    >
      <span className="flex min-w-0 items-center gap-2 text-app-ui-sm text-(--state-warning-fg)">
        <CircleAlert aria-hidden className="size-3 shrink-0" />
        <span className="truncate">
          {ask.agentId === undefined
            ? t("agentList.permission.title")
            : t("agentList.permission.from_agent", {
                name: agent ? agentLabel(agent) : t("agentList.agents.label_fallback"),
              })}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-app-body-emphasis text-foreground">{ask.tool}</span>
          {ask.target && (
            <span
              className="min-w-0 break-all font-mono text-app-ui-sm text-foreground"
              title={ask.target}
            >
              {ask.target}
            </span>
          )}
        </span>
        {ask.note && <span className="text-app-ui-sm text-muted-foreground">{ask.note}</span>}
      </span>
      {denying ? (
        <form onSubmit={onDeny} className="flex flex-col gap-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: the user just chose to deny, and types why next
            autoFocus
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={t("agentList.permission.message_placeholder")}
            aria-label={t("agentList.permission.message_placeholder")}
            disabled={sending}
            className="h-8 min-w-0 rounded-(--radius-control) border border-border bg-background px-2 text-app-ui-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={sending}>
              {t("agentList.permission.deny_send")}
            </Button>
            {ask.agentId === undefined && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() => void answer("denyStop")}
              >
                {t("agentList.permission.deny_stop")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={sending}
              onClick={() => setDenying(false)}
            >
              {t("agentList.permission.cancel")}
            </Button>
          </span>
        </form>
      ) : (
        <span className="flex flex-wrap gap-2">
          <Button size="sm" disabled={sending} onClick={() => void answer("allow")}>
            {t("agentList.permission.allow")}
          </Button>
          {ask.always.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={sending}
              title={always}
              onClick={() => void answer("allowAlways")}
            >
              {t("agentList.permission.allow_always")}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={sending} onClick={() => setDenying(true)}>
            {t("agentList.permission.deny")}
          </Button>
        </span>
      )}
      {ask.always.length > 0 && !denying && (
        <span className="break-all text-app-micro text-muted-foreground">
          {t("agentList.permission.always_hint", { what: always })}
        </span>
      )}
      <span
        className={cn(
          "text-app-micro",
          failed ? "text-(--state-error-fg)" : "text-muted-foreground",
        )}
      >
        {failed ? t("agentList.permission.failed") : t("agentList.permission.terminal_too")}
      </span>
    </section>
  );
}

/** What allowing always lets through, in words. */
function alwaysLabel(
  item: PermissionAlways,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (item.kind) {
    case "rule":
      return item.destination === "session"
        ? t("agentList.permission.always_session", { rule: item.rule })
        : item.rule;
    case "mode":
      return item.mode === "acceptEdits"
        ? t("agentList.permission.mode_accept_edits")
        : t("agentList.permission.mode", { mode: item.mode });
    case "directory":
      return t("agentList.permission.directory", { path: item.path });
  }
}
