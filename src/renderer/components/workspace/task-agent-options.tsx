import i18next from "i18next";
import { SquareTerminal } from "lucide-react";
import { TASK_AGENTS, type TaskAgent } from "../../../shared/sessions/task-agent";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import type { SegmentedOption } from "../settings/segmented-control";

const ICONS = { claude: ClaudeIcon, codex: CodexIcon, terminal: SquareTerminal } as const;

export function taskAgentOptions(): SegmentedOption<TaskAgent>[] {
  return TASK_AGENTS.map((value) => {
    const Icon = ICONS[value];
    return {
      value,
      label: i18next.t(`common:task.agents.${value}`),
      icon: <Icon aria-hidden className="size-3.5 shrink-0" />,
    };
  });
}
