/**
 * Asks the user whether an agent may change another workspace than its
 * terminal's own, or answer another session's permission request, for the
 * nexus CLI (main/features/cli/consent). One prompt at a time; more wait
 * their turn. A prompt left unanswered is taken down after its timeout and
 * counts as turned down; one answered on another device of the user's
 * (the remote's consent.answer) is taken down with a toast saying so.
 */

import i18next from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/dialog-header";
import { showToast } from "@/components/ui/toast";
import { type CliChange, type CliConsentAnswer, isEachTimeChange } from "../../../shared/cli/ui";
import { createListenerBus } from "../../../shared/util/listener-bus";

export interface CliConsentPrompt {
  /** Main's id for it, for another device to answer it by. */
  readonly id?: string;
  readonly fromWorkspace: string;
  readonly fromTab: string;
  /** Whether the agent manager asks: it is in no workspace of the user's. */
  readonly fromManager: boolean;
  /** The user's other computer the agent asks from, by its name; none for this one. */
  readonly fromDevice?: string;
  readonly toWorkspace: string;
  readonly change: CliChange;
  readonly timeoutMs: number;
}

interface Pending {
  readonly prompt: CliConsentPrompt;
  readonly resolve: (answer: CliConsentAnswer) => void;
}

let queue: Pending[] = [];
const bus = createListenerBus();

function settle(pending: Pending, answer: CliConsentAnswer): void {
  if (!queue.includes(pending)) return;
  queue = queue.filter((p) => p !== pending);
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
  if (!pending) return false;
  settle(pending, answer);
  if (by) {
    showToast({
      kind: "info",
      message: i18next.t(`settings:agentCli.consent.answered_${answer}`, { device: by }),
    });
  }
  return true;
}

/** Shows the prompt and resolves to the user's answer, or "timeout". */
export function askCliConsent(prompt: CliConsentPrompt): Promise<CliConsentAnswer> {
  return new Promise((resolve) => {
    const pending: Pending = { prompt, resolve };
    queue.push(pending);
    bus.notify();
    setTimeout(() => settle(pending, "timeout"), prompt.timeoutMs);
  });
}

export function CliConsentDialogRoot(): React.JSX.Element {
  const { t } = useTranslation("settings");
  const [active, setActive] = useState<Pending | null>(queue[0] ?? null);

  useEffect(() => bus.subscribe(() => setActive(queue[0] ?? null)), []);

  const prompt = active?.prompt;
  const action = prompt
    ? t(`agentCli.consent.action.${prompt.change.kind}`, { detail: prompt.change.detail ?? "" })
    : "";
  // An answer to a permission request, a mode that lets more run unasked,
  // and another profile (another account) for a tab are asked about each time.
  const kind = prompt?.change.kind;
  const permission = kind === "permissionAllow" || kind === "permissionDeny";
  const profile = kind === "chatProfile" || kind === "chatProfileNew";
  const eachTime = kind !== undefined && isEachTimeChange(kind);
  const description = !prompt
    ? ""
    : prompt.fromDevice
      ? t("agentCli.consent.remote_description", {
          device: prompt.fromDevice,
          tab: prompt.fromTab,
          to: prompt.toWorkspace,
          action,
        })
      : prompt.fromManager
        ? t("agentCli.consent.manager_description", { to: prompt.toWorkspace, action })
        : t("agentCli.consent.description", {
            tab: prompt.fromTab,
            from: prompt.fromWorkspace,
            to: prompt.toWorkspace,
            action,
          });

  return (
    <Dialog
      open={active !== null}
      onOpenChange={(open) => {
        if (!open && active) settle(active, "deny");
      }}
      size="sm"
    >
      <DialogHeader
        title={t(
          permission
            ? "agentCli.consent.permission_title"
            : kind === "chatMode"
              ? "agentCli.consent.mode_title"
              : profile
                ? "agentCli.consent.profile_title"
                : prompt?.fromDevice
                  ? "agentCli.consent.remote_title"
                  : "agentCli.consent.title",
        )}
        description={description}
      />
      {prompt?.change.body && (
        // What an answer lets run, whole: its first line can hide the rest.
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-(--radius-control) bg-muted px-2 py-1.5 font-mono text-app-ui-sm text-foreground">
          {prompt.change.body}
        </pre>
      )}
      <p className="mt-2 text-app-ui-sm text-muted-foreground">
        {t("agentCli.consent.timeout", {
          seconds: Math.round((prompt?.timeoutMs ?? 0) / 1000),
        })}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => active && settle(active, "deny")}
          autoFocus
        >
          {t("agentCli.consent.deny")}
        </Button>
        {!eachTime && (
          <Button variant="outline" size="sm" onClick={() => active && settle(active, "session")}>
            {t("agentCli.consent.session")}
          </Button>
        )}
        <Button variant="default" size="sm" onClick={() => active && settle(active, "once")}>
          {t("agentCli.consent.once")}
        </Button>
      </div>
    </Dialog>
  );
}
