/**
 * Where another computer's chat stands with its program, in the banners a
 * chat here shows over its messages: starting, held, ended (with what it
 * wrote to stderr, and starting it again), its session not found, or
 * failed (and trying again). A computer before protocol 0.13.0 tells only
 * that its program exited: that ends it, with nothing to do from here.
 *
 * A Codex chat whose program is not signed in shows the banner a Codex
 * tab here does, with signing in there and asking it again.
 */

import { useTranslation } from "react-i18next";
import type { ChatStatus } from "../../../../packages/remote-protocol/src/view";
import { MIN_CODEX_VERSION } from "../../services/chat/codex/controller";
import { MIN_CLAUDE_VERSION } from "../../services/chat/versions";
import { Banner } from "../ui/banner";

export function RemotePhaseBanner({
  status,
  onRestart,
}: {
  status: ChatStatus;
  /** Starts it again, or opens it again where it failed: where this device may. */
  onRestart?: () => void;
}) {
  const { t } = useTranslation();
  const claude = status.agent === "claude";
  const words = (name: string) => t(claude ? `chat.phase.${name}` : `chat.codex.${name}`);
  const retry = onRestart ? [{ label: t("chat.phase.retry"), onAction: onRestart }] : undefined;
  const phase = status.phase ?? (status.process === "exited" ? "ended" : undefined);
  switch (phase) {
    case "starting":
      return <Banner variant="info" message={words("starting")} />;
    case "held":
      return <Banner variant="warning" message={words("held")} />;
    case "ended":
      return (
        <Banner
          variant="info"
          message={words("ended")}
          details={status.exit?.stderrTail || undefined}
          {...(onRestart
            ? { actions: [{ label: t("chat.phase.restart"), onAction: onRestart }] }
            : {})}
        />
      );
    case "not-found":
      return (
        <Banner
          variant="error"
          message={words("not_found")}
          details={status.error}
          {...(retry ? { actions: retry } : {})}
        />
      );
    case "failed":
      return (
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
          details={status.error === "old-version" ? undefined : status.error}
          {...(retry ? { actions: retry } : {})}
        />
      );
    default:
      return null;
  }
}

export function RemoteSignedOutBanner({
  status,
  onSignIn,
  onCheck,
}: {
  status: ChatStatus;
  /** Opens a terminal there that signs in, shown here: where this device may. */
  onSignIn?: () => void;
  /** Asks its program again whether it is signed in: where this device may. */
  onCheck?: () => void;
}) {
  const { t } = useTranslation();
  // As a Codex tab here: only while its program runs.
  if (!status.signedOut || status.process !== "running") return null;
  const actions = [
    ...(onSignIn ? [{ label: t("chat.codex.sign_in"), onAction: onSignIn }] : []),
    ...(onCheck ? [{ label: t("chat.codex.sign_in_check"), onAction: onCheck }] : []),
  ];
  return (
    <div className="shrink-0" data-testid="codex-signed-out">
      <Banner
        variant="warning"
        message={t("chat.codex.signed_out")}
        {...(actions.length > 0 ? { actions } : {})}
      />
    </div>
  );
}
