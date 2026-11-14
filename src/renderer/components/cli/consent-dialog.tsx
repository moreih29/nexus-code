/**
 * Asks the user whether an agent may change another workspace than its
 * terminal's own, or answer another session's permission request, for the
 * nexus CLI (main/features/cli/consent). One prompt at a time; more wait
 * their turn. A prompt left unanswered is taken down after its timeout and
 * counts as turned down.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/dialog-header";
import { askedEachTime, type CliChange, type CliConsentAnswer } from "../../../shared/cli/ui";
import { createListenerBus } from "../../../shared/util/listener-bus";

export interface CliConsentPrompt {
  readonly fromWorkspace: string;
  readonly fromTab: string;
  /** Whether the agent manager asks: it is in no workspace of the user's. */
  readonly fromManager: boolean;
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
  // What is typed, sent or run, an answer to a permission request, a mode
  // that lets more run unasked, and another profile (another account) for a
  // tab are asked about each time.
  const kind = prompt?.change.kind;
  const permission = kind === "permissionAllow" || kind === "permissionDeny";
  const profile = kind === "chatProfile" || kind === "chatProfileNew";
  const eachTime = prompt !== undefined && askedEachTime(prompt.change);
  const description = !prompt
    ? ""
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
