// Over the composer once a turn failed on the API: what went wrong and what
// helps. A transient error (a rate limit, an overloaded or failing server, a
// dropped connection) outlasted the program's own retries: trying again may
// help, and the banner offers it. A refused sign-in or request does not
// mend by trying again: the banner says what to fix. The plan's usage limit
// has its own banner.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { retryReasonOf } from "../../services/chat/api-errors";
import type { ChatModel } from "../../services/chat/model";
import { Banner } from "../ui/banner";

type Translate = ReturnType<typeof useTranslation>["t"];

/** The failure a banner is shown for: the last turn's, while no other runs. */
export function shownFailure(model: ChatModel) {
  if (model.running) return undefined;
  const failure = model.lastResult?.failure;
  if (!failure || failure.kind === "usage_limit" || failure.kind === "other") return undefined;
  return failure;
}

/** The reason in the status line's words, with the HTTP status: "Server overloaded (529)". */
function reasonText(status: number | undefined, t: Translate): string {
  const reason = t(`chat.status.retry_reason.${retryReasonOf(status)}`);
  return status === undefined ? reason : t("chat.status.retry_code", { reason, code: status });
}

export function TurnFailureBanner({
  model,
  onRetry,
}: {
  model: ChatModel;
  /** Sends the agent a message to go on, as the user would. */
  onRetry: (text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  // Closed for the turn it was shown for; the next failure shows again.
  const [closedAt, setClosedAt] = useState<number | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const failure = shownFailure(model);
  const at = model.lastResult?.at;
  if (!failure || (at !== undefined && closedAt === at)) return null;
  const dismiss = { label: t("chat.failure.dismiss"), onDismiss: () => setClosedAt(at) };
  if (failure.kind === "transient") {
    return (
      <div className="shrink-0" data-testid="chat-turn-failure">
        <Banner
          variant="warning"
          message={t("chat.failure.transient", { reason: reasonText(failure.status, t) })}
          dismiss={dismiss}
          actions={[
            {
              label: t("chat.failure.retry"),
              onAction: () => {
                if (sending) return;
                setSending(true);
                void onRetry(t("chat.failure.retry_prompt")).finally(() => setSending(false));
              },
            },
          ]}
        />
      </div>
    );
  }
  const message =
    failure.kind === "auth"
      ? failure.status === undefined
        ? t("chat.failure.auth_no_code")
        : t("chat.failure.auth", { code: failure.status })
      : t("chat.failure.request", { code: failure.status ?? 400 });
  return (
    <div className="shrink-0" data-testid="chat-turn-failure">
      <Banner variant="error" message={message} dismiss={dismiss} />
    </div>
  );
}
