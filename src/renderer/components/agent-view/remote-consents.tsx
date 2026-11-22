/**
 * Another computer's consent prompts (sessions.list's `consents`), at the
 * top of its group in the agent view's list: an agent asks to change
 * something there, and the user may answer from here as at that computer
 * (consent.answer). Each is told in the words and look of this computer's
 * own prompt (consent-dialog): what it asks, what it would run or write
 * (all of it, in a box that scrolls), the seconds left before it counts as
 * turned down, and the answers it allows ("until restart" not for one
 * asked about each time). Its own agent's too: the user answers it here as
 * from any other computer. One this computer may not answer (one too long
 * to be sent whole, one the settings there keep from here, or its own
 * agent's where that computer runs an older NexusCode) shows, to be
 * answered at that computer.
 */

import i18next, { type TFunction } from "i18next";
import { ShieldQuestion } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConsentAnswer,
  RemoteConsent,
  RemoteSession,
} from "../../../../packages/remote-protocol/src/rpc";
import { consentDetailsOf } from "../../../shared/cli/consent-copy";
import type { CliChangeKind } from "../../../shared/cli/ui";
import type { IpcResult } from "../../../shared/ipc/result";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { useNow } from "../../hooks/use-now";
import { ipcCallResult } from "../../ipc/client";
import { refreshPeerSessions } from "../../services/remote/room";
import { cn } from "../../utils/cn";
import {
  CONSENT_CONFIRM_BUTTON_CLASS,
  CONSENT_DESCRIPTION_CLASS,
  consentNamesTarget,
  consentTitleOf,
  describeConsent,
} from "../cli/consent-dialog";
import { Button } from "../ui/button";

/** How long a prompt found answered or over still shows, saying so. */
const GONE_SHOWN_MS = 1500;

const consentChanges = createListenerBus();
let settledConsents: ReadonlySet<string> = new Set();
const settledSnapshot = () => settledConsents;
const consentKey = (deviceId: string, id: string) => JSON.stringify([deviceId, id]);

/** Leaves answered prompts out of every view, including one still showing an older list. */
export function usePeerConsents(
  deviceId: string,
  consents: readonly RemoteConsent[] | undefined,
): RemoteConsent[] {
  const pending = useConsentIsPending();
  return (consents ?? []).filter((consent) => pending(deviceId, consent.id));
}

export function useConsentIsPending() {
  const settled = useSyncExternalStore(consentChanges.subscribe, settledSnapshot, settledSnapshot);
  return (deviceId: string, id: string) => !settled.has(consentKey(deviceId, id));
}

/** Matches the agent that asked on the serving device, using its workspace and tab. */
export function consentFromChat(
  { from }: RemoteConsent,
  { workspaceId, tabId }: { workspaceId: string; tabId: string },
): boolean {
  return !from.device && !from.manager && from.workspaceId === workspaceId && from.tabId === tabId;
}

export function PeerConsentCard({
  consent,
  deviceId,
  device,
  workspaceName,
  sessions,
}: {
  consent: RemoteConsent;
  deviceId: string;
  device: string;
  workspaceName: string;
  sessions: readonly RemoteSession[] | undefined;
}) {
  return (
    <RemoteConsentCard
      consent={consent}
      device={device}
      workspaceName={workspaceName}
      sessions={sessions}
      onAnswer={(answer) =>
        ipcCallResult("remote", "peerConsentAnswer", { deviceId, id: consent.id, answer })
      }
      onSettled={() => {
        const key = consentKey(deviceId, consent.id);
        if (settledConsents.has(key)) return;
        settledConsents = new Set(settledConsents).add(key);
        consentChanges.notify();
        refreshPeerSessions(deviceId);
      }}
    />
  );
}

/** What the agent asks to do, as the prompt here words it; a kind this app does not know, by its name. */
export function consentActionOf(t: TFunction<"settings">, change: RemoteConsent["change"]): string {
  const key = `agentCli.consent.action.${change.kind}`;
  return i18next.exists(key, { ns: "settings" })
    ? t(key as `agentCli.consent.action.${CliChangeKind}`, {
        detail: consentDetailsOf(t, change).detail,
      })
    : t("agentCli.consent.action_other", { kind: change.kind });
}

/**
 * Who asks to do what, and where (`to`, the workspace there it would
 * change), as the prompt here says it: an agent of another computer by
 * that computer, the agent manager as itself, else a tab of a workspace.
 */
export function consentSentenceOf(
  t: TFunction<"settings">,
  consent: RemoteConsent,
  to: string,
  sessions?: readonly RemoteSession[],
): string {
  const { from } = consent;
  const action = consentActionOf(t, consent.change);
  const namesTarget = consentNamesTarget(consent.change.kind);
  if (from.manager && !from.device) {
    const destination = namesTarget ? "" : t("agentCli.consent.destination", { to });
    return t("agentCli.consent.manager_description", { destination, action });
  }
  const kind = sessions?.find((session) => consentFromChat(consent, session))?.kind;
  return describeConsent(
    t,
    {
      fromWorkspace: from.workspaceName ?? from.workspaceId.slice(0, 8),
      fromTab: from.name ?? from.tabId.slice(0, 8),
      ...(kind === "claude" || kind === "codex" ? { fromAgent: kind } : {}),
      ...(from.device ? { fromDevice: from.device.name } : {}),
      toWorkspace: to,
      sameWorkspace: !from.device && from.workspaceId === consent.workspaceId,
    },
    action,
    namesTarget,
    consent.change.kind === "sandboxExecution",
  );
}

export function RemoteConsentCard({
  consent,
  device,
  workspaceName,
  sessions,
  onAnswer,
  onSettled,
}: {
  consent: RemoteConsent;
  /** The computer that asks the user. */
  device: string;
  /** The name of its workspace the prompt would change. */
  workspaceName: string;
  /** The serving computer's sessions, which identify the asking tab. */
  sessions?: readonly RemoteSession[] | undefined;
  /** Sends the answer there. */
  onAnswer: (answer: ConsentAnswer) => Promise<IpcResult<unknown>>;
  /** Answered here, or found answered there: every view leaves it out. */
  onSettled: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  // When it counts as turned down, by this computer's clock: what it had left as the list came.
  const deadline = useMemo(() => Date.now() + consent.expiresInMs, [consent.expiresInMs]);
  const now = useNow(true);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const [busy, setBusy] = useState<ConsentAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Run out: it was turned down there, and goes with the next list.
  if (seconds === 0 && busy === null) return null;

  const answer = async (choice: ConsentAnswer) => {
    setBusy(choice);
    setFailure(null);
    const result = await onAnswer(choice);
    if (result.ok) {
      onSettled();
      return;
    }
    setBusy(null);
    if (result.kind === "not-found") {
      setFailure(tc("agentView.remote.consentGone"));
      setTimeout(onSettled, GONE_SHOWN_MS);
      return;
    }
    setFailure(tc("agentView.remote.failed", { message: result.message }));
  };
  const button = (
    choice: ConsentAnswer,
    label: string,
    variant: "default" | "outline" | "ghost",
  ) => (
    <Button
      variant={variant}
      size="sm"
      className={choice === "once" ? CONSENT_CONFIRM_BUTTON_CLASS : undefined}
      loading={busy === choice}
      disabled={busy !== null}
      onClick={() => void answer(choice)}
    >
      {label}
    </Button>
  );

  const title = t(consentTitleOf(consent.change.kind, Boolean(consent.from.device)));
  const { body } = consentDetailsOf(t, consent.change);
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-2 rounded-(--radius-raised) border border-(--state-warning-fg)/40 bg-(--state-warning-fg)/5 p-3"
      data-testid="remote-consent"
    >
      <span className="flex min-w-0 items-start gap-2 text-app-ui-sm text-(--state-warning-fg)">
        <ShieldQuestion aria-hidden className="mt-0.5 size-3 shrink-0" />
        <span>{title}</span>
      </span>
      <p className={cn("text-app-ui-sm text-foreground", CONSENT_DESCRIPTION_CLASS)}>
        {consentSentenceOf(t, consent, workspaceName, sessions)}
      </p>
      {body && (
        // What an answer lets run, whole: its first line can hide the rest.
        <pre className="app-scrollbar max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-(--radius-control) bg-muted px-2 py-1.5 font-mono text-app-ui-sm text-foreground">
          {body}
        </pre>
      )}
      <p className="text-app-micro text-muted-foreground">
        {t("agentCli.consent.timeout", { seconds })}
      </p>
      {consent.answerable ? (
        <span className="flex flex-wrap justify-end gap-2">
          {button("deny", t("agentCli.consent.deny"), "ghost")}
          {!consent.eachTime && button("session", t("agentCli.consent.session"), "outline")}
          {button(
            "once",
            t(consent.eachTime ? "agentCli.consent.allow" : "agentCli.consent.once"),
            "default",
          )}
        </span>
      ) : (
        <p className="text-app-micro text-muted-foreground" data-testid="remote-consent-there">
          {tc("agentView.remote.consentThere", { device })}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-app-micro text-(--state-error-fg)">
          {failure}
        </p>
      )}
    </section>
  );
}
