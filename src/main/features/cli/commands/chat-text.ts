/** How chat commands put a Claude or Codex tab into words, this computer's or another's. */
import type { CliChatChoices, CliChatInfo } from "../../../../shared/cli/ui";
import { CHAT_MODES } from "../../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { oneLine } from "../format";

export const AGENT_NAMES: Readonly<Record<ChatAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
};

/** How a tab stands, in a sentence. */
export function chatStateText(
  tab: { readonly title: string },
  info: Pick<CliChatInfo, "agent" | "state" | "message">,
): string {
  const who = `${AGENT_NAMES[info.agent]} in ${tab.title}`;
  const said = info.message ? oneLine(info.message, 500) : "";
  switch (info.state) {
    case "working":
      return `${who} is working.`;
    case "asking":
      return said
        ? `${who} is waiting for the user: it ${said}.`
        : `${who} is waiting for the user.`;
    case "error":
      return `${who} stopped on an error${said ? `: ${said}` : "."}`;
    case "idle":
      return info.message ? `${who} finished:\n${info.message}` : `${who} is idle.`;
  }
}

/** What a tab runs with, and what it takes, as chat set prints it. */
export function choicesText(tab: { readonly title: string }, choices: CliChatChoices): string {
  const lines = [
    `${AGENT_NAMES[choices.agent]} in ${tab.title}:`,
    `  model   ${choices.model ?? "(its default)"}`,
    `  effort  ${choices.effort ?? "(the model's default)"}`,
    `  mode    ${choices.mode}`,
  ];
  if (choices.models.length > 0) {
    const width = Math.max(...choices.models.map((m) => m.value.length));
    // A model's name, when it says more than its value.
    const named = (m: { value: string; name: string }) =>
      m.name.toLowerCase() === m.value.toLowerCase()
        ? m.value
        : `${m.value.padEnd(width)}  ${m.name}`;
    lines.push("models:", ...choices.models.map((m) => `  ${named(m)}`));
  }
  lines.push(
    `efforts of its model: ${choices.efforts.length > 0 ? choices.efforts.join(", ") : "none"}`,
  );
  const set = CHAT_MODES[choices.agent];
  lines.push(`modes: ${set.modes.filter((m) => m !== set.dangerous).join(", ")}`);
  return lines.join("\n");
}
