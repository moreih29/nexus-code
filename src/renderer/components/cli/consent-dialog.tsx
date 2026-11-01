/**
 * Asks the user whether an agent may change another workspace than its
 * terminal's own, for the nexus CLI (main/features/cli/consent). One prompt
 * at a time; more wait their turn. A prompt left unanswered is taken down
 * after its timeout and counts as turned down.
 */

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { CliChange, CliConsentAnswer } from "../../../shared/cli/ui";
import { createListenerBus } from "../../../shared/util/listener-bus";

export interface CliConsentPrompt {
  readonly fromWorkspace: string;
  readonly fromTab: string;
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

  return (
    <Dialog
      open={active !== null}
      onOpenChange={(open) => {
        if (!open && active) settle(active, "deny");
      }}
      size="sm"
      aria-describedby={undefined}
    >
      <RadixDialog.Title className="text-app-body-emphasis text-foreground">
        {t("agentCli.consent.title")}
      </RadixDialog.Title>
      <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
        {prompt
          ? t("agentCli.consent.description", {
              tab: prompt.fromTab,
              from: prompt.fromWorkspace,
              to: prompt.toWorkspace,
              action,
            })
          : ""}
      </RadixDialog.Description>
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
        <Button variant="outline" size="sm" onClick={() => active && settle(active, "session")}>
          {t("agentCli.consent.session")}
        </Button>
        <Button variant="default" size="sm" onClick={() => active && settle(active, "once")}>
          {t("agentCli.consent.once")}
        </Button>
      </div>
    </Dialog>
  );
}
