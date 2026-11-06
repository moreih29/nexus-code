// The running turn in one line: what Claude is doing, for how long, and how
// much it has written. Shown only while a turn runs.

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatModel } from "../../services/chat/model";
import { agentsOf } from "../../services/chat/panel";

export function StatusLine({ model }: { model: ChatModel }) {
  const { t } = useTranslation();
  const turn = model.turn;
  const now = useNow(model.running && turn?.startedAt !== undefined);
  if (!model.running || !turn) return null;

  const activity = activityOf(model, t);
  const elapsed =
    turn.startedAt !== undefined ? Math.max(0, Math.floor((now - turn.startedAt) / 1000)) : null;
  const tokens = turn.outputTokens + turn.thinkingTokens;
  const agents = agentsOf(model).filter((a) => a.status === "running").length;

  return (
    <div
      className="flex items-center gap-2 text-app-micro text-muted-foreground"
      role="status"
      aria-live="polite"
      data-testid="chat-status"
    >
      {/* Clipped, so the turning icon's corners never make the dock scroll. */}
      <span className="inline-flex size-3.5 shrink-0 overflow-hidden">
        <LoaderCircle className="size-3.5 animate-spin text-[var(--state-loading-indicator)]" />
      </span>
      <span className="text-foreground">{activity}</span>
      {elapsed !== null && <span>{formatElapsed(elapsed)}</span>}
      {tokens > 0 && <span>{t("chat.status.tokens", { count: tokens })}</span>}
      {agents > 0 && <span>{t("chat.status.agents", { count: agents })}</span>}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function activityOf(model: ChatModel, t: Translate): string {
  const turn = model.turn;
  if (model.interrupting) return t("chat.status.interrupting");
  if (turn?.retry) {
    return turn.retry.maxRetries
      ? t("chat.status.retrying_of", { attempt: turn.retry.attempt, max: turn.retry.maxRetries })
      : t("chat.status.retrying", { attempt: turn.retry.attempt });
  }
  if (turn?.status === "compacting") return t("chat.status.compacting");
  if (model.permissions.length > 0) return t("chat.status.waiting_permission");
  const blocks = model.streaming ? Object.values(model.streaming.blocks) : [];
  const last = blocks[blocks.length - 1];
  if (last?.type === "thinking") return t("chat.status.thinking");
  if (last?.type === "text") return t("chat.status.writing");
  const tool = Object.values(model.tools).find(
    (x) => x.status === "running" && x.parentToolUseId === null,
  );
  if (tool) return t("chat.status.running_tool", { tool: tool.name });
  if (turn?.status === "requesting") return t("chat.status.requesting");
  return t("chat.status.working");
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
