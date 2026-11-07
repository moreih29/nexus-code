// The bar under a panel's terminal whose agent ended: it says so, and takes
// the conversation up again in the terminal, where the eye is after the
// agent quits and where a conversation tab is written in.

import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type EndedAgent, resumeLine } from "@/services/agent-view/ended";
import { parseSessionKey } from "@/services/agent-view/layout";
import { sendLine } from "@/services/sessions/actions";
import { requestTabFocus } from "@/services/tab-focus";
import { createLogger } from "../../../shared/log/renderer";
import { Button } from "../ui/button";

const log = createLogger("agent-view");

const AGENT_NAMES = { claude: "Claude", codex: "Codex" } as const;

export function EndedBar({ sessionKey, ended }: { sessionKey: string; ended: EndedAgent }) {
  const { t } = useTranslation();
  const line = resumeLine(ended);
  const agent = ended.agent ? AGENT_NAMES[ended.agent] : t("agentView.ended.agent");
  const resume = (): void => {
    const at = parseSessionKey(sessionKey);
    if (!at || !line) return;
    requestTabFocus(at.tabId);
    sendLine({ ...at, kind: "terminal" }, line).catch((error: unknown) => {
      log.warn(`resume failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  return (
    <div
      role="status"
      className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted px-3 text-app-ui-sm app-status-banner-text"
      data-testid="agent-ended-bar"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Info aria-hidden className="size-3.5 shrink-0 text-[var(--state-info-fg)]" />
        <span className="truncate">{t("agentView.ended.message", { agent })}</span>
      </span>
      {line && (
        <Button
          type="button"
          size="sm"
          className="h-6 px-2.5 text-app-ui-sm"
          title={t("agentView.ended.resume_title", { line })}
          onClick={resume}
        >
          {t("agentView.ended.resume")}
        </Button>
      )}
    </div>
  );
}
