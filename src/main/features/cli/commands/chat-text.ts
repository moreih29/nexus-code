/** How chat commands put a Claude or Codex tab into words, this computer's or another's. */
import type { CliChatChoices, CliChatInfo } from "../../../../shared/cli/ui";
import { CHAT_MODES } from "../../../../shared/sessions/chat-modes";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { clockAt, oneLine } from "../format";

export const AGENT_NAMES: Readonly<Record<ChatAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
};

/** How a tab stands, in a sentence. */
export function chatStateText(
  tab: { readonly title: string },
  info: Pick<CliChatInfo, "agent" | "state" | "message" | "failure" | "limitResume">,
  now: number = Date.now(),
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
    case "error": {
      const stopped = `${who} stopped on an error${said ? `: ${said}` : "."}`;
      const next = failureText(info, now);
      return next ? `${stopped}\n${next}` : stopped;
    }
    case "idle":
      return info.message ? `${who} finished:\n${info.message}` : `${who} is idle.`;
  }
}

/** What a turn that failed on the API needs, and what the app does about it, in a line. */
export function failureText(
  info: Pick<CliChatInfo, "failure" | "limitResume">,
  now: number = Date.now(),
): string | undefined {
  const resume = info.limitResume;
  if (resume || info.failure === "usage_limit") {
    const limit = "It stopped at its plan's usage limit";
    const resets =
      resume?.resetsAt !== undefined ? `, which resets at ${clockAt(resume.resetsAt, now)}` : "";
    switch (resume?.state) {
      case "waiting":
        return resume.at !== undefined
          ? `${limit}. The app sends it a message to go on at ${clockAt(resume.at, now)}, once the limit resets; a message sent to it before then goes on instead.`
          : `${limit}. The app sends it a message to go on once the limit resets.`;
      case "unknown":
        return `${limit}, and when the limit resets is not known: nothing goes on by itself. Send it a message once the limit resets.`;
      case "cancelled":
        return `${limit}${resets}. Going on by itself was cancelled: send it a message once the limit resets.`;
      case "gave_up":
        return `${limit}${resets}; it was still reached after ${resume.tries ?? 0} tries, and the app no longer goes on by itself. Send it a message once the limit resets.`;
      default:
        return `${limit}. Send it a message once the limit resets.`;
    }
  }
  switch (info.failure) {
    case "transient":
      return "A temporary API error (a rate limit, an overloaded or failing server, a dropped connection) outlasted its program's own retries; a message to go on may work now.";
    case "auth":
      return "Its sign-in or API key was refused: sign in again or fix the key in its profile, then send again.";
    case "request":
      return "The API refused the request itself: sending the same again fails the same way. Shorten the conversation (/compact) or change the request.";
    default:
      return undefined;
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
