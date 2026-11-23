import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type BannerScope, useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { retryReasonOf } from "../../services/chat/api-errors";
import type { ChatModel } from "../../services/chat/model";
import { Banner } from "../ui/banner";

type Translate = ReturnType<typeof useTranslation>["t"];

export function shownFailure(model: ChatModel) {
  if (model.running) return undefined;
  const failure = model.lastResult?.failure;
  if (!failure || failure.kind === "usage_limit" || failure.kind === "other") return undefined;
  return failure;
}

function reasonText(status: number | undefined, t: Translate): string {
  const reason = t(`chat.status.retry_reason.${retryReasonOf(status)}`);
  return status === undefined ? reason : t("chat.status.retry_code", { reason, code: status });
}

export function TurnFailureBanner({
  scope,
  model,
  onRetry,
}: {
  scope: BannerScope;
  model: ChatModel;
  onRetry: (text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const failure = shownFailure(model);
  const { dismiss, dismissed } = useBannerDismissal(
    [...scope, "turn-failure"],
    failure && [model.lastResult?.at, failure.kind, failure.status],
  );
  if (!failure || dismissed) return null;
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
