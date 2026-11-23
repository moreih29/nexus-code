import { Info } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { type EndedAgent, resumeLine } from "@/services/agent-view/ended";
import { canResumeInTerminal, resumeInTerminal } from "@/services/agent-view/resume-terminal";
import { getTerminalController } from "@/services/terminal/terminal-registry";
import type { TerminalInputCheckpoint } from "@/services/terminal/types";
import { createLogger } from "../../../shared/log/renderer";
import { bannerEventId, useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { BannerDismissButton } from "../ui/banner";
import { Button } from "../ui/button";

const log = createLogger("agent-view");
const AGENT_NAMES = { claude: "Claude", codex: "Codex" } as const;

export function EndedBar({
  ended,
  terminal,
  checkpoint,
}: {
  ended: EndedAgent;
  terminal: { workspaceId: string; tabId: string };
  checkpoint?: TerminalInputCheckpoint;
}) {
  const { t } = useTranslation();
  const { tabId } = terminal;
  const line = resumeLine(ended);
  const agent = ended.agent ? AGENT_NAMES[ended.agent] : t("agentView.ended.agent");
  const subscribe = useCallback(
    (notify: () => void) => getTerminalController(tabId)?.onInput(notify) ?? (() => {}),
    [tabId],
  );
  const available = () => canResumeInTerminal(tabId, checkpoint);
  const canResume = useSyncExternalStore(subscribe, available, available);
  const notice = useBannerDismissal(
    ["terminal-agent-ended", terminal.workspaceId, tabId],
    [bannerEventId(ended)],
  );
  if (notice.dismissed) return null;

  const resume = (): void => {
    if (!line) return;
    resumeInTerminal(terminal, line, checkpoint).catch((error: unknown) => {
      log.warn(`resume failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  return (
    <div
      role="status"
      className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted px-3 py-1.5 app-status-banner-text"
      data-testid="agent-ended-bar"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Info aria-hidden className="size-3.5 shrink-0 text-[var(--state-info-fg)]" />
        <span className="truncate">{t("agentView.ended.message", { agent })}</span>
      </span>
      {line &&
        (canResume ? (
          <Button
            type="button"
            size="sm"
            className="h-6 shrink-0 px-2.5 text-app-ui-sm whitespace-nowrap"
            title={t("agentView.ended.resume_title", { line })}
            onClick={resume}
          >
            {t("agentView.ended.resume")}
          </Button>
        ) : (
          <code
            className="max-w-full select-text break-all font-mono"
            title={t("agentView.ended.resume_manual_title")}
          >
            {line}
          </code>
        ))}
      <BannerDismissButton dismiss={notice.dismiss} className="ml-auto" />
    </div>
  );
}
