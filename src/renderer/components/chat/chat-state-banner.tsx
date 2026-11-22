import { useTranslation } from "react-i18next";
import type { ChatStatus } from "../../../../packages/remote-protocol/src/view";
import { type BannerScope, useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { MIN_CLAUDE_VERSION } from "../../services/chat/claude/versions";
import { MIN_CODEX_VERSION } from "../../services/chat/codex/controller";
import { Banner } from "../ui/banner";

type ChatNoticeStatus = Pick<ChatStatus, "agent" | "process"> & {
  phase?: string | undefined;
  error?: string | undefined;
  version?: string | null | undefined;
  exit?: ChatStatus["exit"];
  phaseRevision?: number | undefined;
  signedOut?: boolean | undefined;
};

export function ChatPhaseBanner({
  scope,
  status,
  onRestart,
  onRetry = onRestart,
  className,
}: {
  scope: BannerScope;
  status: ChatNoticeStatus;
  onRestart?: () => void;
  onRetry?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const claude = status.agent === "claude";
  const words = (name: string) => t(claude ? `chat.phase.${name}` : `chat.codex.${name}`);
  const retry = onRetry ? [{ label: t("chat.phase.retry"), onAction: onRetry }] : undefined;
  const phase = status.phase ?? (status.process === "exited" ? "ended" : undefined);
  const { dismiss, dismissed } = useBannerDismissal(
    [...scope, "phase"],
    [
      phase,
      status.phaseRevision,
      status.error,
      status.version,
      status.exit?.code,
      status.exit?.signal,
      status.exit?.stderrTail,
    ],
    true,
  );
  if (dismissed) return null;
  const wrap = (banner: React.ReactNode) =>
    className ? <div className={className}>{banner}</div> : banner;
  switch (phase) {
    case "starting":
      return wrap(<Banner variant="info" message={words("starting")} />);
    case "held":
      return wrap(<Banner variant="warning" message={words("held")} />);
    case "ended":
      return wrap(
        <Banner
          variant="info"
          message={words("ended")}
          dismiss={dismiss}
          details={status.exit?.stderrTail || undefined}
          {...(onRestart
            ? { actions: [{ label: t("chat.phase.restart"), onAction: onRestart }] }
            : {})}
        />,
      );
    case "not-found":
      return wrap(
        <Banner
          variant="error"
          message={words("not_found")}
          dismiss={dismiss}
          details={status.error}
          {...(retry ? { actions: retry } : {})}
        />,
      );
    case "failed":
      return wrap(
        <Banner
          variant="error"
          message={
            status.error === "old-version"
              ? t(claude ? "chat.phase.old_version" : "chat.codex.old_version", {
                  version: status.version ?? "?",
                  min: claude ? MIN_CLAUDE_VERSION : MIN_CODEX_VERSION,
                })
              : words("failed")
          }
          dismiss={dismiss}
          details={status.error === "old-version" ? undefined : status.error}
          {...(retry ? { actions: retry } : {})}
        />,
      );
    default:
      return null;
  }
}

export function ChatSignedOutBanner({
  scope,
  status,
  onSignIn,
  onCheck,
}: {
  scope: BannerScope;
  status: ChatNoticeStatus;
  /** Opens a terminal there that signs in, shown here: where this device may. */
  onSignIn?: () => void;
  /** Asks its program again whether it is signed in: where this device may. */
  onCheck?: () => void;
}) {
  const { t } = useTranslation();
  const signedOut = status.signedOut && status.process === "running";
  const { dismiss, dismissed } = useBannerDismissal(
    [...scope, "signed-out"],
    signedOut ? [true] : undefined,
    true,
  );
  if (!signedOut || dismissed) return null;
  const actions = [
    ...(onSignIn ? [{ label: t("chat.codex.sign_in"), onAction: onSignIn }] : []),
    ...(onCheck ? [{ label: t("chat.codex.sign_in_check"), onAction: onCheck }] : []),
  ];
  return (
    <div className="shrink-0" data-testid="codex-signed-out">
      <Banner
        variant="warning"
        message={t("chat.codex.signed_out")}
        dismiss={dismiss}
        {...(actions.length > 0 ? { actions } : {})}
      />
    </div>
  );
}
