import i18next from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/dialog-header";
import { showToast } from "@/components/ui/toast";
import { CONSENT_AGENT_NAMES, consentDetailsOf } from "../../../shared/cli/consent-copy";
import type { CliChange, CliConsentAnswer } from "../../../shared/cli/ui";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { createListenerBus } from "../../../shared/util/listener-bus";

export interface CliConsentPrompt {
  /** Main's id for it, for another device to answer it by. */
  readonly id?: string;
  readonly fromWorkspace: string;
  readonly fromTab: string;
  /** The agent whose tab asks, when a Claude or Codex tab does; none for a terminal. */
  readonly fromAgent?: ChatAgent;
  /** The user's other computer the agent asks from, by its name; none for this one. */
  readonly fromDevice?: string;
  readonly toWorkspace: string;
  readonly sameWorkspace?: boolean;
  readonly change: CliChange;
  readonly timeoutMs?: number;
}

interface Pending {
  readonly prompt: CliConsentPrompt;
  readonly resolve: (answer: CliConsentAnswer) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

let queue: Pending[] = [];
const bus = createListenerBus();
export const CONSENT_CONFIRM_BUTTON_CLASS = "hover:bg-primary/90 active:bg-primary/80";
export const CONSENT_DESCRIPTION_CLASS = "break-keep [overflow-wrap:anywhere]";

function settle(pending: Pending, answer: CliConsentAnswer): void {
  if (!queue.includes(pending)) return;
  queue = queue.filter((p) => p !== pending);
  clearTimeout(pending.timer);
  pending.resolve(answer);
  bus.notify();
}

/**
 * Answers the prompt `id` as the user would, from their device named `by`,
 * taking it down (or out of the queue) with a toast saying so. False when
 * no prompt `id` waits.
 */
export function settleCliConsent(
  id: string,
  answer: "once" | "session" | "deny",
  by?: string,
): boolean {
  const pending = queue.find((p) => p.prompt.id === id);
  if (!pending || (answer === "session" && pending.prompt.change.eachTime)) return false;
  settle(pending, answer);
  if (by) {
    const toastAnswer = answer === "once" && pending.prompt.change.eachTime ? "allow" : answer;
    showToast({
      kind: "info",
      message: i18next.t(`settings:agentCli.consent.answered_${toastAnswer}`, { device: by }),
    });
  }
  return true;
}

export function askCliConsent(prompt: CliConsentPrompt): Promise<CliConsentAnswer> {
  return new Promise((resolve) => {
    const { timeoutMs } = prompt;
    const timer =
      timeoutMs !== undefined ? setTimeout(() => settle(pending, "timeout"), timeoutMs) : undefined;
    const pending: Pending = { prompt, resolve, ...(timer !== undefined ? { timer } : {}) };
    queue.push(pending);
    bus.notify();
  });
}

/** The action already names the target for these approval prompts. */
export function consentNamesTarget(kind: string): boolean {
  return kind === "instructionsEdit" || kind === "profileAdd";
}

/**
 * Who asks and for what, as the prompt says it: an agent of another
 * computer by that computer, a Claude or Codex tab as one, else a terminal.
 */
export function describeConsent(
  t: (key: string, values: Record<string, string>) => string,
  prompt: Pick<
    CliConsentPrompt,
    "fromWorkspace" | "fromTab" | "fromAgent" | "fromDevice" | "toWorkspace" | "sameWorkspace"
  >,
  action: string,
  namesTarget = false,
  sandbox = false,
): string {
  if (sandbox) {
    return t(
      prompt.sameWorkspace
        ? "agentCli.consent.sandbox_description_same_workspace"
        : "agentCli.consent.sandbox_description",
      { tab: prompt.fromTab, from: prompt.fromWorkspace, to: prompt.toWorkspace },
    );
  }
  const destination = namesTarget
    ? ""
    : t("agentCli.consent.destination", { to: prompt.toWorkspace });
  if (prompt.fromDevice) {
    return t("agentCli.consent.remote_description", {
      device: prompt.fromDevice,
      tab: prompt.fromTab,
      destination,
      action,
    });
  }
  const from = prompt.fromWorkspace;
  if (prompt.fromAgent) {
    return t("agentCli.consent.agent_description", {
      agent: CONSENT_AGENT_NAMES[prompt.fromAgent],
      tab: prompt.fromTab,
      from,
      destination,
      action,
    });
  }
  return t("agentCli.consent.description", {
    tab: prompt.fromTab,
    from,
    destination,
    action,
  });
}

/**
 * The question a prompt asks, by what it would change: for an agent of
 * another computer (`remote`), whether it may change this one.
 */
export function consentTitleOf(kind: string, remote: boolean) {
  if (kind === "permissionAllow" || kind === "permissionDeny") {
    return "agentCli.consent.permission_title" as const;
  }
  if (kind === "chatMode") return "agentCli.consent.mode_title" as const;
  if (kind === "chatProfile" || kind === "chatProfileNew") {
    return "agentCli.consent.profile_title" as const;
  }
  if (kind === "profileAdd") return "agentCli.consent.profile_add_title" as const;
  if (kind === "instructionsEdit") return "agentCli.consent.instructions_title" as const;
  if (kind === "chatRewind" || kind === "chatRewindFiles") {
    return "agentCli.consent.rewind_title" as const;
  }
  if (kind === "chatRemoteControlOn") return "agentCli.consent.remote_control_title" as const;
  if (kind === "sandboxExecution") return "agentCli.consent.sandbox_title" as const;
  if (kind === "noteRecord") return "agentCli.consent.record_title" as const;
  return remote ? ("agentCli.consent.remote_title" as const) : ("agentCli.consent.title" as const);
}

export function CliConsentDialogRoot(): React.JSX.Element {
  const { t } = useTranslation("settings");
  const [active, setActive] = useState<Pending | null>(queue[0] ?? null);

  useEffect(() => bus.subscribe(() => setActive(queue[0] ?? null)), []);

  const prompt = active?.prompt;
  const change = prompt?.change;
  const copy = change && consentDetailsOf(t, change);
  const action = change
    ? t(`agentCli.consent.action.${change.kind}`, { detail: copy?.detail ?? "" })
    : "";
  const sandbox = change?.kind === "sandboxExecution";
  const description = prompt
    ? describeConsent(t, prompt, action, consentNamesTarget(prompt.change.kind), sandbox)
    : "";

  return (
    <Dialog
      open={active !== null}
      onOpenChange={(open) => {
        if (!open && active) settle(active, "deny");
      }}
      size="sm"
    >
      <DialogHeader
        title={t(consentTitleOf(prompt?.change.kind ?? "", !!prompt?.fromDevice))}
        description={description}
        descriptionClassName={CONSENT_DESCRIPTION_CLASS}
      />
      {copy?.body && (
        // What an answer lets run, whole: its first line can hide the rest.
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-(--radius-control) bg-muted px-2 py-1.5 font-mono text-app-ui-sm text-foreground">
          {copy.body}
        </pre>
      )}
      {prompt?.timeoutMs !== undefined && (
        <p className="mt-2 text-app-ui-sm text-muted-foreground">
          {t("agentCli.consent.timeout", { seconds: Math.round(prompt.timeoutMs / 1000) })}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => active && settle(active, "deny")}
          autoFocus
        >
          {t("agentCli.consent.deny")}
        </Button>
        {!change?.eachTime && (
          <Button variant="outline" size="sm" onClick={() => active && settle(active, "session")}>
            {t("agentCli.consent.session")}
          </Button>
        )}
        <Button
          variant="default"
          size="sm"
          className={CONSENT_CONFIRM_BUTTON_CLASS}
          onClick={() => active && settle(active, "once")}
        >
          {t(change?.eachTime ? "agentCli.consent.allow" : "agentCli.consent.once")}
        </Button>
      </div>
    </Dialog>
  );
}
