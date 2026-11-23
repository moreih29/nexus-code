import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNow } from "../../hooks/use-now";
import type { ChatModel, TurnRetry } from "../../services/chat/model";
import { agentsOf } from "../../services/chat/panel";
import { formatTokens } from "../../services/chat/usage-line";
import { elapsedLabel } from "../agent-list/agent-status";
import { StateGlyph } from "../agent-list/session-status";
import { GROUP_STATE, GROUP_TINT } from "../agent-list/status-view";

export function StatusLine({ model }: { model: ChatModel }) {
  const { t } = useTranslation();
  const turn = model.turn;
  const now = useNow(
    model.running && (turn?.startedAt !== undefined || turn?.lastActivityAt !== undefined),
  );
  if (!model.running || !turn) return null;

  const quiet = generatingElapsed(model, now);
  const activity =
    quiet === undefined
      ? activityOf(model, t, now)
      : t("chat.status.generating", { elapsed: elapsedLabel(quiet) });
  const elapsed =
    quiet === undefined && turn.startedAt !== undefined ? now - turn.startedAt : undefined;
  const tokens = turn.outputTokens + turn.thinkingTokens;
  const agents = agentsOf(model).filter((a) => a.status === "running").length;
  const waiting = model.permissions.length > 0 && !model.interrupting;

  return (
    <div
      className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-app-micro text-muted-foreground"
      role="status"
      aria-live="polite"
      data-testid="chat-status"
    >
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden">
        {waiting ? (
          <StateGlyph state={GROUP_STATE.attention} className={GROUP_TINT.attention} />
        ) : (
          <LoaderCircle className="size-3.5 animate-spin text-[var(--state-loading-indicator)]" />
        )}
      </span>
      <span className="min-w-0 truncate text-foreground">{activity}</span>
      {elapsed !== undefined && <span className="shrink-0">{elapsedLabel(elapsed)}</span>}
      {tokens > 0 && (
        <span className="shrink-0">{t("chat.status.tokens", { count: formatTokens(tokens) })}</span>
      )}
      {agents > 0 && <span className="shrink-0">{t("chat.status.agents", { count: agents })}</span>}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

export function generatingElapsed(model: ChatModel, now: number): number | undefined {
  const turn = model.turn;
  if (!model.running || turn?.lastActivityAt === undefined) return undefined;
  const elapsed = now - turn.lastActivityAt;
  if (
    elapsed < 3_000 ||
    model.interrupting ||
    model.permissions.length > 0 ||
    turn.retry ||
    turn.status === "compacting" ||
    Object.values(model.tools).some(
      (tool) =>
        tool.parentToolUseId === null && (tool.status === "running" || tool.status === "streaming"),
    )
  )
    return undefined;
  return elapsed;
}

export function retryText(retry: TurnRetry, t: Translate, now: number): string {
  const parts = [
    retry.maxRetries
      ? t("chat.status.retrying_of", { attempt: retry.attempt, max: retry.maxRetries })
      : t("chat.status.retrying", { attempt: retry.attempt }),
  ];
  if (retry.reason) {
    const reason = t(`chat.status.retry_reason.${retry.reason}`);
    parts.push(
      retry.status === undefined
        ? reason
        : t("chat.status.retry_code", { reason, code: retry.status }),
    );
  }
  if (retry.at !== undefined && retry.delayMs !== undefined) {
    const left = retry.at + retry.delayMs - now;
    if (left >= 1_000) parts.push(t("chat.status.retry_in", { seconds: Math.ceil(left / 1_000) }));
  }
  return parts.join(" · ");
}

function activityOf(model: ChatModel, t: Translate, now: number): string {
  const turn = model.turn;
  if (model.interrupting) return t("chat.status.interrupting");
  if (turn?.retry) return retryText(turn.retry, t, now);
  if (turn?.status === "compacting") return t("chat.status.compacting");
  if (model.permissions.length > 0) return t("chat.status.waiting_permission");
  const blocks = model.streaming ? Object.values(model.streaming.blocks) : [];
  const last = blocks[blocks.length - 1];
  if (last?.type === "thinking") return t("chat.status.thinking");
  if (last?.type === "text") return t("chat.status.writing");
  const tool = Object.values(model.tools).find(
    (x) => x.status === "running" && x.parentToolUseId === null,
  );
  if (tool) return t("chat.status.running_tool", { tool: tool.displayName || tool.name });
  if (turn?.status === "requesting") return t("chat.status.requesting");
  return t("chat.status.working");
}
