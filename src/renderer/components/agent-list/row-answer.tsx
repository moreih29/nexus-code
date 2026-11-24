import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PermissionAsk, SessionActivity } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import { markAnswered, useUnansweredAsks } from "../../services/agent-sessions/answered-asks";
import type { AgentSession } from "../../services/agent-sessions/model";
import { useFirstPermission } from "../../services/agent-sessions/use-row-facts";
import { existingChatController } from "../../services/chat/claude/controller";
import { existingCodexController } from "../../services/chat/codex/controller";
import { Button } from "../ui/button";
import { showToast } from "../ui/toast";

const NO_ASKS: readonly PermissionAsk[] = [];

export function RowAnswer({
  session,
  activity,
  testId = "agent-row-answer",
}: {
  session: AgentSession;
  activity: SessionActivity | undefined;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const firstRequest = useFirstPermission(session);
  const asks = useUnansweredAsks(session, activity?.asks ?? NO_ASKS);
  let answer: ((allow: boolean) => Promise<void>) | null = null;
  if (session.kind !== "terminal") {
    const request = firstRequest;
    const controller =
      session.kind === "codex"
        ? existingCodexController(session.workspaceId, session.tabId)
        : existingChatController(session.workspaceId, session.tabId);
    if (
      request &&
      controller &&
      request.toolName !== "AskUserQuestion" &&
      request.toolName !== "ExitPlanMode"
    ) {
      answer = (allow) =>
        controller.answerPermission(request, allow ? { kind: "allow" } : { kind: "deny" });
    }
  } else {
    const ask = asks[0];
    if (ask) {
      answer = async (allow) => {
        const result = await ipcCallResult("claude", "answerPermission", {
          workspaceId: session.workspaceId,
          tabId: session.tabId,
          askId: ask.id,
          answer: allow ? "allow" : "deny",
          ...(allow ? {} : { message: "" }),
        });
        if (!result.ok || !result.value) throw new Error(t("agentList.list.answer_failed"));
        markAnswered(session, ask.id);
      };
    }
  }
  if (!answer) return null;
  const send = (allow: boolean) => {
    if (!answer) return;
    setSending(true);
    answer(allow)
      .catch((failure: unknown) =>
        showToast({ kind: "error", message: (failure as Error).message }),
      )
      .finally(() => setSending(false));
  };
  return (
    <div className="pointer-events-none relative flex justify-end pt-1" data-testid={testId}>
      <div className="pointer-events-auto flex shrink-0 items-center gap-1">
        <Button
          size="icon-sm"
          variant="outline"
          className="size-7"
          disabled={sending}
          tooltip={t("chat.permission.deny")}
          onClick={() => send(false)}
          data-testid={`${testId}-deny`}
        >
          <X aria-hidden className="size-3.5" />
        </Button>
        <Button
          size="sm"
          className="h-7"
          disabled={sending}
          onClick={() => send(true)}
          data-testid={`${testId}-allow`}
        >
          {t("chat.permission.allow")}
        </Button>
      </div>
    </div>
  );
}
